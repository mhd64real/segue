import { describe, expect, it } from "vitest";
import { VIDEO_SCRIPT_MAX_LENGTH } from "@/lib/store/types";
import {
  VIDEO_ACTION_MESSAGES,
  VIDEO_DELETE_CONFIRMATION,
  VIDEO_FIELD_MESSAGES,
  isScriptTooLong,
  isVideoDirty,
  normalizeScript,
  normalizeTitle,
  scriptCounter,
  visibleErrors,
} from "@/lib/videos/form";

const DASHES = /[\u2010-\u2015\u2212]/;

describe("video form helpers", () => {
  it("formats the script counter with separators", () => {
    expect(scriptCounter("")).toBe("0 / 60,000");
    expect(scriptCounter("s".repeat(12345))).toBe("12,345 / 60,000");
  });

  it("flags a script over the limit after normalizing line breaks", () => {
    expect(isScriptTooLong("s".repeat(VIDEO_SCRIPT_MAX_LENGTH))).toBe(false);
    expect(isScriptTooLong("s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1))).toBe(true);
    expect(isScriptTooLong("s\r\n".repeat(VIDEO_SCRIPT_MAX_LENGTH / 2))).toBe(false);
  });

  it("normalizes titles and line breaks", () => {
    expect(normalizeTitle("  A title ")).toBe("A title");
    expect(normalizeScript("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("compares the current fields with the saved ones", () => {
    const saved = { title: "Title", script: "Script" };
    expect(isVideoDirty({ ...saved }, saved)).toBe(false);
    expect(isVideoDirty({ ...saved, title: "Title " }, saved)).toBe(true);
    expect(isVideoDirty({ ...saved, script: "Script." }, saved)).toBe(true);
  });

  it("hides the error of a field edited since the last submit", () => {
    const errors = { title: "Title is required.", script: "Too long" };
    expect(visibleErrors(errors, new Set())).toEqual(errors);
    expect(visibleErrors(errors, new Set(["title"]))).toEqual({ script: "Too long" });
    expect(visibleErrors({}, new Set(["script"]))).toEqual({});
  });

  it("keeps messages short, fixed and free of dash characters", () => {
    for (const message of [...Object.values(VIDEO_FIELD_MESSAGES), ...Object.values(VIDEO_ACTION_MESSAGES)]) {
      expect(message).not.toMatch(DASHES);
      expect(message.length).toBeLessThan(120);
    }
    expect(VIDEO_FIELD_MESSAGES.scriptTooLong).toBe("Script must be 60,000 characters or fewer.");
    expect(VIDEO_FIELD_MESSAGES.titleTooLong).toBe("Title must be 200 characters or fewer.");
  });

  it("confirms a delete with only the sponsorship changes the Store makes", () => {
    expect(VIDEO_DELETE_CONFIRMATION).not.toMatch(DASHES);
    // Failed sponsorships stay Failed, so the copy never promises that every matched one changes.
    expect(VIDEO_DELETE_CONFIRMATION).not.toMatch(/matched/i);
    expect(VIDEO_DELETE_CONFIRMATION).toContain("Sponsorships branched or being branched on it are marked No fit.");
  });
});
