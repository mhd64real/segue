import { describe, expect, it } from "vitest";
import { VIDEO_SCRIPT_MAX_LENGTH, VIDEO_TITLE_MAX_LENGTH } from "@/lib/store/types";
import { VIDEO_FIELD_MESSAGES } from "@/lib/videos/form";
import { parseMonitoringInput, parseVideoContent, parseVideoId, parseVideoIdField } from "@/lib/videos/validation";

const ID = "0f5c3b1e-8a4d-4c2b-9e7f-1a2b3c4d5e6f";

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

describe("parseVideoContent", () => {
  it("trims the title and keeps the script", () => {
    expect(parseVideoContent(form({ title: "  My video \n", script: "  Line one\n\nLine two  " }))).toEqual({
      ok: true,
      data: { title: "My video", script: "  Line one\n\nLine two  " },
    });
  });

  it("accepts an empty script and the longest title and script", () => {
    const title = `  ${"t".repeat(VIDEO_TITLE_MAX_LENGTH)}  `;
    expect(parseVideoContent(form({ title, script: "" }))).toMatchObject({ ok: true });
    expect(parseVideoContent(form({ title: "T", script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH) }))).toMatchObject({ ok: true });
  });

  it("requires a title that is not only whitespace", () => {
    for (const title of ["", "   ", "\n\t "]) {
      expect(parseVideoContent(form({ title, script: "Script" }))).toEqual({
        ok: false,
        fieldErrors: { title: VIDEO_FIELD_MESSAGES.titleRequired },
      });
    }
  });

  it("rejects a title over the limit", () => {
    expect(parseVideoContent(form({ title: "t".repeat(VIDEO_TITLE_MAX_LENGTH + 1), script: "" }))).toEqual({
      ok: false,
      fieldErrors: { title: VIDEO_FIELD_MESSAGES.titleTooLong },
    });
  });

  it("rejects a script over the limit", () => {
    expect(parseVideoContent(form({ title: "Title", script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) }))).toEqual({
      ok: false,
      fieldErrors: { script: VIDEO_FIELD_MESSAGES.scriptTooLong },
    });
  });

  it("counts CRLF line breaks as one character, as the counter does", () => {
    const lines = "a\r\n".repeat(VIDEO_SCRIPT_MAX_LENGTH / 2);
    const parsed = parseVideoContent(form({ title: "Title", script: lines }));
    expect(parsed).toEqual({ ok: true, data: { title: "Title", script: "a\n".repeat(VIDEO_SCRIPT_MAX_LENGTH / 2) } });
    expect(parseVideoContent(form({ title: "Title", script: "a\r".repeat(3) }))).toMatchObject({
      data: { script: "a\na\na\n" },
    });
  });

  it("reports both fields at once", () => {
    expect(parseVideoContent(form({ title: " ", script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) }))).toEqual({
      ok: false,
      fieldErrors: { title: VIDEO_FIELD_MESSAGES.titleRequired, script: VIDEO_FIELD_MESSAGES.scriptTooLong },
    });
  });

  it("rejects missing fields, files and anything that is not form data", () => {
    expect(parseVideoContent(form({}))).toEqual({
      ok: false,
      fieldErrors: { title: VIDEO_FIELD_MESSAGES.titleRequired, script: VIDEO_FIELD_MESSAGES.scriptInvalid },
    });
    expect(parseVideoContent(form({ title: new Blob(["x"]), script: new Blob(["y"]) }))).toMatchObject({ ok: false });
    for (const input of [undefined, null, "title", { title: "Title", script: "" }]) {
      expect(parseVideoContent(input)).toMatchObject({ ok: false });
    }
  });

  it("never puts the input into an error message", () => {
    const secret = "confidential sponsor terms ";
    const parsed = parseVideoContent(
      form({ title: secret.repeat(20), script: secret.repeat(VIDEO_SCRIPT_MAX_LENGTH / secret.length + 1) }),
    );
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("confidential");
  });
});

describe("parseVideoId", () => {
  it("accepts UUIDs and returns them in lowercase", () => {
    expect(parseVideoId(ID)).toBe(ID);
    expect(parseVideoId(ID.toUpperCase())).toBe(ID);
  });

  it("rejects malformed ids", () => {
    for (const value of ["", "new", "not-a-uuid", `${ID}x`, ` ${ID}`, "../etc", 42, null, undefined, {}]) {
      expect(parseVideoId(value)).toBeNull();
    }
  });

  it("reads the id from form data", () => {
    expect(parseVideoIdField(form({ videoId: ID }))).toBe(ID);
    expect(parseVideoIdField(form({ videoId: "x" }))).toBeNull();
    expect(parseVideoIdField(form({}))).toBeNull();
    expect(parseVideoIdField({ videoId: ID })).toBeNull();
  });
});

describe("parseMonitoringInput", () => {
  it("accepts an id and a boolean", () => {
    expect(parseMonitoringInput({ videoId: ID.toUpperCase(), monitoring: true })).toEqual({
      ok: true,
      data: { videoId: ID, monitoring: true },
    });
    expect(parseMonitoringInput({ videoId: ID, monitoring: false })).toMatchObject({ ok: true });
  });

  it("treats a malformed id as not found and a non boolean flag as invalid", () => {
    expect(parseMonitoringInput({ videoId: "nope", monitoring: true })).toEqual({ ok: false, error: "not_found" });
    expect(parseMonitoringInput(undefined)).toEqual({ ok: false, error: "not_found" });
    for (const monitoring of ["true", 1, null, undefined]) {
      expect(parseMonitoringInput({ videoId: ID, monitoring })).toEqual({ ok: false, error: "invalid_input" });
    }
  });
});
