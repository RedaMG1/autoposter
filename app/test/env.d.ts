// Bindings available as `env` from "cloudflare:test"
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    WORKER_TOKEN: string;
    APP_PASSWORD: string;
    SESSION_KEY: string;
    TOKEN_KEY: string;
    PUBLIC_URL: string;
    TIMEZONE: string;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
