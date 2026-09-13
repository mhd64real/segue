import { describe, expect, it } from "vitest";
import { ERROR_MAX_LENGTH, StoreError } from "@/lib/store/types";
import {
  assertAppStatePatch,
  assertHistoryId,
  assertNewSponsorship,
  assertVideoPatch,
  clampError,
  isUuid,
  normalizeUsage,
} from "@/lib/store/validation";

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof StoreError ? error.code : "other";
  }
  return undefined;
}

describe("store validation", () => {
  it("recognizes UUIDs", () => {
    expect(isUuid("0f5c3b1e-8a4d-4c2b-9e7f-1a2b3c4d5e6f")).toBe(true);
    expect(isUuid("0F5C3B1E-8A4D-4C2B-9E7F-1A2B3C4D5E6F")).toBe(true);
    expect(isUuid("0f5c3b1e8a4d4c2b9e7f1a2b3c4d5e6f")).toBe(false);
    expect(isUuid("' or 1=1 --")).toBe(false);
  });

  it("clamps errors by code point and keeps null", () => {
    expect(clampError(null)).toBeNull();
    expect(clampError(undefined)).toBeNull();
    expect(clampError("short")).toBe("short");
    const emoji = "\u{1F600}".repeat(ERROR_MAX_LENGTH);
    const clamped = clampError(`x${emoji}`)!;
    expect(Array.from(clamped)).toHaveLength(ERROR_MAX_LENGTH);
    expect(clamped.endsWith("\u{1F600}")).toBe(true);
  });

  it("normalizes token usage to non-negative whole numbers", () => {
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage({ inputTokens: 10.9, outputTokens: -1 })).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(normalizeUsage({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(normalizeUsage({ inputTokens: 5e12, outputTokens: 3 })).toEqual({ inputTokens: 2_000_000_000, outputTokens: 3 });
  });

  it("checks history ids, dates and patches", () => {
    expect(codeOf(() => assertHistoryId("123"))).toBeUndefined();
    expect(codeOf(() => assertHistoryId("1.5"))).toBe("invalid_input");
    expect(codeOf(() => assertAppStatePatch({ lastCheckedAt: new Date("nope") }))).toBe("invalid_input");
    expect(codeOf(() => assertAppStatePatch({ watchExpiresAt: null }))).toBeUndefined();
    expect(codeOf(() => assertVideoPatch({ monitoring: true }))).toBeUndefined();
    expect(codeOf(() => assertVideoPatch({ title: " \n " }))).toBe("invalid_input");
  });

  it("checks new sponsorships", () => {
    const valid = {
      gmailMessageId: "m",
      threadId: "t",
      fromName: null,
      fromEmail: "a@b.example",
      replyTo: null,
      cc: [],
      subject: "",
      bodyText: "",
      receivedAt: new Date(),
      brand: null,
      product: null,
      deliverable: null,
      compensation: null,
      deadline: null,
      summary: null,
    };
    expect(codeOf(() => assertNewSponsorship(valid))).toBeUndefined();
    expect(codeOf(() => assertNewSponsorship({ ...valid, fromEmail: "" }))).toBe("invalid_input");
    expect(codeOf(() => assertNewSponsorship({ ...valid, threadId: "t".repeat(201) }))).toBe("invalid_input");
    expect(codeOf(() => assertNewSponsorship({ ...valid, receivedAt: new Date(Number.NaN) }))).toBe("invalid_input");
  });
});
