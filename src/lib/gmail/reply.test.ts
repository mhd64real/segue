import { describe, expect, it } from "vitest";
import { decodeEncodedWords } from "@/lib/gmail/mime";
import { GmailError } from "@/lib/gmail/port";
import {
  MAX_REFERENCES,
  buildReferences,
  buildReplyMessage,
  buildReplyRaw,
  encodeRawMessage,
  isValidEmailAddress,
  normalizeRecipients,
  replySubject,
  subjectHeader,
  type ReplyMessageInput,
} from "@/lib/gmail/reply";

const base: ReplyMessageInput = {
  to: ["partnerships@meshwave.example"],
  cc: [],
  subject: "Paid integration",
  bodyText: "Hi Priya,\nThanks for the offer.\n",
  inReplyTo: "<CAF7x9Q1meshwave0001@mail.gmail.com>",
  references: [],
};

function headerBlock(message: string): string {
  return message.slice(0, message.indexOf("\r\n\r\n"));
}

// Header name and unfolded value, in order.
function headers(message: string): [string, string][] {
  return headerBlock(message)
    .replace(/\r\n([ \t])/g, "$1")
    .split("\r\n")
    .map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    });
}

function headerLines(message: string): string[] {
  return headerBlock(message).split("\r\n");
}

function expectInvalid(fn: () => unknown, reason: GmailError["reason"]) {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GmailError);
  expect((error as GmailError).reason).toBe(reason);
  expect((error as GmailError).sendOutcome).toBe("not_sent");
}

describe("replySubject", () => {
  it.each([
    ["Offer", "Re: Offer"],
    ["  Offer  ", "Re: Offer"],
    ["Re: Offer", "Re: Offer"],
    ["RE: Offer", "RE: Offer"],
    ["re:Offer", "re:Offer"],
    ["Re : Offer", "Re : Offer"],
    ["Re[2]: Offer", "Re[2]: Offer"],
    ["Fwd: Offer", "Re: Fwd: Offer"],
    ["Regarding the offer", "Re: Regarding the offer"],
    ["Re Offer", "Re: Re Offer"],
    ["", "Re:"],
    ["Hello\r\nBcc: evil@attacker.example", "Re: Hello Bcc: evil@attacker.example"],
    ["Tab\tand   spaces", "Re: Tab and spaces"],
  ])("%j becomes %j", (original, expected) => {
    expect(replySubject(original)).toBe(expected);
  });
});

describe("addresses and references", () => {
  it("accepts bare ASCII addresses only", () => {
    for (const valid of ["a@b.example", "first.last+tag@sub.brand.example", "o'brien@brand.example", "x_y-z@a-b.co"]) {
      expect(isValidEmailAddress(valid)).toBe(true);
    }
    for (const invalid of [
      "",
      "plain",
      "a@localhost",
      "a@b.example\r\nBcc: evil@attacker.example",
      "a@b.example,c@d.example",
      "Name <a@b.example>",
      "<a@b.example>",
      '"quoted"@b.example',
      "a..b@brand.example",
      ".a@brand.example",
      "a@-brand.example",
      "müller@brand.example",
      `${"a".repeat(65)}@brand.example`,
      `a@${"b".repeat(250)}.example`,
    ]) {
      expect(isValidEmailAddress(invalid)).toBe(false);
    }
  });

  it("deduplicates recipients and drops Cc entries already in To", () => {
    expect(normalizeRecipients(["A@brand.example", " a@brand.example "], ["a@BRAND.example", "b@brand.example", "B@brand.example"])).toEqual({
      to: ["A@brand.example"],
      cc: ["b@brand.example"],
    });
  });

  it("appends the replied id to its references, valid ids once each", () => {
    expect(buildReferences(["<a@x.example>", "bogus", "<b@x.example>", "<a@x.example>"], "<c@x.example>")).toEqual([
      "<a@x.example>",
      "<b@x.example>",
      "<c@x.example>",
    ]);
    expect(buildReferences(["<a@x.example>"], "<a@x.example>")).toEqual(["<a@x.example>"]);
    expect(buildReferences([], null)).toEqual([]);
  });

  it("keeps the thread root and the most recent ids when there are too many", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `<id${index}@x.example>`);
    const references = buildReferences(ids, "<last@x.example>");
    expect(references).toHaveLength(MAX_REFERENCES);
    expect(references[0]).toBe("<id0@x.example>");
    expect(references.slice(1)).toEqual([...ids.slice(12), "<last@x.example>"]);
  });
});

