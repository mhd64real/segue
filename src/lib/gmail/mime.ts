import { GmailError, type EmailAddress, type GmailMessage, type GmailMessageSummary } from "@/lib/gmail/port";

// Parses Gmail API message resources (users.messages.get and users.threads.get) into port
// data. No dependencies beyond Node's Buffer and TextDecoder. Every scan is linear, so a
// hostile message cannot stall the pipeline.

export interface ApiHeader {
  name?: string | null;
  value?: string | null;
}

export interface ApiMessagePartBody {
  attachmentId?: string | null;
  data?: string | null;
  size?: number | null;
}

export interface ApiMessagePart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: ApiHeader[];
  body?: ApiMessagePartBody;
  parts?: ApiMessagePart[];
}

// The subset of gmail_v1.Schema$Message this module reads.
export interface ApiMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  historyId?: string | null;
  internalDate?: string | null;
  sizeEstimate?: number | null;
  raw?: string | null;
  payload?: ApiMessagePart;
}

// Control characters other than tab and line feed. Postgres text cannot hold NUL, and none
// of them belong in names, subjects or bodies.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "");
}

// RFC 5322 unfolding: a line break followed by a space or tab is removed. Any stray line
// break left over becomes a space.
export function unfoldHeader(value: string): string {
  return value.replace(/\r?\n([ \t])/g, "$1").replace(/[\r\n]+/g, " ");
}

// First header with this name (case-insensitive), unfolded. null when absent.
export function getHeader(headers: readonly ApiHeader[] | null | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of headers ?? []) {
    if (typeof header.name === "string" && header.name.trim().toLowerCase() === wanted) {
      return unfoldHeader(header.value ?? "");
    }
  }
  return null;
}

export function decodeBase64Url(data: string | null | undefined): Buffer {
  if (!data) {
    return Buffer.alloc(0);
  }
  // Node's base64url decoder also accepts the standard alphabet, padding and whitespace.
  return Buffer.from(data, "base64url");
}

// Charsets

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8_FATAL.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// Decodes bytes in a MIME charset (UTF-8, ISO-8859-1 and anything else TextDecoder knows).
// A missing charset or US-ASCII is read as UTF-8 when the bytes are valid UTF-8 (common in
// mislabeled mail) and as Windows-1252 otherwise. An unknown label falls back to the same guess.
export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = (charset ?? "").trim().replace(/^"|"$/g, "").toLowerCase();
  const guess = () => new TextDecoder(isValidUtf8(bytes) ? "utf-8" : "windows-1252").decode(bytes);
  if (!label || label === "us-ascii" || label === "ascii" || label === "ansi_x3.4-1968") {
    return guess();
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return guess();
  }
}

// Content-Type and Content-Disposition

