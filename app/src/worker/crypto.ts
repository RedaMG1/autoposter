// Small crypto helpers on WebCrypto: HMAC signing and AES-GCM for stored tokens.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
}

/** Constant-time check of an HMAC signature. */
export async function verify(secret: string, data: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(data));
  } catch {
    return false;
  }
}

/** Constant-time string compare (compares HMACs of both sides). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const k = "compare";
  return (await sign(k, a)) === (await sign(k, b)) && a.length === b.length;
}

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptJson<T>(secret: string, box: string): Promise<T> {
  const [iv, ct] = box.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(secret), fromB64url(ct));
  return JSON.parse(dec.decode(pt)) as T;
}
