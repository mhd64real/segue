import { describe, expect, it } from "vitest";
import addressCommas from "@/lib/gmail/fixtures/message-address-commas.json";
import encodedWords from "@/lib/gmail/fixtures/message-encoded-words.json";
import htmlOnly from "@/lib/gmail/fixtures/message-html-only.json";
import latin1 from "@/lib/gmail/fixtures/message-iso-8859-1.json";
import alternative from "@/lib/gmail/fixtures/message-multipart-alternative.json";
import nestedMixed from "@/lib/gmail/fixtures/message-nested-mixed.json";
import oddCasing from "@/lib/gmail/fixtures/message-odd-header-casing.json";
import singlePart from "@/lib/gmail/fixtures/message-single-part.json";
import {
  decodeBase64Url,
  decodeBytes,
  decodeEncodedWords,
  decodeHeaderText,
  decodeHtmlEntities,
  extractBodyText,
  extractMessageIds,
  getHeader,
  htmlToText,
  isValidMessageId,
  MAX_HTML_LENGTH,
  MAX_PLAIN_TEXT_LENGTH,
  normalizePlainText,
  parseAddress,
  parseAddressList,
  parseContentType,
  parseGmailMessage,
  parseMessageSummary,
  stripControlChars,
  type ApiMessage,
} from "@/lib/gmail/mime";
import { GmailError } from "@/lib/gmail/port";

const b64u = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding).toString("base64url");

