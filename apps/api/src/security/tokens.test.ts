import { describe, expect, it } from "vitest";
import { decryptRefreshToken, encryptRefreshToken, hashToken } from "./tokens.js";
import type { ApiConfig } from "../config.js";

const config = { tokenEncryptionKeys: new Map([[1, Buffer.alloc(32, 1)], [2, Buffer.alloc(32, 2)]]), currentKeyVersion: 2 } as ApiConfig;

describe("refresh token encryption", () => {
  it("round trips with the recorded rotation version", () => {
    const encrypted = encryptRefreshToken("provider-secret", config);
    expect(encrypted.keyVersion).toBe(2);
    expect(encrypted.ciphertext).not.toContain("provider-secret");
    expect(decryptRefreshToken(encrypted.ciphertext, encrypted.keyVersion, config)).toBe("provider-secret");
  });

  it("decrypts credentials written before key rotation", () => {
    const oldConfig = { ...config, currentKeyVersion: 1 };
    const encrypted = encryptRefreshToken("rotating-secret", oldConfig);
    expect(decryptRefreshToken(encrypted.ciphertext, encrypted.keyVersion, config)).toBe("rotating-secret");
  });

  it("stores only a one-way session digest", () => expect(hashToken("opaque-session")).not.toContain("opaque-session"));
});
