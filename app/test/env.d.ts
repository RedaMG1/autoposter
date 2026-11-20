// Bindings available as `env` from "cloudflare:test"
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    WORKER_TOKEN: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
