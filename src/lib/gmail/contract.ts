import { beforeEach, describe, expect, it } from "vitest";
import type { ManualClock } from "@/lib/clock";
import { WATCH_DURATION_MS, type FakeGmail, type FakeGmailFailure } from "@/lib/gmail/fake";
import {
  GMAIL_INBOX_LABEL,
  GMAIL_SENT_LABEL,
  GmailAuthError,
  GmailError,
  GmailNotFoundError,
  GmailTransientError,
  type GmailPort,
} from "@/lib/gmail/port";

// One behavior suite for every GmailPort implementation. The fake mailbox drives the
// scenario; `port` is the implementation under test on top of it: the fake's own port, or
// the Google implementation talking HTTP to the same mailbox.

export interface GmailHarness {
  port: GmailPort;
  mailbox: FakeGmail;
  clock: ManualClock;
}

export const CONTRACT_TOPIC = "projects/segue-test/topics/gmail";
export const CONTRACT_START = new Date("2026-09-14T09:00:00.000Z");

const SPONSOR = { name: "Priya Raman", email: "partnerships@meshwave.example" };

async function rejection(promise: Promise<unknown>): Promise<GmailError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GmailError);
  return error as GmailError;
}

export function describeGmailPortContract(name: string, makeHarness: () => Promise<GmailHarness>): void {
  describe(`GmailPort contract: ${name}`, () => {
    let h: GmailHarness;
    let port: GmailPort;
    let mailbox: FakeGmail;

    beforeEach(async () => {
      h = await makeHarness();
      port = h.port;
      mailbox = h.mailbox;
    });

    const deliver = (subject: string, extra: Partial<Parameters<FakeGmail["deliverEmail"]>[0]> = {}) =>
      mailbox.deliverEmail({ from: SPONSOR, subject, text: `Body of ${subject}`, ...extra });

    describe("profile and watch", () => {
      it("reads the owner address and the current history id", async () => {
        const before = await port.getProfile();
        expect(before).toEqual({ emailAddress: mailbox.ownerEmail, historyId: mailbox.currentHistoryId() });
        deliver("New mail");
        const after = await port.getProfile();
        expect(BigInt(after.historyId) > BigInt(before.historyId)).toBe(true);
      });

      it("starts, renews and stops the watch on INBOX", async () => {
        const started = await port.watch(CONTRACT_TOPIC);
        expect(started.historyId).toBe(mailbox.currentHistoryId());
        expect(started.expiration).toEqual(new Date(h.clock.now().getTime() + WATCH_DURATION_MS));
        expect(mailbox.watchState()).toEqual({
          topicName: CONTRACT_TOPIC,
          labelIds: [GMAIL_INBOX_LABEL],
          labelFilterBehavior: "INCLUDE",
          expiration: started.expiration,
        });
        expect(mailbox.isWatching()).toBe(true);

        h.clock.advance(24 * 60 * 60 * 1000);
        const renewed = await port.watch(CONTRACT_TOPIC);
        expect(renewed.expiration.getTime() - started.expiration.getTime()).toBe(24 * 60 * 60 * 1000);

        await port.stop();
        expect(mailbox.watchState()).toBeNull();
        expect(mailbox.isWatching()).toBe(false);
      });

      it("refuses a malformed topic name without starting a watch", async () => {
        const error = await rejection(port.watch("gmail-topic"));
        expect(error.reason).toBe("bad_request");
        expect(mailbox.watchState()).toBeNull();
      });
    });

    describe("history", () => {
      it("lists INBOX messages added after the start id, in order, across pages", async () => {
        const start = mailbox.currentHistoryId();
        const inbox = [deliver("One"), deliver("Two"), deliver("Three")];
        mailbox.deliverEmail({ from: mailbox.ownerEmail, to: [SPONSOR], subject: "Sent elsewhere", text: "Hi" });
        deliver("Spam", { labelIds: ["SPAM"] });
        inbox.push(deliver("Four"), deliver("Five"));

        const result = await port.listHistory(start);
        expect(result).toEqual({
          status: "ok",
          messages: inbox.map((message) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds })),
          historyId: mailbox.currentHistoryId(),
        });
        if (result.status === "ok") {
          expect(result.messages.every((message) => message.labelIds.includes(GMAIL_INBOX_LABEL))).toBe(true);
        }
      });

      it("returns nothing new and the same history id when the mailbox did not change", async () => {
        deliver("Old");
        const current = mailbox.currentHistoryId();
        expect(await port.listHistory(current)).toEqual({ status: "ok", messages: [], historyId: current });
      });

      it("reports an expired start id instead of throwing", async () => {
        const start = mailbox.currentHistoryId();
        deliver("Missed");
        mailbox.expireHistory();
        expect(await port.listHistory(start)).toEqual({ status: "expired" });
        const current = mailbox.currentHistoryId();
        expect(await port.listHistory(current)).toEqual({ status: "ok", messages: [], historyId: current });
      });

      it("rejects a start id that is not a number", async () => {
        const error = await rejection(port.listHistory("12ab"));
        expect(error.reason).toBe("bad_request");
      });

      it("lists inbox messages received after a time, newest first, up to the limit", async () => {
        const base = h.clock.now().getTime();
        const at = (minutes: number) => new Date(base + minutes * 60_000);
        deliver("Before", { date: at(0) });
        const first = deliver("First", { date: at(10) });
        const second = deliver("Second", { date: at(20) });
        deliver("Spam after", { date: at(25), labelIds: ["SPAM", GMAIL_INBOX_LABEL] });
        const third = deliver("Third", { date: at(30) });
        mailbox.deliverEmail({ from: mailbox.ownerEmail, to: [SPONSOR], subject: "Sent", text: "Hi", date: at(40) });

        const after = Math.floor(at(10).getTime() / 1000);
        expect(await port.listInboxAfter(after, 2)).toEqual([
          { id: third.id, threadId: third.threadId },
          { id: second.id, threadId: second.threadId },
        ]);
        expect(await port.listInboxAfter(after, 50)).toEqual([
          { id: third.id, threadId: third.threadId },
          { id: second.id, threadId: second.threadId },
          { id: first.id, threadId: first.threadId },
        ]);
      });
    });

    describe("messages and threads", () => {
      it("parses a delivered message", async () => {
        const date = new Date("2026-09-14T08:30:00.000Z");
        const delivered = mailbox.deliverEmail({
          from: SPONSOR,
          to: [{ name: "Creator", email: mailbox.ownerEmail }],
          cc: [{ name: "Doe, John", email: "john@agency.example" }],
          replyTo: ["creators@meshwave.example"],
          subject: "Colaboración pagada",
          text: "Hello,\n\nWe would like to sponsor a video.\n",
          html: "<p>This HTML part is not used.</p>",
          date,
        });
        const message = await port.getMessage(delivered.id);
        expect(message).toEqual(delivered);
        expect(message).toMatchObject({
          threadId: delivered.id,
          labelIds: [GMAIL_INBOX_LABEL, "UNREAD"],
          internalDate: date,
          date,
          from: SPONSOR,
          to: [{ name: "Creator", email: mailbox.ownerEmail }],
          cc: [{ name: "Doe, John", email: "john@agency.example" }],
          replyTo: [{ name: null, email: "creators@meshwave.example" }],
          subject: "Colaboración pagada",
          inReplyTo: null,
          references: [],
          bodyText: "Hello,\n\nWe would like to sponsor a video.",
        });
        expect(message.messageId).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
      });

      it("reads HTML-only mail as text", async () => {
        const delivered = mailbox.deliverEmail({
          from: SPONSOR,
          subject: "HTML",
          html: "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there,</p><p>Paid <b>offer</b> inside.</p></body></html>",
        });
        expect((await port.getMessage(delivered.id)).bodyText).toBe("Hi there,\n\nPaid offer inside.");
      });

      it("throws GmailNotFoundError for an unknown message or thread", async () => {
        expect(await rejection(port.getMessage("ffffffffffffffff"))).toBeInstanceOf(GmailNotFoundError);
        expect(await rejection(port.getThread("ffffffffffffffff"))).toBeInstanceOf(GmailNotFoundError);
      });

      it("returns a thread oldest first, with the owner's replies", async () => {
        const original = deliver("Sponsorship", { date: new Date(h.clock.now().getTime() - 60_000) });
        const sent = await port.sendReply({
          threadId: original.threadId,
          to: [SPONSOR.email],
          cc: [],
          subject: original.subject,
          bodyText: "Thanks, interested.",
          inReplyTo: original.messageId,
          references: original.references,
        });
        h.clock.advance(60_000);
        const sentMessage = (await port.getThread(original.threadId)).messages.find((message) => message.id === sent.id);
        const followUp = deliver("Re: Sponsorship", { inReplyTo: sentMessage?.messageId ?? undefined });

        const thread = await port.getThread(original.threadId);
        expect(thread.id).toBe(original.threadId);
        expect(thread.messages.map((message) => message.id)).toEqual([original.id, sent.id, followUp.id]);
        expect(thread.messages[1]).toMatchObject({
          labelIds: [GMAIL_SENT_LABEL],
          from: { name: null, email: mailbox.ownerEmail },
          subject: "Re: Sponsorship",
          inReplyTo: original.messageId,
          references: [original.messageId],
        });
        expect(thread.messages[2]).toMatchObject({
          from: SPONSOR,
          inReplyTo: sentMessage?.messageId,
          references: [original.messageId, sentMessage?.messageId],
        });
        expect(thread.messages[0].internalDate.getTime()).toBeLessThan(thread.messages[1].internalDate.getTime());
      });
    });

    describe("sending replies", () => {
      it("sends a reply in the thread with threading headers", async () => {
        const first = deliver("Paid integration");
        const sponsorReply = deliver("Re: Paid integration", { inReplyTo: first.messageId ?? undefined });
        const start = mailbox.currentHistoryId();

        const sent = await port.sendReply({
          threadId: sponsorReply.threadId,
          to: [SPONSOR.email],
          cc: ["scheduling@brightreach.example"],
          subject: sponsorReply.subject,
          bodyText: "Hi Priya,\nThank you.\n",
          inReplyTo: sponsorReply.messageId,
          references: sponsorReply.references,
        });

        expect(sent.threadId).toBe(first.threadId);
        expect(mailbox.sentReplies).toHaveLength(1);
        expect(mailbox.sentReplies[0]).toMatchObject({
          id: sent.id,
          threadId: first.threadId,
          requestedThreadId: first.threadId,
          to: [{ name: null, email: SPONSOR.email }],
          cc: [{ name: null, email: "scheduling@brightreach.example" }],
          subject: "Re: Paid integration",
          inReplyTo: sponsorReply.messageId,
          references: [first.messageId, sponsorReply.messageId],
          bodyText: "Hi Priya,\nThank you.\n",
        });
        // A sent reply is not an INBOX message.
        expect(await port.listHistory(start)).toEqual({ status: "ok", messages: [], historyId: mailbox.currentHistoryId() });
      });

      it("lands in a new thread when the subject does not match, as Gmail does", async () => {
        const original = deliver("Offer");
        const sent = await port.sendReply({
          threadId: original.threadId,
          to: [SPONSOR.email],
          cc: [],
          subject: "Something else",
          bodyText: "Hi",
          inReplyTo: original.messageId,
          references: [],
        });
        expect(sent.threadId).not.toBe(original.threadId);
      });

      it("lands in a new thread when In-Reply-To and References name no message of the thread, as Gmail does", async () => {
        const original = deliver("Sponsorship");
        const otherThread = mailbox.deliverEmail({
          from: "deals@otherbrand.example",
          subject: "Sponsorship",
          text: "A different offer",
        });
        expect(otherThread.threadId).not.toBe(original.threadId);
        const reply = {
          threadId: original.threadId,
          to: [SPONSOR.email],
          cc: [],
          subject: original.subject,
          bodyText: "Hi",
        };

        const withoutHeaders = await port.sendReply({ ...reply, inReplyTo: null, references: [] });
        const foreignHeaders = await port.sendReply({
          ...reply,
          inReplyTo: otherThread.messageId,
          references: [otherThread.messageId ?? ""],
        });

        expect(mailbox.sentReplies).toMatchObject([
          { id: withoutHeaders.id, requestedThreadId: original.threadId, inReplyTo: null, references: [] },
          {
            id: foreignHeaders.id,
            requestedThreadId: original.threadId,
            inReplyTo: otherThread.messageId,
            references: [otherThread.messageId],
          },
        ]);
        for (const sent of [withoutHeaders, foreignHeaders]) {
          expect(sent.threadId).not.toBe(original.threadId);
          expect(sent.threadId).not.toBe(otherThread.threadId);
        }
        expect((await port.getThread(original.threadId)).messages.map((message) => message.id)).toEqual([original.id]);
      });

      it("refuses an invalid recipient before anything is sent", async () => {
        const original = deliver("Offer");
        for (const to of [["partner@brand.example\r\nBcc: attacker@evil.example"], ["Name <partner@brand.example>"], []]) {
          const error = await rejection(
            port.sendReply({
              threadId: original.threadId,
              to,
              cc: [],
              subject: original.subject,
              bodyText: "Hi",
              inReplyTo: original.messageId,
              references: [],
            }),
          );
          expect(error.reason).toBe("invalid_recipient");
          expect(error.sendOutcome).toBe("not_sent");
        }
        expect(mailbox.sentReplies).toHaveLength(0);
      });

      it("reports a send to an unknown thread as not found and not sent", async () => {
        const error = await rejection(
          port.sendReply({
            threadId: "ffffffffffffffff",
            to: [SPONSOR.email],
            cc: [],
            subject: "Offer",
            bodyText: "Hi",
            inReplyTo: null,
            references: [],
          }),
        );
        expect(error).toBeInstanceOf(GmailNotFoundError);
        expect(error.sendOutcome).toBe("not_sent");
      });

      it("reports an unknown outcome when the connection drops after Gmail accepted the send", async () => {
        const original = deliver("Offer");
        mailbox.failNextSendAfterAcceptance();
        const error = await rejection(
          port.sendReply({
            threadId: original.threadId,
            to: [SPONSOR.email],
            cc: [],
            subject: original.subject,
            bodyText: "Accepted",
            inReplyTo: original.messageId,
            references: [],
          }),
        );
        expect(error).toBeInstanceOf(GmailTransientError);
        expect(error.sendOutcome).toBe("unknown");
        expect(mailbox.sentReplies).toHaveLength(1);
        const thread = await port.getThread(original.threadId);
        expect(thread.messages.some((message) => message.labelIds.includes(GMAIL_SENT_LABEL))).toBe(true);
      });

      it("reports whether a refused send may have gone out", async () => {
        const original = deliver("Offer");
        const input = {
          threadId: original.threadId,
          to: [SPONSOR.email],
          cc: [],
          subject: original.subject,
          bodyText: "Hi",
          inReplyTo: original.messageId,
          references: [],
        };
        mailbox.failNext("rate_limited", { method: "sendReply" });
        expect((await rejection(port.sendReply(input))).sendOutcome).toBe("not_sent");
        mailbox.failNext("invalid_grant", { method: "sendReply" });
        expect((await rejection(port.sendReply(input))).sendOutcome).toBe("not_sent");
        mailbox.failNext("server_error", { method: "sendReply" });
        expect((await rejection(port.sendReply(input))).sendOutcome).toBe("unknown");
        mailbox.failNext("timeout", { method: "sendReply" });
        expect((await rejection(port.sendReply(input))).sendOutcome).toBe("unknown");
        expect(mailbox.sentReplies).toHaveLength(0);
      });
    });

    describe("failures", () => {
      const cases: [FakeGmailFailure, new (...args: never[]) => GmailError, GmailError["reason"]][] = [
        ["invalid_grant", GmailAuthError, "invalid_grant"],
        ["unauthorized", GmailAuthError, "unauthorized"],
        ["insufficient_scope", GmailAuthError, "insufficient_scope"],
        ["rate_limited", GmailTransientError, "rate_limited"],
        ["server_error", GmailTransientError, "server_error"],
        ["network", GmailTransientError, "network"],
        ["timeout", GmailTransientError, "timeout"],
        ["forbidden", GmailError, "forbidden"],
        ["bad_request", GmailError, "bad_request"],
        ["not_found", GmailNotFoundError, "not_found"],
      ];

      it.each(cases)("maps %s to a typed error", async (failure, errorClass, reason) => {
        mailbox.failNext(failure, { method: "getProfile" });
        const error = await rejection(port.getProfile());
        expect(error).toBeInstanceOf(errorClass);
        expect(error.reason).toBe(reason);
        expect(error.message).not.toContain(mailbox.ownerEmail);
        if (errorClass === GmailError) {
          expect(error).not.toBeInstanceOf(GmailAuthError);
          expect(error).not.toBeInstanceOf(GmailTransientError);
        }
        expect(await port.getProfile()).toMatchObject({ emailAddress: mailbox.ownerEmail });
      });

      it("fails only the chosen method, as many times as asked", async () => {
        const original = deliver("Offer");
        mailbox.failNext("server_error", { method: "getThread", times: 2 });
        expect(await port.getMessage(original.id)).toMatchObject({ id: original.id });
        expect(await rejection(port.getThread(original.threadId))).toBeInstanceOf(GmailTransientError);
        expect(await rejection(port.getThread(original.threadId))).toBeInstanceOf(GmailTransientError);
        expect((await port.getThread(original.threadId)).messages).toHaveLength(1);
      });

      it("fails every call while access is revoked", async () => {
        mailbox.revokeAccess();
        expect(await rejection(port.getProfile())).toBeInstanceOf(GmailAuthError);
        expect(await rejection(port.listHistory(mailbox.currentHistoryId()))).toBeInstanceOf(GmailAuthError);
        expect(await rejection(port.watch(CONTRACT_TOPIC))).toBeInstanceOf(GmailAuthError);
        mailbox.restoreAccess();
        expect(await port.getProfile()).toMatchObject({ emailAddress: mailbox.ownerEmail });
      });

      it("clears pending failures", async () => {
        mailbox.failNext("server_error", { times: 5 });
        mailbox.revokeAccess();
        mailbox.failNextSendAfterAcceptance();
        mailbox.clearFailures();
        expect(await port.getProfile()).toMatchObject({ emailAddress: mailbox.ownerEmail });
      });
    });
  });
}