describe("headers", () => {
  const headers = [
    { name: "X-Other", value: "x" },
    { name: "SUBJECT", value: "First\r\n folded" },
    { name: "Subject", value: "Second" },
    { name: null, value: "nameless" },
  ];

  it("finds the first header with the name in any case, unfolded", () => {
    expect(getHeader(headers, "subject")).toBe("First folded");
    expect(getHeader(headers, "x-other")).toBe("x");
    expect(getHeader(headers, "Missing")).toBeNull();
    expect(getHeader(undefined, "Subject")).toBeNull();
  });

  it("parses Content-Type with quoted and RFC 2231 parameters", () => {
    expect(parseContentType('text/plain; CHARSET="ISO-8859-1"; format=flowed')).toEqual({
      type: "text/plain",
      params: { charset: "ISO-8859-1", format: "flowed" },
    });
    expect(parseContentType("Multipart/Mixed; boundary=\"a;b\"").params.boundary).toBe("a;b");
    expect(parseContentType("attachment; filename*=UTF-8''caf%C3%A9.pdf").params.filename).toBe("café.pdf");
    expect(parseContentType(null)).toEqual({ type: "", params: {} });
  });

  it("strips control characters but keeps tabs and line feeds", () => {
    expect(stripControlChars(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c\td\ne${String.fromCharCode(127)}`)).toBe("abc\td\ne");
  });
});

describe("base64url and charsets", () => {
  it("decodes base64url and tolerates the standard alphabet and padding", () => {
    expect(decodeBase64Url("aGVsbG8-_w").toString("hex")).toBe("68656c6c6f3eff");
    expect(decodeBase64Url("aGVsbG8+/w==").toString("hex")).toBe("68656c6c6f3eff");
    expect(decodeBase64Url(null).length).toBe(0);
    expect(decodeBase64Url("").length).toBe(0);
  });

  it("decodes UTF-8, ISO-8859-1 and Windows-1252", () => {
    expect(decodeBytes(Buffer.from("Grüße", "utf8"), "UTF-8")).toBe("Grüße");
    expect(decodeBytes(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]), "iso-8859-1")).toBe("Grüße");
    expect(decodeBytes(Buffer.from([0x80, 0x35]), '"windows-1252"')).toBe("€5");
  });

  it("guesses UTF-8 or Windows-1252 when the charset is missing, US-ASCII or unknown", () => {
    expect(decodeBytes(Buffer.from("café", "utf8"), null)).toBe("café");
    expect(decodeBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "us-ascii")).toBe("café");
    expect(decodeBytes(Buffer.from("café", "utf8"), "x-unknown-charset")).toBe("café");
  });
});

describe("RFC 2047 encoded words", () => {
  it("decodes B and Q words in any case", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Café");
    expect(decodeEncodedWords("=?utf-8?q?Caf=C3=A9_au_lait?=")).toBe("Café au lait");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Gr=FC=DFe?=")).toBe("Grüße");
  });

  it("drops whitespace between encoded words and keeps other text", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?a?= \r\n =?UTF-8?Q?b?=")).toBe("ab");
    expect(decodeEncodedWords("Re: =?UTF-8?Q?caf=C3=A9?= today")).toBe("Re: café today");
    expect(decodeEncodedWords("=?UTF-8?Q?a?= x =?UTF-8?Q?b?=")).toBe("a x b");
  });

  it("joins a character split across two words", () => {
    // U+1F3AC is F0 9F 8E AC in UTF-8, split after two bytes.
    expect(decodeEncodedWords("=?UTF-8?Q?=F0=9F?= =?UTF-8?Q?=8E=AC?=")).toBe("🎬");
  });

  it("ignores a language suffix and leaves malformed words alone", () => {
    expect(decodeEncodedWords("=?UTF-8*en?Q?Hello?=")).toBe("Hello");
    expect(decodeEncodedWords("=?UTF-8?B?not base64!?=")).toBe("=?UTF-8?B?not base64!?=");
    expect(decodeEncodedWords("=?UTF-8?B?%%%?=")).toBe("=?UTF-8?B?%%%?=");
  });

  it("decodes header text with whitespace collapsed", () => {
    expect(decodeHeaderText("  Hello\r\n   =?UTF-8?B?V29ybGQ=?=  ")).toBe("Hello World");
    expect(decodeHeaderText(null)).toBe("");
  });
});

describe("addresses", () => {
  it("parses the common mailbox forms", () => {
    expect(parseAddress("Priya Raman <partnerships@meshwave.example>")).toEqual({
      name: "Priya Raman",
      email: "partnerships@meshwave.example",
    });
    expect(parseAddress("<solo@brand.example>")).toEqual({ name: null, email: "solo@brand.example" });
    expect(parseAddress("bare@brand.example")).toEqual({ name: null, email: "bare@brand.example" });
    expect(parseAddress("bare@brand.example (Name (nested))")).toEqual({ name: "Name (nested)", email: "bare@brand.example" });
    expect(parseAddress("Link <mailto:link@brand.example>")).toEqual({ name: "Link", email: "link@brand.example" });
    expect(parseAddress("no address here")).toBeNull();
    expect(parseAddress("Broken <not-an-address>")).toBeNull();
  });

  it("keeps commas inside quoted names and handles escapes, groups and comments", () => {
    expect(parseAddressList(getHeader(addressCommas.payload.headers, "To"))).toEqual([
      { name: "Smith, Jane (PR)", email: "jane@agency.example" },
      { name: null, email: "creator@example.com" },
      { name: 'Quote "Q" Person', email: "q@agency.example" },
    ]);
    expect(parseAddressList(getHeader(addressCommas.payload.headers, "Cc"))).toEqual([
      { name: "O'Brien, Pat", email: "pat@brand.example" },
      { name: "Müller, Anna", email: "anna@brand.example" },
      { name: null, email: "lead@brand.example" },
      { name: null, email: "solo@brand.example" },
    ]);
  });

  it("keeps an unquoted comma in a display name together with its address", () => {
    expect(parseAddressList("Doe, John <john@brand.example>, jane@brand.example")).toEqual([
      { name: "Doe, John", email: "john@brand.example" },
      { name: null, email: "jane@brand.example" },
    ]);
  });

  it("decodes encoded words in names, quoted or not", () => {
    expect(parseAddressList("=?UTF-8?Q?Doe=2C_John?= <john@brand.example>, \"=?UTF-8?B?SsO8cmdlbg==?=\" <j@brand.example>")).toEqual([
      { name: "Doe, John", email: "john@brand.example" },
      { name: "Jürgen", email: "j@brand.example" },
    ]);
  });

  it("skips entries without a usable address", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("nobody, @missing.example, ok@brand.example")).toEqual([{ name: null, email: "ok@brand.example" }]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("message ids", () => {
  it("extracts bracketed ids in order without duplicates", () => {
    expect(extractMessageIds("<a@x.example>\r\n <b@y.example> <a@x.example>")).toEqual(["<a@x.example>", "<b@y.example>"]);
    expect(extractMessageIds("<a@x.example> (comment) <c@z.example>")).toEqual(["<a@x.example>", "<c@z.example>"]);
  });

  it("accepts a bare id and refuses malformed ones", () => {
    expect(extractMessageIds("  bare@x.example ")).toEqual(["<bare@x.example>"]);
    expect(extractMessageIds("<> <no spaces allowed@x>")).toEqual([]);
    expect(extractMessageIds(null)).toEqual([]);
    expect(isValidMessageId("<a@x.example>")).toBe(true);
    expect(isValidMessageId("<a@x.example>\r\nBcc: evil@x.example")).toBe(false);
    expect(isValidMessageId(`<${"a".repeat(300)}@x.example>`)).toBe(false);
  });
});

describe("HTML to text", () => {
  it("drops scripts, styles and head content, converts blocks and decodes entities", () => {
    const html = Buffer.from(htmlOnly.payload.body.data, "base64url").toString("utf8");
    expect(htmlToText(html)).toBe(
      [
        "Hello Creator,",
        "",
        "We’d love to work with you on a paid partnership for \"Cast Iron Cooking\".",
        "",
        "Budget: 650 € & product",
        "Deadline: October 30",
        "Contact: A <b> tag stays text",
        "",
        "- One short segment",
        "- Link in the description",
        "",
        "Price check: 5 < 6 and 7 > 4 © ™ €",
        "",
        "Line one",
        "  indented line",
        "",
        "&lt;not a tag&gt;",
      ].join("\n"),
    );
  });

  it("counts every <br> but collapses adjacent block boundaries", () => {
    expect(htmlToText("Hello<br><br>World")).toBe("Hello\n\nWorld");
    expect(htmlToText("<div><div>One</div></div><div>Two</div>")).toBe("One\nTwo");
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr>\n<tr><td>c</td></tr></table>")).toBe("a b\nc");
    expect(htmlToText("<p>First</p>\n\n\n<p>Second</p>")).toBe("First\n\nSecond");
  });

  it("collapses source whitespace like a browser", () => {
    expect(htmlToText("  Hello \n\t  <b>big</b>   world  ")).toBe("Hello big world");
    expect(htmlToText("a<span>b</span>c")).toBe("abc");
  });

  it("keeps text that only looks like markup and drops a tag cut off at the end", () => {
    expect(htmlToText("1 < 2 and 3 <= 4")).toBe("1 < 2 and 3 <= 4");
    expect(htmlToText("Before <a href=\"x")).toBe("Before");
    expect(htmlToText('<a title="1 > 0">link</a>')).toBe("link");
    expect(htmlToText("<script>var s = '</div>';</script>After")).toBe("After");
    expect(htmlToText("<style>p{}")).toBe("");
    expect(htmlToText("<!-- open comment")).toBe("");
  });

  it("decodes entities in one pass", () => {
    expect(decodeHtmlEntities("&amp;lt; &lt; &#60; &#x3C; &unknown; &amp")).toBe("&lt; < < < &unknown; &amp");
    expect(decodeHtmlEntities("&#0; &#x110000; &#xD800;")).toBe("\uFFFD \uFFFD \uFFFD");
    expect(decodeHtmlEntities("a&shy;b &eacute;")).toBe("ab é");
    expect(decodeHtmlEntities("&constructor; &toString; &__proto__; &hasOwnProperty;")).toBe(
      "&constructor; &toString; &__proto__; &hasOwnProperty;",
    );
    expect(htmlToText("<p>&valueOf;</p>")).toBe("&valueOf;");
  });

  it("stays fast on hostile input", () => {
    const started = Date.now();
    htmlToText("<a title='x".repeat(20_000) + "<script".repeat(20_000) + "<".repeat(100_000));
    htmlToText("<p>".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("message bodies", () => {
  it("prefers text/plain in multipart/alternative", () => {
    expect(extractBodyText(alternative.payload)).toBe(
      "Hi,\n\nI lead creator partnerships at Meshwave. We would like a 60 second integrated read for the Meshwave Duo in your next networking video.\n\nWe can offer 1,800 USD plus a test kit.\n\nBest,\nPriya Raman\nMeshwave",
    );
  });

  it("walks nested multipart/mixed and skips attachments", () => {
    const body = extractBodyText(nestedMixed.payload);
    expect(body).toBe(
      "Hello again,\n\nFollowing up with our media kit attached. The offer of 900 USD for a 45 second mention still stands.\n\nThanks,\nMarco",
    );
    expect(body).not.toContain("These terms");
  });

  it("reads a single part body and normalizes line endings and trailing spaces", () => {
    expect(extractBodyText(singlePart.payload)).toBe("Hi there,\n\nQuick question: do you take sponsored segments?\n\n--\nDana");
  });

  it("normalizes plain text line endings, trailing whitespace and outer blank lines", () => {
    expect(normalizePlainText("\r\n\n  \t\nHello \t\r\n  indented\t \r\r\n\n\nWorld !  \n \n\n")).toBe(
      "Hello\n  indented\n\n\n\nWorld!",
    );
    expect(normalizePlainText(" \n\t\n")).toBe("");
    expect(normalizePlainText("")).toBe("");
  });

  it("normalizes hostile plain text in linear time", () => {
    const spaces = `${" ".repeat(1_000_000)}x`;
    const newlines = `a${"\n".repeat(1_000_000)}b`;
    const edges = `${"\n".repeat(500_000)}x${" \t".repeat(250_000)}${"\n".repeat(500_000)}`;
    const payload = { mimeType: "text/plain", headers: [], body: { data: b64u(spaces) } };
    const started = Date.now();
    const spacesResult = normalizePlainText(spaces);
    const newlinesResult = normalizePlainText(newlines);
    const edgesResult = normalizePlainText(edges);
    const body = extractBodyText(payload);
    expect(Date.now() - started).toBeLessThan(500);
    expect(spacesResult === spaces).toBe(true);
    expect(newlinesResult === newlines).toBe(true);
    expect(edgesResult).toBe("x");
    expect(body === spaces).toBe(true);
  });

  it("reads at most the text limit of a plain or HTML part, without splitting a character", () => {
    const long = `${"a".repeat(MAX_PLAIN_TEXT_LENGTH)}tail`;
    expect(extractBodyText({ mimeType: "text/plain", headers: [], body: { data: b64u(long) } })).toHaveLength(MAX_PLAIN_TEXT_LENGTH);
    const splitPlain = normalizePlainText(`${"a".repeat(MAX_PLAIN_TEXT_LENGTH - 1)}\u{1F3AC}tail`);
    expect(splitPlain).toHaveLength(MAX_PLAIN_TEXT_LENGTH - 1);
    expect(splitPlain.endsWith("a")).toBe(true);
    const splitHtml = htmlToText(`${"a".repeat(MAX_HTML_LENGTH - 1)}\u{1F3AC}tail`);
    expect(splitHtml).toHaveLength(MAX_HTML_LENGTH - 1);
    expect(splitHtml.endsWith("a")).toBe(true);
  });

  it("converts HTML when an alternative has only blank plain text", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", headers: [], body: { data: b64u(" \r\n ") } },
        { mimeType: "text/html", headers: [], body: { data: b64u("<p>Real content</p>") } },
      ],
    };
    expect(extractBodyText(payload)).toBe("Real content");
  });

  it("joins inline text parts of a mixed message and reads the charset of each part", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { data: b64u("Part one") } },
        {
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          headers: [{ name: "Content-Disposition", value: "inline" }],
          body: { attachmentId: "abc" },
        },
        {
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
          body: { data: b64u("Teil zwei für dich", "latin1") },
        },
        { mimeType: "message/rfc822", headers: [], body: { data: b64u("Subject: forwarded") } },
      ],
    };
    expect(extractBodyText(payload)).toBe("Part one\n\nTeil zwei für dich");
    expect(extractBodyText(undefined)).toBe("");
    expect(extractBodyText({ mimeType: "application/pdf", body: { data: b64u("%PDF") } })).toBe("");
  });

  it("uses the Content-Type header when mimeType is missing", () => {
    const payload = { headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: b64u("<b>Bold</b>") } };
    expect(extractBodyText(payload)).toBe("Bold");
  });
});

describe("parsing Gmail messages", () => {
  it("parses a multipart/alternative message", () => {
    expect(parseGmailMessage(alternative)).toEqual({
      id: "191e8a2f4c0b7d11",
      threadId: "191e8a2f4c0b7d11",
      labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
      internalDate: new Date(1789369964000),
      from: { name: "Priya Raman", email: "partnerships@meshwave.example" },
      to: [{ name: null, email: "creator@example.com" }],
      cc: [],
      replyTo: [],
      subject: "Paid integration in your WiFi video",
      messageId: "<CAF7x9Q1meshwave0001@mail.gmail.com>",
      inReplyTo: null,
      references: [],
      date: new Date("2026-09-14T07:12:44.000Z"),
      bodyText:
        "Hi,\n\nI lead creator partnerships at Meshwave. We would like a 60 second integrated read for the Meshwave Duo in your next networking video.\n\nWe can offer 1,800 USD plus a test kit.\n\nBest,\nPriya Raman\nMeshwave",
    });
  });

  it("parses a follow-up with Cc, Reply-To and threading headers", () => {
    expect(parseGmailMessage(nestedMixed)).toMatchObject({
      threadId: "191e9b7c1a3f5e22",
      from: { name: "Marco Ellis", email: "marco@keystonevpn.example" },
      to: [{ name: "Creator", email: "creator@example.com" }],
      cc: [{ name: "Scheduling", email: "scheduling@brightreach.example" }],
      replyTo: [{ name: "Keystone Creators", email: "creators@keystonevpn.example" }],
      subject: "Re: Sponsorship for your home network videos",
      messageId: "<keystone-followup-2@mail.keystonevpn.example>",
      inReplyTo: "<CAF7x9Q1reply0002@mail.gmail.com>",
      references: ["<keystone-outreach-1@mail.keystonevpn.example>", "<CAF7x9Q1reply0002@mail.gmail.com>"],
      date: new Date("2026-09-15T16:40:02.000Z"),
    });
  });

  it("parses a single part message from a bare address", () => {
    expect(parseGmailMessage(singlePart)).toMatchObject({
      from: { name: null, email: "dana@hearthandfield.example" },
      subject: "Quick question",
      date: new Date("2026-09-16T12:00:00.000Z"),
    });
  });

  it("parses an HTML-only message", () => {
    const message = parseGmailMessage(htmlOnly);
    expect(message.from).toEqual({ name: "Hearth and Field", email: "hello@hearthandfield.example" });
    expect(message.bodyText.startsWith("Hello Creator,\n\nWe’d love to work with you")).toBe(true);
    expect(message.bodyText).not.toContain("window.track");
    expect(message.bodyText).not.toContain("color: #333");
    expect(message.bodyText).not.toContain("Partnership offer");
  });

  it("decodes an ISO-8859-1 body, subject and sender name", () => {
    expect(parseGmailMessage(latin1)).toMatchObject({
      subject: "Grüße aus München",
      from: { name: "Jürgen Müller", email: "juergen@kueche.example" },
      bodyText: "Grüße aus München!\n\nWir bieten 500 £ für ein Segment über Crème brûlée.",
    });
  });

  it("reads headers in any case, unfolded, with duplicate references removed", () => {
    expect(parseGmailMessage(oddCasing)).toEqual({
      id: "19205a0b1c2d3e44",
      threadId: "191e8a2f4c0b7d11",
      labelIds: ["INBOX"],
      internalDate: new Date(1789812000000),
      from: { name: "Brand Team", email: "team@brand.example" },
      to: [{ name: null, email: "creator@example.com" }],
      cc: [{ name: null, email: "ops@brand.example" }],
      replyTo: [{ name: null, email: "replies@brand.example" }],
      subject: "Re: A subject that was folded across lines",
      messageId: "<odd.casing.1@brand.example>",
      inReplyTo: "<CAF7x9Q1meshwave0001@mail.gmail.com>",
      references: ["<root.0@brand.example>", "<CAF7x9Q1meshwave0001@mail.gmail.com>"],
      date: new Date("2026-09-19T10:00:00.000Z"),
      bodyText: "Header casing test body.",
    });
  });

  it("decodes encoded words in the subject and in names", () => {
    expect(parseGmailMessage(encodedWords)).toMatchObject({
      subject: "Colaboración pagada: café y más 🎬",
      from: { name: "José García", email: "jose@marca.example" },
      to: [{ name: "Creador", email: "creator@example.com" }],
      cc: [{ name: "山田太郎", email: "yamada@brand.example" }],
      bodyText: "Hola, ¿te interesa un patrocinio? 🎬",
    });
  });

  it("parses addresses with commas in quoted names", () => {
    expect(parseGmailMessage(addressCommas)).toMatchObject({
      from: { name: "Doe, John", email: "john.doe@brand.example" },
      replyTo: [{ name: "Brand Partnerships", email: "partnerships@brand.example" }],
    });
  });

  it("refuses a resource without ids or any date", () => {
    expect(() => parseMessageSummary({ threadId: "t" })).toThrow(GmailError);
    expect(() => parseMessageSummary({ id: "m" })).toThrow(GmailError);
    expect(() => parseMessageSummary({ id: "m", threadId: "t", payload: { headers: [] } })).toThrow(GmailError);
  });

  it("falls back to the Date header and tolerates missing headers", () => {
    const message: ApiMessage = {
      id: "m",
      threadId: "t",
      payload: { mimeType: "text/plain", headers: [{ name: "Date", value: "Mon, 14 Sep 2026 10:00:00 +0000" }], body: {} },
    };
    expect(parseGmailMessage(message)).toEqual({
      id: "m",
      threadId: "t",
      labelIds: [],
      internalDate: new Date("2026-09-14T10:00:00.000Z"),
      from: null,
      to: [],
      cc: [],
      replyTo: [],
      subject: "",
      messageId: null,
      inReplyTo: null,
      references: [],
      date: new Date("2026-09-14T10:00:00.000Z"),
      bodyText: "",
    });
  });

  it("removes control characters from subjects, names and bodies", () => {
    const nul = String.fromCharCode(0);
    const message = parseGmailMessage({
      id: "m",
      threadId: "t",
      internalDate: "1789369964000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: `Hello${nul} there` },
          { name: "From", value: `"Bad${nul}Name" <bad@brand.example>` },
        ],
        body: { data: b64u(`Body${nul} text`) },
      },
    });
    expect(message.subject).toBe("Hello there");
    expect(message.from).toEqual({ name: "BadName", email: "bad@brand.example" });
    expect(message.bodyText).toBe("Body text");
  });
});
