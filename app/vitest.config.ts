import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            WORKER_TOKEN: "test-token",
            APP_PASSWORD: "test-password",
            SESSION_KEY: "test-session-key",
            TOKEN_KEY: "test-token-key",
            PUBLIC_URL: "https://app.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
