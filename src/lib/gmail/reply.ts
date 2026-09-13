import { isValidMessageId } from "@/lib/gmail/mime";
import { GmailError } from "@/lib/gmail/port";

// Builds the RFC 2822 reply that users.messages.send takes as `raw`. Every header value is
// either validated (addresses, message ids) or reduced to one line of text (the subject),
// so nothing in a draft or in the original email can add a header.

export interface ReplyMessageInput {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  bodyText: string;
  inReplyTo: string | null;
  references: readonly string[];
}

const CRLF = "\r\n";
// Soft limit from RFC 5322 section 2.1.1. Folded lines stay within it where possible.
const LINE_LIMIT = 78;
// Hard limit (998 characters plus CRLF).
const HARD_LINE_LIMIT = 998;
// RFC 2047 lines with encoded words stay within 76 characters.
const ENCODED_LINE_LIMIT = 76;
const BODY_LINE_LENGTH = 76;
export const MAX_REFERENCES = 20;
const EMAIL_MAX_LENGTH = 254;
const LOCAL_PART_MAX_LENGTH = 64;

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const EMAIL = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

// A bare ASCII address (dot-atom local part, hostname domain). Anything else, including a
// display name, a quoted local part, a comma or a line break, is refused.
export function isValidEmailAddress(value: string): boolean {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH || !EMAIL.test(value)) {
    return false;
  }
  return value.indexOf("@") <= LOCAL_PART_MAX_LENGTH;
}

// "Re: " plus the subject, unless it already starts with a Re: prefix (any case, also
// "RE :" and "Re[2]:"). Control characters and line breaks become spaces.
export function replySubject(original: string): string {
  const subject = String(original ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^re\s*(\[\d+\])?\s*:/i.test(subject)) {
    return subject;
  }
  return subject ? `Re: ${subject}` : "Re:";
}

// Validates and deduplicates recipients (case-insensitive). An address already in To is
// dropped from Cc. Throws GmailError "invalid_recipient" for any invalid entry and when To
// ends up empty.
export function normalizeRecipients(to: readonly string[], cc: readonly string[]): { to: string[]; cc: string[] } {
  const seen = new Set<string>();
  const clean = (list: readonly string[]) => {
    const out: string[] = [];
    for (const entry of list) {
      const address = typeof entry === "string" ? entry.trim() : "";
      if (!isValidEmailAddress(address)) {
        throw new GmailError("invalid_recipient", { sendOutcome: "not_sent" });
      }
      const key = address.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(address);
      }
    }
    return out;
  };
  const cleanTo = clean(to);
  const cleanCc = clean(cc);
  if (cleanTo.length === 0) {
    throw new GmailError("invalid_recipient", { sendOutcome: "not_sent" });
  }
  return { to: cleanTo, cc: cleanCc };
}

