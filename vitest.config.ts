import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_SECRETS } from "./test/helpers/secrets.ts";

export default defineConfig({
	plugins: [
		// Tests run inside workerd with the bindings from wrangler.jsonc (KV, rate limiters,
		// vars). `miniflare.bindings` adds test-only secrets, so no .dev.vars is needed.
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: { bindings: { ...TEST_SECRETS } },
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		// Fails the run when the skills manifest is stale (`pnpm gen:skills`).
		globalSetup: ["./test/global-setup.ts"],
		testTimeout: 60_000,
	},
});
