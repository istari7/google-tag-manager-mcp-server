// tokenExchangeCallback (src/auth/refresh.ts): Google token refresh on our refresh grant,
// failure mapping, and the access-token TTL clamp.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokenTtl } from "../src/auth/refresh";
import type { Env } from "../src/env";
import { GOOGLE_TOKEN_URL, googleCodeResponse, json, mockFetch, type Route } from "./helpers/google";
import { callTool, login, mcpRequest, refresh } from "./helpers/oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

const GTM_ACCOUNTS = "https://tagmanager.googleapis.com/tagmanager/v2/accounts";

/** Google's token endpoint: code exchanges succeed, refreshes go to `onRefresh`. */
function mockGoogle(onRefresh: Route, code: Parameters<typeof googleCodeResponse>[0] = {}) {
	return mockFetch({
		[GOOGLE_TOKEN_URL]: (call) =>
			call.form.grant_type === "refresh_token" ? onRefresh(call) : googleCodeResponse(code),
		[GTM_ACCOUNTS]: () => json({ account: [{ accountId: "1", name: "Sandbox", path: "accounts/1" }] }),
	});
}

describe("refresh grant", () => {
	it("gets a new Google token, keeps a rotated Google refresh token, and serves tools with it", async () => {
		let n = 0;
		const google = mockGoogle(() => {
			n++;
			return json({
				access_token: `ya29.google-access-r${n}`,
				// Google rotates only on the first refresh here.
				...(n === 1 ? { refresh_token: "1//google-refresh-rotated" } : {}),
				expires_in: 3599,
				scope: "openid https://www.googleapis.com/auth/tagmanager.readonly",
			});
		});
		const first = await login();
		const client = first.login.client;

		const r1 = await refresh(client, first.refresh_token);
		expect(r1.res.status).toBe(200);
		expect(r1.body.access_token).toBeTruthy();
		expect(r1.body.access_token).not.toBe(first.access_token);
		const refreshes = () => google.to(GOOGLE_TOKEN_URL).filter((c) => c.form.grant_type === "refresh_token");
		expect(refreshes()[0]?.form).toMatchObject({
			refresh_token: "1//google-refresh-1",
			client_id: "test-client-id.apps.googleusercontent.com",
			client_secret: "test-client-secret",
		});

		// The new MCP token carries the new Google access token.
		await callTool(r1.body.access_token, "list_accounts");
		expect(google.to(GTM_ACCOUNTS).at(-1)?.headers.get("Authorization")).toBe("Bearer ya29.google-access-r1");

		// Second refresh uses the rotated Google refresh token; Google didn't rotate again, so it is kept.
		const r2 = await refresh(client, r1.body.refresh_token ?? first.refresh_token);
		expect(r2.res.status).toBe(200);
		expect(refreshes()[1]?.form.refresh_token).toBe("1//google-refresh-rotated");
		const r3 = await refresh(client, r2.body.refresh_token ?? r1.body.refresh_token);
		expect(r3.res.status).toBe(200);
		expect(refreshes()[2]?.form.refresh_token).toBe("1//google-refresh-rotated");

		await callTool(r3.body.access_token, "list_accounts");
		expect(google.to(GTM_ACCOUNTS).at(-1)?.headers.get("Authorization")).toBe("Bearer ya29.google-access-r3");
	});

	it("maps Google invalid_grant to invalid_grant and revokes the grant", async () => {
		const google = mockGoogle(() =>
			json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
		);
		const tokens = await login();
		const { res, body } = await refresh(tokens.login.client, tokens.refresh_token);
		expect(res.status).toBe(400);
		expect(body.error).toBe("invalid_grant");
		expect(body.access_token).toBeUndefined();

		// The library revoked the whole grant: the old access token is dead too...
		expect((await mcpRequest(tokens.access_token, "tools/list")).status).toBe(401);
		// ...and the refresh token no longer reaches Google.
		const before = google.calls.length;
		const again = await refresh(tokens.login.client, tokens.refresh_token);
		expect(again.body.error).toBe("invalid_grant");
		expect(google.calls.length).toBe(before);
	});

	it.each([
		["a Google 5xx", () => json({ error: "backend_error" }, 500)],
		["a Google network failure", () => Promise.reject(new TypeError("Network connection lost"))],
	] as Array<[string, Route]>)("maps %s to temporarily_unavailable and keeps the grant", async (_label, failure) => {
		let failing = true;
		mockGoogle((call) =>
			failing ? failure(call) : json({ access_token: "ya29.after-outage", expires_in: 3599, scope: "openid" }),
		);
		const tokens = await login();
		const { res, body } = await refresh(tokens.login.client, tokens.refresh_token);
		expect(res.status).toBe(503);
		expect(body.error).toBe("temporarily_unavailable");

		// The grant survived: once Google is back, the same refresh token works.
		failing = false;
		const retry = await refresh(tokens.login.client, tokens.refresh_token);
		expect(retry.res.status).toBe(200);
		expect(retry.body.access_token).toBeTruthy();
	});
});

describe("access token TTL clamp", () => {
	const testEnv = (ttl?: string) => ({ ...env, ACCESS_TOKEN_TTL_SECONDS: ttl }) as unknown as Env;
	const inSeconds = (s: number) => Date.now() + s * 1000;

	it("caps at ACCESS_TOKEN_TTL_SECONDS", () => {
		expect(accessTokenTtl(testEnv("3000"), inSeconds(3600))).toBe(3000);
		expect(accessTokenTtl(testEnv("600"), inSeconds(3600))).toBe(600);
	});

	it("defaults to 3000 when unset or invalid", () => {
		expect(accessTokenTtl(testEnv(undefined), inSeconds(7200))).toBe(3000);
		expect(accessTokenTtl(testEnv("nope"), inSeconds(7200))).toBe(3000);
	});

	it("ends 300 s before Google's token expires", () => {
		expect(accessTokenTtl(testEnv("3000"), inSeconds(1000))).toBe(700);
	});

	it("never goes below 60 s", () => {
		expect(accessTokenTtl(testEnv("3000"), inSeconds(200))).toBe(60);
		expect(accessTokenTtl(testEnv("3000"), inSeconds(-100))).toBe(60);
	});

	it("is applied to code and refresh grants at /token", async () => {
		mockGoogle(() => json({ access_token: "ya29.short", expires_in: 200, scope: "openid" }), { expires_in: 1000 });
		const tokens = await login();
		// Google: 1000 s left → ours 700 s (allow a second of clock drift).
		expect(tokens.expires_in).toBeGreaterThanOrEqual(699);
		expect(tokens.expires_in).toBeLessThanOrEqual(700);
		const { body } = await refresh(tokens.login.client, tokens.refresh_token);
		expect(body.expires_in).toBe(60);
	});
});
