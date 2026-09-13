import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "@/lib/env";

// Format: v1.<iv>.<tag>.<ciphertext>, each part base64url. AES-256-GCM with a random
// 12-byte IV and a 16-byte tag. The version prefix is bound as additional data.

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class DecryptError extends Error {
  readonly reason: "format" | "authentication";

  constructor(reason: "format" | "authentication") {
    super(reason === "format" ? "Encrypted value has an unknown format" : "Encrypted value failed authentication");
    this.name = "DecryptError";
    this.reason = reason;
  }
}

export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new TypeError("Encryption key must be 32 bytes");
  }
  return key;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new TypeError("Encryption key must be 32 bytes");
  }
}

export function encryptWithKey(plaintext: string, key: Uint8Array): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(VERSION, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decodePart(part: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(part)) {
    throw new DecryptError("format");
  }
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) {
    throw new DecryptError("format");
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new DecryptError("format");
  }
  return bytes;
}

export function decryptWithKey(payload: string, key: Uint8Array): string {
  assertKey(key);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptError("format");
  }
  const iv = decodePart(parts[1], IV_BYTES);
  const tag = decodePart(parts[2], TAG_BYTES);
  const ciphertext = decodePart(parts[3]);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(VERSION, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptError("authentication");
  }
}

// Encrypts with TOKEN_ENCRYPTION_KEY. Throws MissingEnvError when it is not set.
export function encryptSecret(plaintext: string): string {
  return encryptWithKey(plaintext, parseEncryptionKey(requireEnv("tokenEncryption").key));
}

// Decrypts with TOKEN_ENCRYPTION_KEY. Throws MissingEnvError when it is not set and
// DecryptError when the value is malformed, tampered with, or from another key.
export function decryptSecret(payload: string): string {
  return decryptWithKey(payload, parseEncryptionKey(requireEnv("tokenEncryption").key));
}