export interface ContentType {
  type: string;
  params: Record<string, string>;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

// Splits on a separator that is not inside a quoted string.
function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quoted && char === "\\" && i + 1 < value.length) {
      current += char + value[i + 1];
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    }
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function percentDecode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function parseContentType(value: string | null | undefined): ContentType {
  if (!value) {
    return { type: "", params: {} };
  }
  const [rawType, ...rawParams] = splitOutsideQuotes(unfoldHeader(value), ";");
  // No prototype, so a parameter named like an Object method is just a parameter.
  const params: Record<string, string> = Object.create(null);
  for (const rawParam of rawParams) {
    const index = rawParam.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = rawParam.slice(0, index).trim().toLowerCase();
    const paramValue = unquote(rawParam.slice(index + 1));
    if (name.endsWith("*")) {
      // RFC 2231 extended value: charset'language'percent-encoded text.
      const match = /^([^']*)'[^']*'(.*)$/.exec(paramValue);
      params[name.slice(0, -1)] = match ? decodeBytes(percentDecode(match[2]), match[1] || "utf-8") : paramValue;
      continue;
    }
    params[name] = paramValue;
  }
  return { type: rawType.trim().toLowerCase(), params };
}

// RFC 2047 encoded words

// For example =?UTF-8?B?...?= and =?ISO-8859-1?Q?...?=.
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

function encodedWordBytes(encoding: string, text: string): Buffer | null {
  if (encoding.toUpperCase() === "B") {
    return /^[A-Za-z0-9+/]*={0,2}$/.test(text) ? Buffer.from(text, "base64") : null;
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "_") {
      bytes.push(0x20);
    } else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

type WordToken = { kind: "text"; text: string } | { kind: "word"; charset: string; bytes: Buffer };

// Decodes encoded words and leaves other text as it is. Whitespace between two encoded
// words is dropped, and adjacent words in one charset are decoded together, so a
// character split across two words survives.
export function decodeEncodedWords(value: string): string {
  const tokens: WordToken[] = [];
  let last = 0;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: "text", text: value.slice(last, index) });
    }
    const bytes = encodedWordBytes(match[2], match[3]);
    // An RFC 2231 language suffix (UTF-8*en) is not part of the charset.
    const charset = match[1].split("*")[0];
    tokens.push(bytes ? { kind: "word", charset: charset.toLowerCase(), bytes } : { kind: "text", text: match[0] });
    last = index + match[0].length;
  }
  if (last < value.length) {
    tokens.push({ kind: "text", text: value.slice(last) });
  }

  let output = "";
  let run: { charset: string; bytes: Buffer[] } | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "text") {
      if (run && /^[ \t\r\n]*$/.test(token.text) && tokens[i + 1]?.kind === "word") {
        continue;
      }
      if (run) {
        output += decodeBytes(Buffer.concat(run.bytes), run.charset);
        run = null;
      }
      output += token.text;
      continue;
    }
    if (run && run.charset === token.charset) {
      run.bytes.push(token.bytes);
      continue;
    }
    if (run) {
      output += decodeBytes(Buffer.concat(run.bytes), run.charset);
    }
    run = { charset: token.charset, bytes: [token.bytes] };
  }
  if (run) {
    output += decodeBytes(Buffer.concat(run.bytes), run.charset);
  }
  return output;
}

function cleanText(value: string): string {
  return stripControlChars(value).replace(/\s+/g, " ").trim();
}

// A header shown as text (the subject): unfolded, encoded words decoded, whitespace collapsed.
export function decodeHeaderText(value: string | null | undefined): string {
  return value ? cleanText(decodeEncodedWords(unfoldHeader(value))) : "";
}

// Address lists

