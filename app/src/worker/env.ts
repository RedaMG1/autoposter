export interface Env {
  DB: D1Database;
  /** optional: only when videos are stored in R2 instead of on the PC */
  MEDIA?: R2Bucket;
  ASSETS: Fetcher;
  TIMEZONE: string;
  /** https://... address of the deployed app (used for OAuth redirects and video links) */
  PUBLIC_URL: string;
  // secrets
  WORKER_TOKEN: string; // shared with the PC worker
  APP_PASSWORD: string; // your login password for the app
  SESSION_KEY: string; // signs login cookies and video links
  TOKEN_KEY: string; // encrypts platform tokens in the database
  /** Meta app id and Facebook Login for Business configuration id (not secret) */
  IG_APP_ID?: string;
  IG_CONFIG_ID?: string;
  /** Instagram professional account id (Business Suite > Instagram accounts), used if the token does not list it */
  IG_USER_ID?: string;
  IG_APP_SECRET?: string; // secret
  /** Google OAuth client for YouTube (the secret is a Cloudflare secret) */
  YT_CLIENT_ID?: string;
  YT_CLIENT_SECRET?: string;
  /** public | unlisted | private (Google locks API uploads to private until the app is verified) */
  YT_PRIVACY?: string;
  /** TikTok developer app (the secret is a Cloudflare secret) */
  TT_CLIENT_KEY?: string;
  TT_CLIENT_SECRET?: string;
  /** wanted TikTok privacy; falls back to what TikTok allows (SELF_ONLY until the app is audited) */
  TT_PRIVACY?: string;
}
