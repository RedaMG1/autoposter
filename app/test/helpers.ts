import { SELF } from "cloudflare:test";

export const WORKER = { authorization: "Bearer test-token", "content-type": "application/json" };

let cookie: string | null = null;

/** Log in once per test file and reuse the session cookie. */
export async function session(): Promise<string> {
  if (cookie) return cookie;
  const r = await SELF.fetch("https://app.test/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }),
  });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  cookie = r.headers.get("set-cookie")!.split(";")[0];
  return cookie;
}

/** Call the app as the logged-in user. */
export async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!path.startsWith("/api/worker/")) headers.set("cookie", await session());
  return SELF.fetch(`https://app.test${path}`, { ...init, headers });
}
