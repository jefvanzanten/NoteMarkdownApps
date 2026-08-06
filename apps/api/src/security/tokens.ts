import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ApiConfig } from "../config.js";

/** Encodes cryptographically random bytes for URL-safe opaque values. @param bytes Entropy byte count. @returns URL-safe random value. */
export function randomToken(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }

/** Hashes an opaque secret before durable storage. @param value Secret token. @returns Hex SHA-256 digest. */
export function hashToken(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Creates a PKCE S256 challenge. @param verifier OAuth verifier. @returns URL-safe challenge. */
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }

/**
 * Envelope-encrypts a provider refresh token with the current deployment key.
 * @param plaintext Provider credential.
 * @param config Versioned encryption key ring.
 * @returns Ciphertext and key version for later rotation.
 */
export function encryptRefreshToken(plaintext: string, config: ApiConfig): { ciphertext: string; keyVersion: number } {
  const key = config.tokenEncryptionKeys.get(config.currentKeyVersion)!;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64"), keyVersion: config.currentKeyVersion };
}

/**
 * Decrypts a refresh token using its recorded key version.
 * @param ciphertext Encoded nonce, tag, and encrypted token.
 * @param keyVersion Encryption key version.
 * @param config Available deployment key ring.
 * @returns Plain provider refresh token.
 */
export function decryptRefreshToken(ciphertext: string, keyVersion: number, config: ApiConfig): string {
  const key = config.tokenEncryptionKeys.get(keyVersion);
  if (!key) throw new Error(`Refresh-token key version ${keyVersion} is unavailable.`);
  const payload = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}
