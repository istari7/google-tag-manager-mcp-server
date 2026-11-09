// The /setup page: presence checks without values, origin-derived URLs,
// client snippets, escaping and headers.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHandler, setupStatus } from "../src/auth/handler";
import { type SetupStatus, setupPage } from "../src/auth/pages";
import type { Env } from "../src/env";
import { ORIGIN, workerFetch } from "./helpers/oauth";
import { TEST_SECRETS } from "./helpers/secrets";

const PUBLISH = "https://www.googleapis.com/auth/tagmanager.publish";
const DELETE_CONTAINERS = "https://www.googleapis.com/auth/tagmanager.delete.containers";
const READONLY = "https://www.googleapis.com/auth/tagmanager.readonly";
const MANAGE_ACCOUNTS = "https://www.googleapis.com/auth/tagmanager.manage.accounts";
const MANAGE_USERS = "https://www.googleapis.com/auth/tagmanager.manage.users";

/** Calls the auth handler directly with some env values replaced. */
async function setupWith(overrides: Partial<Record<keyof Env, string>>, url = `${ORIGIN}/setup`): Promise<string> {
	const res = await authHandler.fetch(
		new Request(url),
		{ ...env, ...overrides } as unknown as Env,
		createExecutionContext(),
	);
	expect(res.status).toBe(200);
	return res.text();
}

/** Reverses escapeHtml, which only emits numeric entities. */
const decode = (html: string) => html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

