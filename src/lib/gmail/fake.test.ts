import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "@/lib/clock";
import { CONTRACT_START, CONTRACT_TOPIC, describeGmailPortContract } from "@/lib/gmail/contract";
import {
  FAKE_OWNER_EMAIL,
  FakeGmailHttpError,
  WATCH_DURATION_MS,
  createFakeGmail,
  formatRfc2822Date,
  type FakePushNotification,
} from "@/lib/gmail/fake";
import alternative from "@/lib/gmail/fixtures/message-multipart-alternative.json";
import nestedMixed from "@/lib/gmail/fixtures/message-nested-mixed.json";
import { GmailError } from "@/lib/gmail/port";
import { buildReplyRaw } from "@/lib/gmail/reply";

describeGmailPortContract("fake", async () => {
  const clock = createManualClock(CONTRACT_START);
  const mailbox = createFakeGmail({ clock, maxPageSize: 2 });
  return { port: mailbox, mailbox, clock };
});

function setup() {
  const clock = createManualClock(new Date("2026-09-14T10:00:00.000Z"));
  const pushes: FakePushNotification[] = [];
  const mailbox = createFakeGmail({ clock, onPush: (notification) => pushes.push(notification) });
  return { clock, mailbox, pushes };
}

async function httpStatus(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(FakeGmailHttpError);
  return (error as FakeGmailHttpError).status;
}

