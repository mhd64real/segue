import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DecryptError,
  decryptSecret,
  decryptWithKey,
  encryptSecret,
  encryptWithKey,
  parseEncryptionKey,
} from "@/lib/crypto";
import { InvalidEnvError, MissingEnvError } from "@/lib/env";

const key = randomBytes(32);
const otherKey = randomBytes(32);

function flipChar(part: string, index: number): string {
  const replacement = part[index] === "A" ? "B" : "A";
  return part.slice(0, index) + replacement + part.slice(index + 1);
}

function expectDecryptError(fn: () => unknown, reason: DecryptError["reason"]) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DecryptError);
    expect((error as DecryptError).reason).toBe(reason);
    return;
  }
  throw new Error("expected DecryptError");
}

describe("encryptWithKey and decryptWithKey", () => {
  it("round trips text, including empty and non-ASCII text", () => {
    for (const text of ["1//0refresh-token", "", "Sponsored by été \u{1F600}", "x".repeat(10000)]) {
      expect(decryptWithKey(encryptWithKey(text, key), key)).toBe(text);
    }
  });

  it("uses the versioned format with a 12-byte IV and a 16-byte tag", () => {
    const payload = encryptWithKey("secret", key);
    const parts = payload.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64url")).toHaveLength(16);
    expect(payload).not.toContain("secret");
  });

  it("uses a fresh IV for every encryption", () => {
    const a = encryptWithKey("same", key);
    const b = encryptWithKey("same", key);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("detects a tampered ciphertext, tag or IV", () => {
    const [version, iv, tag, ciphertext] = encryptWithKey("refresh-token-value", key).split(".");
    expectDecryptError(() => decryptWithKey([version, iv, tag, flipChar(ciphertext, 2)].join("."), key), "authentication");
    expectDecryptError(() => decryptWithKey([version, iv, flipChar(tag, 3), ciphertext].join("."), key), "authentication");
    expectDecryptError(() => decryptWithKey([version, flipChar(iv, 4), tag, ciphertext].join("."), key), "authentication");
  });

  it("fails authentication with the wrong key", () => {
    const payload = encryptWithKey("refresh-token-value", key);
    expectDecryptError(() => decryptWithKey(payload, otherKey), "authentication");
  });

  it("rejects malformed payloads", () => {
    const [, iv, tag, ciphertext] = encryptWithKey("value", key).split(".");
    const bad = [
      "",
      "not encrypted",
      `v2.${iv}.${tag}.${ciphertext}`,
      `v1.${iv}.${tag}`,
      `v1.${iv}.${tag}.${ciphertext}.extra`,
      `v1.${iv}.${tag}.${ciphertext}==`,
      `v1.${iv}.${tag}.+/+/`,
      `v1.${iv.slice(0, -2)}.${tag}.${ciphertext}`,
      `v1.${iv}.${tag.slice(0, -2)}.${ciphertext}`,
    ];
    for (const payload of bad) {
      expectDecryptError(() => decryptWithKey(payload, key), "format");
    }
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptWithKey("value", randomBytes(16))).toThrow(TypeError);
    expect(() => decryptWithKey("v1.a.b.c", randomBytes(31))).toThrow(TypeError);
    expect(() => parseEncryptionKey(randomBytes(24).toString("base64"))).toThrow(TypeError);
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true);
  });
});

describe("encryptSecret and decryptSecret", () => {
  beforeEach(() => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("use TOKEN_ENCRYPTION_KEY", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key.toString("base64"));
    const payload = encryptSecret("refresh-token");
    expect(decryptSecret(payload)).toBe("refresh-token");
    expect(decryptWithKey(payload, key)).toBe("refresh-token");
  });

  it("throw MissingEnvError when the key is missing", () => {
    expect(() => encryptSecret("refresh-token")).toThrow(MissingEnvError);
    expect(() => decryptSecret("v1.a.b.c")).toThrow(MissingEnvError);
    expect(() => encryptSecret("refresh-token")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("throw InvalidEnvError when the key has the wrong size", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(16).toString("base64"));
    expect(() => encryptSecret("refresh-token")).toThrow(InvalidEnvError);
  });

  it("cannot decrypt a value written under a rotated key", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key.toString("base64"));
    const payload = encryptSecret("refresh-token");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", otherKey.toString("base64"));
    expectDecryptError(() => decryptSecret(payload), "authentication");
  });
});