/** The decoded text of every copyable snippet on the page. */
function snippets(html: string): string[] {
	return [...html.matchAll(/<pre data-copy><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decode(m[1] ?? ""));
}

function expectNoSecretValues(html: string) {
	for (const [name, value] of Object.entries(TEST_SECRETS)) {
		expect(html, `${name} value leaked`).not.toContain(value);
	}
	for (const part of TEST_SECRETS.ALLOWED_EMAILS.split(",")) expect(html).not.toContain(part);
}

const STATUS: SetupStatus = {
	googleClientId: "ok",
	googleClientSecret: true,
	cookieSecret: "ok",
	allowedEmails: true,
	allowedDomains: false,
	rateLimits: true,
	scopes: ["openid", READONLY],
	toolGroups: { groups: ["tags"], isDefault: false },
};

describe("/setup routing and headers", () => {
	it("serves the setup page at /setup and at /", async () => {
		const setup = await workerFetch("/setup");
		const home = await workerFetch("/");
		expect(setup.status).toBe(200);
		expect(home.status).toBe(200);
		expect(setup.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const strip = (s: string) => s.replace(/nonce-?[="]*[0-9a-f]{32}/g, "");
		expect(strip(await home.text())).toBe(strip(await setup.text()));
	});

	it("only allows its own nonce'd style and script, and can't be framed or cached", async () => {
		const res = await workerFetch("/setup");
		const html = await res.text();
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		const nonce = csp.match(/script-src 'nonce-([0-9a-f]{32})'/)?.[1];
		expect(nonce).toBeTruthy();
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("unsafe-inline");
		expect(html).toContain(`<script nonce="${nonce}">`);
		expect(html).toContain(`<style nonce="${nonce}">`);
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		const again = await workerFetch("/setup");
		expect(again.headers.get("Content-Security-Policy")).not.toContain(nonce);
	});

	it("does not answer other methods", async () => {
		const res = await workerFetch("/setup", { method: "POST" });
		expect(res.status).toBe(404);
	});
});

describe("/setup secret checks", () => {
	it("shows ready with every secret set, without any secret value", async () => {
		const html = await (await workerFetch("/setup")).text();
		expect(html).toContain("✅ Ready.");
		expect(html).not.toContain("❌");
		expect(html).toContain("✅ <code>GOOGLE_CLIENT_ID</code>: set");
		expect(html).toContain("✅ <code>GOOGLE_CLIENT_SECRET</code>: set");
		expect(html).toContain("✅ <code>COOKIE_SECRET</code>: set");
		expect(html).toContain("<code>ALLOWED_EMAILS</code> set, <code>ALLOWED_DOMAINS</code> set");
		expect(html).toContain("✅ Rate limiting: on");
		expectNoSecretValues(html);
	});

	it("marks every missing secret and says sign-in is refused", async () => {
		const html = await setupWith({
			GOOGLE_CLIENT_ID: "",
			GOOGLE_CLIENT_SECRET: "",
			COOKIE_SECRET: "",
			ALLOWED_EMAILS: "",
			ALLOWED_DOMAINS: "",
		});
		expect(html).toContain("❌ Not ready.");
		expect(html).toContain("❌ <code>GOOGLE_CLIENT_ID</code>: not set");
		expect(html).toContain("❌ <code>GOOGLE_CLIENT_SECRET</code>: not set");
		expect(html).toContain("❌ <code>COOKIE_SECRET</code>: not set");
		expect(html).toContain("❌ Sign-in allowlist:");
		expect(html).toContain("Every sign-in is refused until one is set.");
	});

	it("treats a whitespace-only allowlist as unset", async () => {
		const html = await setupWith({ ALLOWED_EMAILS: " , ", ALLOWED_DOMAINS: "" });
		expect(html).toContain("❌ Sign-in allowlist:");
		expect(html).toContain("❌ Not ready.");
	});

	it("is ready with only ALLOWED_DOMAINS", async () => {
		const html = await setupWith({ ALLOWED_EMAILS: "" });
		expect(html).toContain("✅ Ready.");
		expect(html).toContain("<code>ALLOWED_EMAILS</code> not set, <code>ALLOWED_DOMAINS</code> set");
	});

	it("flags a short cookie secret and an odd-looking client ID without echoing them", async () => {
		const html = await setupWith({ COOKIE_SECRET: "short-secret-value", GOOGLE_CLIENT_ID: "my-project-123456" });
		expect(html).toContain("❌ <code>COOKIE_SECRET</code>: too short");
		expect(html).toContain("⚠️ <code>GOOGLE_CLIENT_ID</code>: set, but it doesn't end in");
		expect(html).not.toContain("short-secret-value");
		expect(html).not.toContain("my-project-123456");
	});

	it("reports missing rate-limit bindings", async () => {
		expect(setupStatus(env).rateLimits).toBe(true);
		for (const binding of ["AUTH_RATE_LIMITER", "TOKEN_RATE_LIMITER", "MCP_RATE_LIMITER"]) {
			const status = setupStatus({ ...env, [binding]: undefined } as unknown as Env);
			expect(status.rateLimits, binding).toBe(false);
			const html = await setupPage(ORIGIN, status).text();
			expect(html).toContain("⚠️ Rate limiting: off");
			expect(html).toContain(`<code>${binding}</code>`);
		}
	});

	it("never puts secret values in the status object", () => {
		const serialized = JSON.stringify(setupStatus(env));
		for (const value of Object.values(TEST_SECRETS)) expect(serialized).not.toContain(value);
	});
});

describe("/setup URLs and client snippets", () => {
	it("derives the redirect URI and MCP URL from the request origin", async () => {
		const html = await (await workerFetch("https://gtm.example.dev/setup")).text();
		const all = snippets(html);
		expect(all).toContain("https://gtm.example.dev/callback");
		expect(all).toContain("https://gtm.example.dev/mcp");
		expect(html).not.toContain(ORIGIN);
	});

	it("has copy-paste config for Claude Code, Cursor and Gemini CLI", async () => {
		const all = snippets(await (await workerFetch("/setup")).text());
		const mcpUrl = `${ORIGIN}/mcp`;
		expect(all).toContain(`claude mcp add --transport http gtm ${mcpUrl}`);
		const json = all.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
		expect(json).toContainEqual({ mcpServers: { gtm: { url: mcpUrl } } });
		expect(json).toContainEqual({ mcpServers: { gtm: { httpUrl: mcpUrl } } });
	});

	it("explains the Claude web/desktop custom connector", async () => {
		const html = await (await workerFetch("/setup")).text();
		expect(html).toContain("Add custom connector");
	});

	it("names the tools that fail when an optional scope is missing", async () => {
		const without = await setupWith({ GOOGLE_SCOPES: READONLY });
		expect(without).toContain(`Without <code>${PUBLISH}</code>, publish_version will fail`);
		expect(without).toContain(
			`Without <code>${DELETE_CONTAINERS}</code>, delete_workspace and delete_container will fail`,
		);
		expect(without).toContain(`Without <code>${MANAGE_ACCOUNTS}</code>, get_account and update_account will fail`);
		expect(without).toContain(`Without <code>${MANAGE_USERS}</code>, list_user_permissions,`);
		const html = await setupWith({
			GOOGLE_SCOPES: `${READONLY} ${PUBLISH} ${DELETE_CONTAINERS} ${MANAGE_ACCOUNTS} ${MANAGE_USERS}`,
		});
		expect(html).not.toContain("Without <code>");
	});

	it("requests tagmanager.publish and delete.containers by default (wrangler.jsonc)", async () => {
		const html = await (await workerFetch("/setup")).text();
		expect(html).toContain(`<code>${PUBLISH}</code>`);
		expect(html).toContain(`<code>${DELETE_CONTAINERS}</code>`);
		expect(html).not.toContain("Without <code>");
	});

	it("lists the requested scopes, including the identity scopes", async () => {
		const html = await setupWith({ GOOGLE_SCOPES: READONLY });
		for (const scope of ["openid", "email", "profile", READONLY]) expect(html).toContain(`<code>${scope}</code>`);
	});

	it("notes that a local address can't be reached by Claude web", async () => {
		const html = await setupWith({}, "http://localhost:8787/setup");
		expect(snippets(html)).toContain("http://localhost:8787/callback");
		expect(html).toContain("This is a local address.");
		expect(html).not.toContain("loaded over http");
	});

	it("warns about plain http on a public host", async () => {
		const html = await setupWith({}, "http://gtm.example.dev/setup");
		expect(html).toContain("loaded over http");
	});
});

describe("/setup escaping", () => {
	it("escapes the origin everywhere, including inside the snippets", async () => {
		const evil = `https://x.example/"><script>alert(1)</script><img src=x onerror=alert(2)>`;
		const html = await setupPage(evil, STATUS).text();
		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<img");
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
		// Escaped, the snippets still decode to the exact config.
		const json = snippets(html)
			.filter((s) => s.startsWith("{"))
			.map((s) => JSON.parse(s));
		expect(json).toContainEqual({ mcpServers: { gtm: { url: `${evil}/mcp` } } });
	});

	it("escapes scopes from GOOGLE_SCOPES", async () => {
		const html = await setupPage(ORIGIN, { ...STATUS, scopes: ["<b>x</b>"] }).text();
		expect(html).not.toContain("<b>x</b>");
		expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
	});
});
