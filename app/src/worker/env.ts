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
}