// Splits a header into mailbox strings at commas outside quotes, comments and angle
// brackets. Group syntax ("Team: a@x.example, b@y.example;") yields its members.
function splitMailboxes(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let commentDepth = 0;
  let angle = false;
  let hasAt = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((quoted || commentDepth > 0) && char === "\\" && i + 1 < value.length) {
      current += char + value[i + 1];
      i += 1;
      continue;
    }
    if (quoted) {
      current += char;
      quoted = char !== '"';
      continue;
    }
    if (commentDepth > 0) {
      current += char;
      commentDepth += char === "(" ? 1 : char === ")" ? -1 : 0;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "(") {
      commentDepth = 1;
    } else if (char === "<") {
      angle = true;
    } else if (char === ">") {
      angle = false;
    } else if ((char === "," || char === ";") && !angle) {
      parts.push(current);
      current = "";
      hasAt = false;
      continue;
    } else if (char === ":" && !angle && !hasAt) {
      // A group name. Its members follow.
      current = "";
      continue;
    } else if (char === "@") {
      hasAt = true;
    }
    current += char;
  }
  parts.push(current);

  // A part with no address followed by a part with an angle address is a display name that
  // held an unquoted comma, for example Doe, John <john@x.example>.
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    const open = part.indexOf("<");
    const angleHasAddress = open !== -1 && part.indexOf("@", open) !== -1;
    if (previous !== undefined && previous.trim() && !previous.includes("@") && angleHasAddress) {
      merged[merged.length - 1] = `${previous},${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.map((part) => part.trim()).filter(Boolean);
}

// Removes comments and returns their text separately. Quoted strings stay as they are.
function takeComments(value: string): { text: string; comments: string[] } {
  let text = "";
  const comments: string[] = [];
  let comment = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length && (quoted || depth > 0)) {
      if (depth > 0) {
        comment += value[i + 1];
      } else {
        text += char + value[i + 1];
      }
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (char === ")" && depth === 1) {
        depth = 0;
        comments.push(comment);
        comment = "";
        text += " ";
        continue;
      }
      depth += char === "(" ? 1 : char === ")" ? -1 : 0;
      comment += char;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "(" && !quoted) {
      depth = 1;
      continue;
    }
    text += char;
  }
  return { text, comments };
}

// Decodes a display name: quoted parts are unescaped and encoded words are decoded, also
// inside quotes (not allowed by RFC 2047, but common).
function decodeDisplayName(value: string): string | null {
  let output = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === '"') {
      let quoted = "";
      i += 1;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 1;
        }
        quoted += value[i];
        i += 1;
      }
      i += 1;
      output += decodeEncodedWords(quoted);
    } else {
      const next = value.indexOf('"', i);
      const end = next === -1 ? value.length : next;
      output += decodeEncodedWords(value.slice(i, end));
      i = end;
    }
  }
  const name = cleanText(output);
  return name ? name : null;
}

const LOOSE_EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

function cleanEmail(value: string): string | null {
  const email = stripControlChars(value)
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/\s+/g, "");
  return LOOSE_EMAIL.test(email) ? email : null;
}

// One mailbox: "Name <address>", "<address>", "address" or "address (Name)".
export function parseAddress(value: string): EmailAddress | null {
  const { text, comments } = takeComments(value);
  const open = text.lastIndexOf("<");
  const close = open === -1 ? -1 : text.indexOf(">", open);
  if (open !== -1 && close !== -1) {
    const email = cleanEmail(text.slice(open + 1, close));
    if (!email) {
      return null;
    }
    return { name: decodeDisplayName(text.slice(0, open)) ?? decodeDisplayName(comments.join(" ")), email };
  }
  const email = cleanEmail(text);
  return email ? { name: decodeDisplayName(comments.join(" ")), email } : null;
}

// Every mailbox in an address header. Entries without a usable address are skipped.
export function parseAddressList(value: string | null | undefined): EmailAddress[] {
  if (!value) {
    return [];
  }
  const addresses: EmailAddress[] = [];
  for (const part of splitMailboxes(unfoldHeader(value))) {
    const address = parseAddress(part);
    if (address) {
      addresses.push(address);
    }
  }
  return addresses;
}

// Message ids

const MESSAGE_ID_MAX_LENGTH = 256;

export function isValidMessageId(value: string): boolean {
  return (
    value.length >= 5 &&
    value.length <= MESSAGE_ID_MAX_LENGTH &&
    /^<[\x21-\x3B\x3D\x3F-\x7E]+>$/.test(value)
  );
}

// Message ids in a Message-ID, In-Reply-To or References value, with angle brackets and
// deduplicated in order. A bare id without brackets (some mailers send them) is accepted
// when it is a single token with an @.
export function extractMessageIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const text = unfoldHeader(value);
  const found: string[] = [];
  for (const match of text.matchAll(/<([^<>\s]*)>/g)) {
    found.push(`<${match[1]}>`);
  }
  if (found.length === 0) {
    const bare = text.trim();
    if (/^[^\s<>@]+@[^\s<>@]+$/.test(bare)) {
      found.push(`<${bare}>`);
    }
  }
  return [...new Set(found.filter(isValidMessageId))];
}

// Text limits

// Longest decoded text/plain or text/html part read. The rest of a longer part is dropped.
export const MAX_PLAIN_TEXT_LENGTH = 2_000_000;
export const MAX_HTML_LENGTH = 2_000_000;

// At most `max` UTF-16 code units, never ending in half of a surrogate pair.
function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

// HTML to text

const NAMED_ENTITIES: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160, ensp: 8194, emsp: 8195, thinsp: 8201,
  shy: 0, zwnj: 0, zwj: 0, lrm: 0, rlm: 0,
  copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211, minus: 8722,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  laquo: 171, raquo: 187, lsaquo: 8249, rsaquo: 8250, bull: 8226, middot: 183, dagger: 8224,
  euro: 8364, pound: 163, yen: 165, cent: 162, curren: 164, deg: 176, times: 215, divide: 247,
  plusmn: 177, frac12: 189, frac14: 188, frac34: 190, sup1: 185, sup2: 178, sup3: 179,
  micro: 181, para: 182, sect: 167, iexcl: 161, iquest: 191, ordf: 170, ordm: 186, not: 172,
  macr: 175, acute: 180, cedil: 184, uml: 168, brvbar: 166, rarr: 8594, larr: 8592,
  harr: 8596, uarr: 8593, darr: 8595, check: 10003, permil: 8240, prime: 8242,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198,
  Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205,
  Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212,
  Otilde: 213, Ouml: 214, Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220,
  Yacute: 221, THORN: 222, szlig: 223, agrave: 224, aacute: 225, acirc: 226, atilde: 227,
  auml: 228, aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233, ecirc: 234,
  euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240, ntilde: 241,
  ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, oslash: 248, ugrave: 249,
  uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255, OElig: 338,
  oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
};

// HTML reads numeric references 128 to 159 as Windows-1252 characters.
const WINDOWS_1252_C1: Record<number, number> = {
  128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225, 136: 710,
  137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217, 147: 8220,
  148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732, 153: 8482, 154: 353, 155: 8250,
  156: 339, 158: 382, 159: 376,
};

function codePointText(codePoint: number): string {
  const mapped = WINDOWS_1252_C1[codePoint] ?? codePoint;
  if (mapped === 0 || mapped > 0x10ffff || (mapped >= 0xd800 && mapped <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(mapped);
}

// Decodes named (common set) and numeric character references in one pass, so "&amp;lt;"
// becomes "&lt;" and never "<". Unknown names stay as written.
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g,
    (match: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) {
        return codePointText(parseInt(dec, 10));
      }
      if (hex !== undefined) {
        return codePointText(parseInt(hex, 16));
      }
      // Own keys only, so "&constructor;" stays text.
      const known = name !== undefined && match.endsWith(";") && Object.hasOwn(NAMED_ENTITIES, name);
      const codePoint = known ? NAMED_ENTITIES[name] : undefined;
      if (codePoint === undefined) {
        return match;
      }
      return codePoint === 0 ? "" : String.fromCodePoint(codePoint);
    },
  );
}

// Elements whose content is never shown as text.
const SKIPPED_CONTENT = new Set(["script", "style", "title", "template", "noscript", "svg", "object", "iframe", "xml"]);
const PARAGRAPH_ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "ul", "ol", "dl", "hr", "address", "figure",
]);
const BLOCK_ELEMENTS = new Set([
  "div", "section", "article", "header", "footer", "nav", "main", "aside", "tr", "dt", "dd", "caption",
  "center", "form", "fieldset", "legend", "figcaption", "details", "summary", "tbody", "thead", "tfoot", "body",
]);

// Private use characters mark structure while whitespace is collapsed. Any in the input are
// removed. A block boundary ends the current line; boundaries next to each other count once.
// A break (<br>, or a newline in <pre>) always ends a line, even an empty one. A paragraph
// boundary leaves one blank line.
const BLOCK_MARK = "\uE000";
const PARAGRAPH_MARK = "\uE001";
const PRE_SPACE = "\uE002";
const BREAK_MARK = "\uE003";
const MARKS = /[\uE000-\uE003]/g;
const MARK_SPLIT = /([\uE000\uE001\uE003])/;

// Index of the ">" that ends a tag starting at `from`, or -1. Quotes count only as
// attribute values (after "="), where a ">" does not end the tag.
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  let afterEquals = false;
  for (let i = from; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === ">") {
      return i;
    }
    if ((char === '"' || char === "'") && afterEquals) {
      quote = char;
      afterEquals = false;
      continue;
    }
    if (char === "=") {
      afterEquals = true;
    } else if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      afterEquals = false;
    }
  }
  return -1;
}

// Plain text from an HTML body. Scripts, styles and other non-content elements are dropped,
// block elements and <br> become line breaks, list items get "- ", entities are decoded,
// and whitespace collapses the way a browser renders it. <pre> keeps its spacing.
export function htmlToText(input: string): string {
  const html = truncateText(input, MAX_HTML_LENGTH).replace(MARKS, "");
  const out: string[] = [];
  let preDepth = 0;
  let i = 0;

  const emitText = (raw: string) => {
    const text = decodeHtmlEntities(raw);
    if (preDepth > 0) {
      out.push(text.replace(/\r\n?|\n/g, BREAK_MARK).replace(/[ \t\u00A0]/g, PRE_SPACE));
    } else {
      out.push(text.replace(/[\s\u00A0]+/g, " "));
    }
  };

  while (i < html.length) {
    const open = html.indexOf("<", i);
    const textEnd = open === -1 ? html.length : open;
    if (textEnd > i) {
      emitText(html.slice(i, textEnd));
    }
    if (open === -1) {
      break;
    }
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (!/[A-Za-z/!?]/.test(html[open + 1] ?? "")) {
      emitText("<");
      i = open + 1;
      continue;
    }
    const end = findTagEnd(html, open + 1);
    if (end === -1) {
      // A tag cut off by the end of the input is dropped, as browsers do.
      break;
    }
    const tag = html.slice(open + 1, end);
    i = end + 1;
    const match = /^(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
    if (!match) {
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (!closing && SKIPPED_CONTENT.has(name) && !tag.trimEnd().endsWith("/")) {
      const closer = new RegExp(`</${name}\\b`, "gi");
      closer.lastIndex = i;
      const found = closer.exec(html);
      if (!found) {
        break;
      }
      const closerEnd = html.indexOf(">", found.index);
      i = closerEnd === -1 ? html.length : closerEnd + 1;
      continue;
    }
    if (name === "br") {
      out.push(BREAK_MARK);
    } else if (name === "li") {
      if (!closing) {
        out.push(`${BLOCK_MARK}- `);
      }
    } else if (name === "pre") {
      preDepth = closing ? Math.max(0, preDepth - 1) : preDepth + 1;
      out.push(PARAGRAPH_MARK);
    } else if (PARAGRAPH_ELEMENTS.has(name)) {
      out.push(PARAGRAPH_MARK);
    } else if (BLOCK_ELEMENTS.has(name)) {
      out.push(BLOCK_MARK);
    } else if (closing && (name === "td" || name === "th")) {
      out.push(" ");
    }
  }

  const lines: string[] = [];
  let current = "";
  const endLine = (keepEmpty: boolean) => {
    const line = stripControlChars(current).replace(/[ \t]+/g, " ").trim().replaceAll(PRE_SPACE, " ").trimEnd();
    if (line || keepEmpty) {
      lines.push(line);
    }
    current = "";
  };
  for (const piece of out.join("").split(MARK_SPLIT)) {
    if (piece === BREAK_MARK) {
      endLine(true);
    } else if (piece === BLOCK_MARK) {
      endLine(false);
    } else if (piece === PARAGRAPH_MARK) {
      endLine(false);
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
    } else {
      current += piece;
    }
  }
  endLine(false);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Unix line endings, no control characters, no trailing spaces or tabs on a line, no blank
// lines at the start or end. Index scans instead of /[ \t]+$/ and /\n+$/, which backtrack
// quadratically on a long whitespace run followed by other text.
export function normalizePlainText(input: string): string {
  const lines = stripControlChars(truncateText(input, MAX_PLAIN_TEXT_LENGTH).replace(/\r\n?/g, "\n")).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) {
      end -= 1;
    }
    lines[i] = line.slice(0, end);
  }
  const text = lines.join("\n");
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x0a) {
    start += 1;
  }
  while (end > start && text.charCodeAt(end - 1) === 0x0a) {
    end -= 1;
  }
  return text.slice(start, end);
}

// Body

type Segment = { kind: "plain" | "html"; text: string };

function isAttachment(part: ApiMessagePart): boolean {
  const disposition = parseContentType(getHeader(part.headers, "Content-Disposition")).type;
  if (disposition === "attachment") {
    return true;
  }
  return Boolean(part.filename) && disposition !== "inline";
}

function partType(part: ApiMessagePart): string {
  return (part.mimeType || parseContentType(getHeader(part.headers, "Content-Type")).type || "text/plain").toLowerCase();
}

function decodePartBody(part: ApiMessagePart): string {
  const { params } = parseContentType(getHeader(part.headers, "Content-Type"));
  return decodeBytes(decodeBase64Url(part.body?.data), params.charset);
}

const MAX_PART_DEPTH = 32;

function segmentsOf(part: ApiMessagePart, depth: number): Segment[] {
  if (depth > MAX_PART_DEPTH || isAttachment(part)) {
    return [];
  }
  const type = partType(part);
  if (type.startsWith("multipart/")) {
    const children = (part.parts ?? [])
      .map((child) => segmentsOf(child, depth + 1))
      .filter((segments) => segments.length > 0);
    if (type === "multipart/alternative") {
      return (
        children.find((segments) => segments.every((segment) => segment.kind === "plain")) ??
        children.find((segments) => segments.some((segment) => segment.kind === "plain")) ??
        children[children.length - 1] ??
        []
      );
    }
    return children.flat();
  }
  if (type !== "text/plain" && type !== "text/html") {
    return [];
  }
  const text = decodePartBody(part);
  return text.trim() ? [{ kind: type === "text/plain" ? "plain" : "html", text }] : [];
}

// The readable text of a message: text/plain preferred, HTML converted when a message or an
// alternative has no usable plain text, attachments skipped.
export function extractBodyText(payload: ApiMessagePart | null | undefined): string {
  if (!payload) {
    return "";
  }
  return segmentsOf(payload, 0)
    .map((segment) => (segment.kind === "plain" ? normalizePlainText(segment.text) : htmlToText(segment.text)))
    .filter(Boolean)
    .join("\n\n");
}

// Messages

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseMessageSummary(message: ApiMessage): GmailMessageSummary {
  if (!message.id || !message.threadId) {
    throw new GmailError("invalid_response");
  }
  const headers = message.payload?.headers ?? [];
  const date = parseDate(getHeader(headers, "Date"));
  const internalMs = message.internalDate ? Number(message.internalDate) : NaN;
  const internalDate = Number.isFinite(internalMs) ? new Date(internalMs) : date;
  if (!internalDate) {
    throw new GmailError("invalid_response");
  }
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: [...(message.labelIds ?? [])],
    internalDate,
    from: parseAddressList(getHeader(headers, "From"))[0] ?? null,
    to: parseAddressList(getHeader(headers, "To")),
    cc: parseAddressList(getHeader(headers, "Cc")),
    replyTo: parseAddressList(getHeader(headers, "Reply-To")),
    subject: decodeHeaderText(getHeader(headers, "Subject")),
    messageId: extractMessageIds(getHeader(headers, "Message-ID"))[0] ?? null,
    inReplyTo: extractMessageIds(getHeader(headers, "In-Reply-To"))[0] ?? null,
    references: extractMessageIds(getHeader(headers, "References")),
    date,
  };
}

export function parseGmailMessage(message: ApiMessage): GmailMessage {
  return { ...parseMessageSummary(message), bodyText: extractBodyText(message.payload) };
}
