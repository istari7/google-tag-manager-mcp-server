import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";
import { TEST_SECRETS } from "./test/helpers/secrets.ts";

const WRANGLER_CONFIG = "./wrangler.jsonc";

// The plugin reads bindings from wrangler.jsonc the way `wrangler dev` does, which includes
// a local .dev.vars when one exists (it logs "Using secrets defined in .dev.vars"; the plugin
// has no option to skip it). Whatever .dev.vars sets, every binding the Worker reads is pinned
// here: the vars to their wrangler.jsonc values, the secrets to the test-only TEST_SECRETS
// (which cover every secret in .dev.vars.example). `miniflare.bindings` win over the plugin's,
// so tests behave the same with or without a .dev.vars and never see real credentials.
const { vars } = unstable_readConfig({ config: WRANGLER_CONFIG });

// A secret added to .dev.vars.example without a test value would otherwise come from .dev.vars.
const secretNames = readFileSync(join(import.meta.dirname, ".dev.vars.example"), "utf8")
	.split(/\r?\n/)
	.map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
	.filter((name) => name !== undefined);
const untested = secretNames.filter((name) => !(name in TEST_SECRETS));
if (untested.length > 0) throw new Error(`Add test values for ${untested.join(", ")} to test/helpers/secrets.ts`);

export default defineConfig({
	plugins: [
		// Tests run inside workerd with the bindings from wrangler.jsonc (KV, rate limiters, vars).
		cloudflareTest({
			wrangler: { configPath: WRANGLER_CONFIG },
			miniflare: { bindings: { ...vars, ...TEST_SECRETS } },
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
	},
});
