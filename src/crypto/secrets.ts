import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Upstream API tokens are stored AES-256-GCM encrypted with a key derived from APP_SECRET, so a
// copy of the database alone doesn't leak them.
export class Secrets {
  private readonly key: Buffer;
  readonly cookieSecret: string;

  constructor(appSecret: string) {
    this.key = scryptSync(appSecret, "relay:secrets:v1", 32);
    this.cookieSecret = scryptSync(appSecret, "relay:cookie:v1", 32).toString("hex");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }

  decrypt(stored: string): string {
    if (!stored.startsWith("v1:")) throw new Error("Unknown secret format");
    const buf = Buffer.from(stored.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    try {
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    } catch {
      throw new Error("Couldn't decrypt a stored token. Has APP_SECRET changed? Re-enter the token on the source.");
    }
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}

/** A new endpoint API key. Only its hash is stored; the key is shown once. */
export function newApiKey(): { key: string; hash: string; hint: string } {
  const key = "rly_" + randomBytes(24).toString("base64url");
  return { key, hash: sha256(key), hint: key.slice(-4) };
}