describe("fake Gmail mailbox", () => {
  it("uses the owner address, a numeric history id and one new history id per message", () => {
    const mailbox = createFakeGmail({ startHistoryId: 5000 });
    expect(mailbox.ownerEmail).toBe(FAKE_OWNER_EMAIL);
    expect(mailbox.currentHistoryId()).toBe("5000");
    mailbox.deliverEmail({ from: "a@brand.example", subject: "One", text: "1" });
    mailbox.deliverEmail({ from: "b@brand.example", subject: "Two", text: "2" });
    expect(mailbox.currentHistoryId()).toBe("5002");
  });

  it("gives messages 16 digit hex ids and a thread id equal to the first message id", () => {
    const { mailbox } = setup();
    const first = mailbox.deliverEmail({ from: "a@brand.example", subject: "Offer", text: "1" });
    const reply = mailbox.deliverEmail({ from: "a@brand.example", subject: "Re: Offer", text: "2", inReplyTo: first.messageId! });
    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(first.threadId).toBe(first.id);
    expect(reply.threadId).toBe(first.id);
    expect(reply.references).toEqual([first.messageId]);
    const explicit = mailbox.deliverEmail({ from: "a@brand.example", subject: "Other", text: "3", threadId: "thread-custom" });
    expect(explicit.threadId).toBe("thread-custom");
  });

  it("files mail from the owner as SENT unless labels are given", () => {
    const { mailbox } = setup();
    const own = mailbox.deliverEmail({ from: { name: "Me", email: "Creator@Example.com" }, to: ["x@brand.example"], subject: "Mine", text: "1" });
    expect(own.labelIds).toEqual(["SENT"]);
    const labelled = mailbox.deliverEmail({ from: "a@brand.example", subject: "Spam", text: "1", labelIds: ["SPAM"] });
    expect(labelled.labelIds).toEqual(["SPAM"]);
  });

  it("requires text or html", () => {
    const { mailbox } = setup();
    expect(() => mailbox.deliverEmail({ from: "a@brand.example", subject: "Empty" })).toThrow(TypeError);
  });

  it("pushes a notification for INBOX mail only while a watch is active", async () => {
    const { clock, mailbox, pushes } = setup();
    mailbox.deliverEmail({ from: "a@brand.example", subject: "Before watch", text: "1" });
    expect(pushes).toEqual([]);

    await mailbox.watch(CONTRACT_TOPIC);
    mailbox.deliverEmail({ from: "a@brand.example", subject: "Watched", text: "2" });
    mailbox.deliverEmail({ from: FAKE_OWNER_EMAIL, to: ["a@brand.example"], subject: "Sent", text: "3" });
    expect(pushes).toEqual([{ emailAddress: FAKE_OWNER_EMAIL, historyId: String(Number(mailbox.currentHistoryId()) - 1) }]);

    clock.advance(WATCH_DURATION_MS);
    expect(mailbox.isWatching()).toBe(false);
    expect(mailbox.watchState()).not.toBeNull();
    mailbox.deliverEmail({ from: "a@brand.example", subject: "After expiry", text: "4" });
    expect(pushes).toHaveLength(1);
  });

  it("records port calls in order", async () => {
    const { mailbox } = setup();
    await mailbox.getProfile();
    await mailbox.listHistory(mailbox.currentHistoryId());
    await mailbox.getMessage("missing").catch(() => undefined);
    expect(mailbox.calls).toEqual(["getProfile", "listHistory", "getMessage"]);
  });

  it("accepts Gmail API fixtures as they are", async () => {
    const { mailbox } = setup();
    const delivered = mailbox.deliverApiMessage(alternative);
    expect(delivered).toMatchObject({ id: alternative.id, threadId: alternative.threadId, subject: "Paid integration in your WiFi video" });
    expect(await mailbox.getMessage(alternative.id)).toEqual(delivered);

    const again = mailbox.deliverApiMessage(alternative);
    expect(again.id).not.toBe(alternative.id);
    expect(again.threadId).toBe(alternative.threadId);

    const mixed = mailbox.deliverApiMessage(nestedMixed);
    expect(mixed.bodyText).toContain("Following up with our media kit attached.");
    expect((await mailbox.getThread(nestedMixed.threadId)).messages.map((message) => message.id)).toEqual([nestedMixed.id]);
  });

  it("serves the metadata and minimal formats without bodies and refuses others", async () => {
    const { mailbox } = setup();
    const delivered = mailbox.deliverEmail({ from: "a@brand.example", subject: "Offer", text: "Body", html: "<p>Body</p>" });
    const metadata = await mailbox.api.users.messages.get({ userId: "me", id: delivered.id, format: "metadata" });
    expect(metadata.data.payload?.parts).toBeUndefined();
    expect(metadata.data.payload?.body).toEqual({ size: 0 });
    expect(metadata.data.payload?.headers?.some((header) => header.name === "Subject")).toBe(true);
    const minimal = await mailbox.api.users.messages.get({ userId: "me", id: delivered.id, format: "minimal" });
    expect(minimal.data.payload).toBeUndefined();
    expect(await httpStatus(mailbox.api.users.messages.get({ userId: "me", id: delivered.id, format: "raw" }))).toBe(400);
  });

  it("answers bad requests like Gmail", async () => {
    const { mailbox } = setup();
    expect(await httpStatus(mailbox.api.users.getProfile({ userId: "someone@else.example" }))).toBe(400);
    expect(await httpStatus(mailbox.api.users.messages.list({ userId: "me", q: "from:someone" }))).toBe(400);
    expect(await httpStatus(mailbox.api.users.history.list({ userId: "me", startHistoryId: "1", pageToken: "x" }))).toBe(400);
    expect(await httpStatus(mailbox.api.users.messages.send({ userId: "me", requestBody: { threadId: "t" } }))).toBe(400);
    const noRecipients = Buffer.from("Subject: Hi\r\n\r\nBody\r\n").toString("base64url");
    expect(await httpStatus(mailbox.api.users.messages.send({ userId: "me", requestBody: { raw: noRecipients } }))).toBe(400);
  });

  it("stores a sent message with From, Date and Message-ID added and Bcc removed", async () => {
    const { clock, mailbox } = setup();
    const raw = Buffer.from(
      "To: partner@brand.example\r\nBcc: hidden@brand.example\r\nSubject: Hello\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\nHi there\r\n",
    ).toString("base64url");
    const { data } = await mailbox.api.users.messages.send({ userId: "me", requestBody: { raw } });
    const message = await mailbox.getMessage(data.id!);
    expect(message).toMatchObject({
      labelIds: ["SENT"],
      from: { name: null, email: FAKE_OWNER_EMAIL },
      to: [{ name: null, email: "partner@brand.example" }],
      subject: "Hello",
      date: clock.now(),
      bodyText: "Hi there",
    });
    expect(message.messageId).not.toBeNull();
    const stored = await mailbox.api.users.messages.get({ userId: "me", id: data.id!, format: "metadata" });
    expect(stored.data.payload?.headers?.some((header) => header.name?.toLowerCase() === "bcc")).toBe(false);
    expect(mailbox.sentReplies[0].headers).toContainEqual({ name: "Bcc", value: "hidden@brand.example" });
  });

  it("puts a reply sent to the owner in INBOX too", async () => {
    const { mailbox } = setup();
    const original = mailbox.deliverEmail({ from: "a@brand.example", subject: "Offer", text: "1" });
    const start = mailbox.currentHistoryId();
    const sent = await mailbox.sendReply({
      threadId: original.threadId,
      to: ["a@brand.example"],
      cc: [FAKE_OWNER_EMAIL],
      subject: "Offer",
      bodyText: "Copy to myself",
      inReplyTo: original.messageId,
      references: [],
    });
    expect(await mailbox.listHistory(start)).toEqual({
      status: "ok",
      messages: [{ id: sent.id, threadId: original.threadId, labelIds: ["SENT", "INBOX"] }],
      historyId: mailbox.currentHistoryId(),
    });
  });

  it("records the raw reply exactly as built", async () => {
    const { mailbox } = setup();
    const original = mailbox.deliverEmail({ from: "a@brand.example", subject: "Offer", text: "1" });
    const input = {
      threadId: original.threadId,
      to: ["a@brand.example"],
      cc: [],
      subject: "Offer",
      bodyText: "Thanks",
      inReplyTo: original.messageId,
      references: [],
    };
    await mailbox.sendReply(input);
    expect(mailbox.sentReplies[0].raw).toBe(buildReplyRaw(input));
    expect(mailbox.sentReplies[0].headers.map((header) => header.name)).toEqual([
      "To",
      "Subject",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
  });

  it("keeps a failure queue per method and any method", async () => {
    const { mailbox } = setup();
    mailbox.failNext("network");
    await expect(mailbox.getThread("x")).rejects.toMatchObject({ reason: "network" });
    mailbox.failNext("server_error", { times: 0 });
    await expect(mailbox.getProfile()).resolves.toMatchObject({ emailAddress: FAKE_OWNER_EMAIL });
  });

  it("formats dates the way mail headers carry them", () => {
    expect(formatRfc2822Date(new Date("2026-09-04T07:05:09.000Z"))).toBe("Fri, 4 Sep 2026 07:05:09 +0000");
  });

  it("can back demo mode with the system clock", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-14T12:00:00.000Z") });
    try {
      const mailbox = createFakeGmail();
      const watch = await mailbox.watch(CONTRACT_TOPIC);
      expect(watch.expiration).toEqual(new Date(Date.parse("2026-09-14T12:00:00.000Z") + WATCH_DURATION_MS));
    } finally {
      vi.useRealTimers();
    }
    await expect(createFakeGmail().watch("bad")).rejects.toBeInstanceOf(GmailError);
  });
});