// The replied message's References plus its Message-ID, valid ids only, each once. Past
// MAX_REFERENCES it keeps the first id (the thread root) and the most recent ones.
export function buildReferences(references: readonly string[], inReplyTo: string | null): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const candidates = [...references, ...(inReplyTo ? [inReplyTo] : [])];
  for (const candidate of candidates) {
    const id = typeof candidate === "string" ? candidate.trim() : "";
    if (isValidMessageId(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length <= MAX_REFERENCES) {
    return ids;
  }
  return [ids[0], ...ids.slice(ids.length - (MAX_REFERENCES - 1))];
}

// Folds a structured header at the given separators. Each token stays whole.
function foldTokens(name: string, tokens: readonly string[], separator: "," | ""): string {
  const lines: string[] = [];
  let line = `${name}:`;
  tokens.forEach((token, index) => {
    const joiner = index === 0 ? " " : `${separator} `;
    if (index > 0 && line.length + joiner.length + token.length > LINE_LIMIT) {
      lines.push(`${line}${separator}`);
      line = ` ${token}`;
    } else {
      line += `${joiner}${token}`;
    }
  });
  lines.push(line);
  return lines.join(CRLF);
}

const ENCODED_PREFIX = "=?UTF-8?B?";
const ENCODED_SUFFIX = "?=";

// Largest whole UTF-8 byte count whose base64 fits the space, in multiples of 3 bytes.
function bytesForSpace(space: number): number {
  const base64Chars = Math.floor((space - ENCODED_PREFIX.length - ENCODED_SUFFIX.length) / 4) * 4;
  return (base64Chars / 4) * 3;
}

// RFC 2047 "B" encoded words, split between whole characters, one word per folded line.
export function encodeHeaderWords(name: string, value: string): string {
  const firstBytes = bytesForSpace(ENCODED_LINE_LIMIT - name.length - 2);
  const nextBytes = bytesForSpace(ENCODED_LINE_LIMIT - 1);
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    const limit = words.length === 0 ? firstBytes : nextBytes;
    if (chunkBytes + size > limit && chunk) {
      words.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk || words.length === 0) {
    words.push(chunk);
  }
  const encoded = words.map((word) => `${ENCODED_PREFIX}${Buffer.from(word, "utf8").toString("base64")}${ENCODED_SUFFIX}`);
  return `${name}: ${encoded.join(`${CRLF} `)}`;
}

// Subject header: printable ASCII is folded at spaces; non-ASCII text, text that looks like
// an encoded word, or a word too long for one line is sent as encoded words.
export function subjectHeader(subject: string): string {
  const words = subject.split(" ").filter(Boolean);
  const printable = /^[\x20-\x7E]*$/.test(subject) && !subject.includes("=?");
  const fitsHardLimit = words.every((word) => word.length + "Subject: ".length <= HARD_LINE_LIMIT);
  if (printable && fitsHardLimit) {
    return words.length === 0 ? "Subject: " : foldTokens("Subject", words, "");
  }
  return encodeHeaderWords("Subject", subject);
}

function wrapBase64(bytes: Buffer): string[] {
  const base64 = bytes.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BODY_LINE_LENGTH) {
    lines.push(base64.slice(i, i + BODY_LINE_LENGTH));
  }
  return lines;
}

// Every header line must end in CRLF and a continuation must start with a space or tab.
function assertHeaderBlock(block: string): void {
  const lines = block.split(CRLF);
  const safe = lines.every(
    (line, index) =>
      !/[\r\n]/.test(line) &&
      /^[\x20-\x7E]*$/.test(line) &&
      line.length <= HARD_LINE_LIMIT &&
      (index === 0 || /^[ \t]/.test(line) || /^[A-Za-z0-9-]+: /.test(line)),
  );
  if (!safe) {
    throw new GmailError("invalid_reply", { sendOutcome: "not_sent" });
  }
}

// The complete message text with CRLF line endings. Gmail adds From, Date and Message-ID.
export function buildReplyMessage(input: ReplyMessageInput): string {
  if (typeof input.bodyText !== "string" || typeof input.subject !== "string") {
    throw new GmailError("invalid_reply", { sendOutcome: "not_sent" });
  }
  const { to, cc } = normalizeRecipients(input.to ?? [], input.cc ?? []);
  const inReplyTo = input.inReplyTo && isValidMessageId(input.inReplyTo.trim()) ? input.inReplyTo.trim() : null;
  const references = buildReferences(input.references ?? [], inReplyTo);

  const headers = [foldTokens("To", to, ",")];
  if (cc.length > 0) {
    headers.push(foldTokens("Cc", cc, ","));
  }
  headers.push(subjectHeader(replySubject(input.subject)));
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references.length > 0) {
    headers.push(foldTokens("References", references, ""));
  }
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");

  const headerBlock = headers.join(CRLF);
  assertHeaderBlock(headerBlock);
  const body = wrapBase64(Buffer.from(input.bodyText.replace(/\r\n|\r|\n/g, CRLF), "utf8"));
  return `${headerBlock}${CRLF}${CRLF}${body.map((line) => `${line}${CRLF}`).join("")}`;
}

export function encodeRawMessage(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}

// The base64url string for users.messages.send.
export function buildReplyRaw(input: ReplyMessageInput): string {
  return encodeRawMessage(buildReplyMessage(input));
}