describe("buildReplyMessage", () => {
  it("builds the exact bytes of a simple reply", () => {
    const message = buildReplyMessage(base);
    expect(message).toBe(
      "To: partnerships@meshwave.example\r\n" +
        "Subject: Re: Paid integration\r\n" +
        "In-Reply-To: <CAF7x9Q1meshwave0001@mail.gmail.com>\r\n" +
        "References: <CAF7x9Q1meshwave0001@mail.gmail.com>\r\n" +
        "MIME-Version: 1.0\r\n" +
        'Content-Type: text/plain; charset="UTF-8"\r\n' +
        "Content-Transfer-Encoding: base64\r\n" +
        "\r\n" +
        "SGkgUHJpeWEsDQpUaGFua3MgZm9yIHRoZSBvZmZlci4NCg==\r\n",
    );
    expect(buildReplyRaw(base)).toBe(Buffer.from(message, "utf8").toString("base64url"));
    expect(encodeRawMessage(message)).not.toMatch(/[+/=]/);
  });

  it("includes Cc and the original References before the replied id", () => {
    const message = buildReplyMessage({
      ...base,
      cc: ["scheduling@brightreach.example"],
      subject: "Re: Paid integration",
      references: ["<root@meshwave.example>"],
    });
    expect(headers(message)).toEqual([
      ["To", "partnerships@meshwave.example"],
      ["Cc", "scheduling@brightreach.example"],
      ["Subject", "Re: Paid integration"],
      ["In-Reply-To", "<CAF7x9Q1meshwave0001@mail.gmail.com>"],
      ["References", "<root@meshwave.example> <CAF7x9Q1meshwave0001@mail.gmail.com>"],
      ["MIME-Version", "1.0"],
      ["Content-Type", 'text/plain; charset="UTF-8"'],
      ["Content-Transfer-Encoding", "base64"],
    ]);
  });

  it("leaves out In-Reply-To and References when the original had no Message-ID", () => {
    const names = headers(buildReplyMessage({ ...base, inReplyTo: null })).map(([name]) => name);
    expect(names).toEqual(["To", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
  });

  it("encodes a non-ASCII subject as UTF-8 encoded words of whole characters", () => {
    const subject = "Colaboración pagada para tu video de cocina con hierro fundido y más detalles 🎬🎬🎬 ñ";
    const message = buildReplyMessage({ ...base, subject });
    const lines = headerLines(message);
    const start = lines.findIndex((line) => line.startsWith("Subject: "));
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith(" ")) {
      end += 1;
    }
    const subjectLines = lines.slice(start, end);
    expect(subjectLines.length).toBeGreaterThan(1);
    expect(subjectLines[0].startsWith("Subject: =?UTF-8?B?")).toBe(true);
    for (const line of subjectLines) {
      expect(line.length).toBeLessThanOrEqual(76);
      const word = line.replace(/^Subject: /, "").trim();
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/);
      // Each word decodes on its own, so no character was split.
      expect(decodeEncodedWords(word)).not.toContain("\uFFFD");
    }
    const value = new Map(headers(message)).get("Subject") ?? "";
    expect(decodeEncodedWords(value)).toBe(`Re: ${subject}`);
  });

  it("encodes a subject that looks like an encoded word or has a word too long for a line", () => {
    const tricky = "=?UTF-8?B?QmNjOiBldmls?=";
    const value = new Map(headers(buildReplyMessage({ ...base, subject: tricky }))).get("Subject") ?? "";
    expect(value).not.toContain(tricky);
    expect(decodeEncodedWords(value)).toBe(`Re: ${tricky}`);

    const long = "x".repeat(1200);
    const message = buildReplyMessage({ ...base, subject: long });
    expect(headerLines(message).every((line) => line.length <= 998)).toBe(true);
    expect(decodeEncodedWords(new Map(headers(message)).get("Subject") ?? "")).toBe(`Re: ${long}`);
  });

  it("folds a long ASCII subject at spaces", () => {
    const subject = "Sponsorship offer for your upcoming home networking video about mesh WiFi systems and routers";
    const header = subjectHeader(replySubject(subject));
    const lines = header.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 78)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
    expect(header.replace(/\r\n /g, " ")).toBe(`Subject: Re: ${subject}`);
  });

  it("folds long References and To lists between items", () => {
    const references = Array.from({ length: 12 }, (_, index) => `<message-${index}.${"a".repeat(20)}@mail.brand.example>`);
    const to = Array.from({ length: 6 }, (_, index) => `recipient.number.${index}@agency-partners.example`);
    const message = buildReplyMessage({ ...base, to, references, inReplyTo: references[11] });
    const lines = headerLines(message);
    expect(lines.every((line) => line.length <= 78)).toBe(true);
    const parsed = new Map(headers(message));
    expect(parsed.get("References")).toBe(references.join(" "));
    expect(parsed.get("To")).toBe(to.join(", "));
    expect(lines.filter((line) => line.startsWith(" ")).length).toBeGreaterThan(4);
  });

  it("encodes the body as base64 in 76 character lines with CRLF line endings", () => {
    const bodyText = `Line one\nLine two\r\nLine three\rÜnïcödé ${"long ".repeat(40)}`;
    const message = buildReplyMessage({ ...base, bodyText });
    const body = message.slice(message.indexOf("\r\n\r\n") + 4);
    const lines = body.split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(bodyText.replace(/\r\n|\r|\n/g, "\r\n"));
    expect(message).not.toMatch(/[^\r]\n/);
    expect(message).not.toMatch(/\r(?!\n)/);
  });

  it("builds an empty body", () => {
    expect(buildReplyMessage({ ...base, bodyText: "" }).endsWith("Content-Transfer-Encoding: base64\r\n\r\n")).toBe(true);
  });
});

