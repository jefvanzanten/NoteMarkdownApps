import "dotenv/config";
import { z } from "zod";

const EnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  PUBLIC_ORIGIN: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEYS: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface ApiConfig {
  databaseUrl: string;
  publicOrigin: string;
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKeys: Map<number, Buffer>;
  currentKeyVersion: number;
  port: number;
  secureCookies: boolean;
}

/**
 * Parses versioned base64 AES keys from deployment configuration.
 * @param source Comma-separated version:key values.
 * @returns Valid key ring and highest active key version.
 */
function parseKeyRing(source: string): Pick<ApiConfig, "tokenEncryptionKeys" | "currentKeyVersion"> {
  const entries = source.split(",").map((part) => part.trim().split(":"));
  const keys = new Map(entries.map(([version, encoded]) => [Number(version), Buffer.from(encoded ?? "", "base64")]));
  if ([...keys].some(([version, key]) => !Number.isInteger(version) || version < 1 || key.length !== 32)) throw new Error("TOKEN_ENCRYPTION_KEYS must contain version:base64-32-byte-key values.");
  return { tokenEncryptionKeys: keys, currentKeyVersion: Math.max(...keys.keys()) };
}

/**
 * Validates process environment and returns safe API configuration.
 * @returns Validated API configuration.
 */
export function loadConfig(): ApiConfig {
  const environment = EnvironmentSchema.parse(process.env);
  return {
    databaseUrl: environment.DATABASE_URL,
    publicOrigin: environment.PUBLIC_ORIGIN.replace(/\/$/, ""),
    googleClientId: environment.GOOGLE_CLIENT_ID,
    googleClientSecret: environment.GOOGLE_CLIENT_SECRET,
    port: environment.PORT,
    secureCookies: environment.NODE_ENV !== "development",
    ...parseKeyRing(environment.TOKEN_ENCRYPTION_KEYS),
  };
}