describe("header injection", () => {
  it("refuses line breaks, commas and names in To and Cc", () => {
    expectInvalid(() => buildReplyMessage({ ...base, to: ["partner@brand.example\r\nBcc: evil@attacker.example"] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, to: ["partner@brand.example\nBcc: evil@attacker.example"] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, to: ["partner@brand.example, evil@attacker.example"] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, cc: ["ok@brand.example", "x@brand.example\r\nSubject: spoof"] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, cc: ["Evil <evil@attacker.example>"] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, to: [] }), "invalid_recipient");
    expectInvalid(() => buildReplyMessage({ ...base, to: [42 as unknown as string] }), "invalid_recipient");
  });

  it("keeps a subject with line breaks on one header", () => {
    const message = buildReplyMessage({ ...base, subject: "Offer\r\nBcc: evil@attacker.example\r\n\r\nInjected body" });
    const names = headers(message).map(([name]) => name);
    expect(names).toEqual(["To", "Subject", "In-Reply-To", "References", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    expect(new Map(headers(message)).get("Subject")).toBe("Re: Offer Bcc: evil@attacker.example Injected body");
    expect(headerBlock(message)).not.toMatch(/\r\nBcc:/i);
  });

  it("drops message ids that carry anything but an id", () => {
    const message = buildReplyMessage({
      ...base,
      inReplyTo: "<a@x.example>\r\nBcc: evil@attacker.example",
      references: ["<ok@x.example>", "<b@x.example>\r\nBcc: evil@attacker.example", "<c d@x.example>"],
    });
    expect(headers(message)).toContainEqual(["References", "<ok@x.example>"]);
    expect(headers(message).map(([name]) => name)).not.toContain("In-Reply-To");
    expect(headerBlock(message)).not.toMatch(/Bcc/i);
  });

  it("refuses a reply without a subject or body string", () => {
    expectInvalid(() => buildReplyMessage({ ...base, bodyText: undefined as unknown as string }), "invalid_reply");
    expectInvalid(() => buildReplyMessage({ ...base, subject: null as unknown as string }), "invalid_reply");
  });

  it("produces printable ASCII headers only", () => {
    const message = buildReplyMessage({ ...base, subject: "Ünïcödé\u0000\u0007 subject" });
    expect(headerLines(message).every((line) => /^[\x20-\x7E]*$/.test(line))).toBe(true);
  });
});
