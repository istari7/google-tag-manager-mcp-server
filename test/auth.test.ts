// Security checklist, driven through the Worker's public HTTP surface with
// Google's token endpoint mocked. Refresh/TTL items: auth-refresh.test.ts. Body and rate
// limits: auth-limits.test.ts.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOOGLE_REVOKE_URL,
	GOOGLE_TOKEN_URL,
	googleCodeResponse,
	type IdTokenOverrides,
	json,
	mockFetch,
} from "./helpers/google";
import {
	authorizePath,
	Browser,
	CLIENT_REDIRECT,
	callbackPath,
	callTool,
	consentHandle,
	login,
	mcpRequest,
	ORIGIN,
	pkce,
	postConsent,
	registerClient,
	startLogin,
	tokenRequest,
	workerFetch,
} from "./helpers/oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Google token endpoint returns a code-exchange response for the given ID token claims. */
function mockGoogle(claims: IdTokenOverrides = {}) {
	return mockFetch({
		[GOOGLE_TOKEN_URL]: () => googleCodeResponse({ claims }),
		[GOOGLE_REVOKE_URL]: () => new Response("", { status: 200 }),
	});
}

async function grantKeys(email: string): Promise<string[]> {
	const list = await env.OAUTH_KV.list({ prefix: `grant:${email}:` });
	return list.keys.map((k) => k.name);
}

describe("full login flow", () => {
	it("issues MCP tokens after consent + Google sign-in and serves tools with them", async () => {
		const google = mockGoogle();
		const tokens = await login();
		expect(tokens.token_type.toLowerCase()).toBe("bearer");
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();

		// Google code exchange used our client credentials, the callback URI and a PKCE verifier.
		const [exchange] = google.to(GOOGLE_TOKEN_URL);
		expect(exchange?.form).toMatchObject({
			grant_type: "authorization_code",
			code: "google-auth-code",
			client_id: "test-client-id.apps.googleusercontent.com",
			redirect_uri: `${ORIGIN}/callback`,
		});
		expect(exchange?.form.code_verifier).toMatch(/^[\w-]{43}$/);
		// ...matching the S256 challenge sent to Google.
		const sent = tokens.login.googleUrl.searchParams;
		expect(sent.get("code_challenge_method")).toBe("S256");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange?.form.code_verifier));
		const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(sent.get("code_challenge")).toBe(challenge);
		expect(sent.get("access_type")).toBe("offline");

		const ping = await callTool(tokens.access_token, "ping");
		expect(ping.content[0]?.text).toBe("pong");
	});
});

describe("PKCE", () => {
	it("refuses an authorization request without code_challenge", async () => {
		const client = await registerClient();
		const res = await workerFetch(authorizePath(client));
		// The client and redirect URI are valid, so the error goes back to the client.
		expect(res.status).toBe(302);
		const back = new URL(res.headers.get("Location") ?? "");
		expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("error")).toBe("invalid_request");
		expect(back.searchParams.has("code")).toBe(false);
	});

	it("refuses the plain code_challenge_method", async () => {
		const client = await registerClient();
		const res = await workerFetch(authorizePath(client, { challenge: "a".repeat(43), method: "plain" }));
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("Location") ?? "").searchParams.get("error")).toBe("invalid_request");
	});

	it("refuses a code exchange with the wrong code_verifier", async () => {
		mockGoogle();
		const started = await startLogin();
		const cb = await started.browser.fetch(callbackPath(started.googleState));
		const code = new URL(cb.headers.get("Location") ?? "").searchParams.get("code") ?? "";
		const wrong = await pkce();
		const { res, body } = await tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: started.client.redirectUri,
			client_id: started.client.clientId,
			code_verifier: wrong.verifier,
		});
		expect(res.status).toBe(400);
		expect(body.error).toBe("invalid_grant");
		expect(body.access_token).toBeUndefined();
	});
});

describe("/callback rejections", () => {
	it("rejects a missing state", async () => {
		const google = mockGoogle();
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath(null));
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("rejects an unknown state", async () => {
		const google = mockGoogle();
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath("not-a-real-state"));
		expect(res.status).toBe(400);
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("rejects a reused state, even with the original cookie", async () => {
		const google = mockGoogle();
		const started = await startLogin();
		const cookie = started.browser.cookieHeader();
		const first = await started.browser.fetch(callbackPath(started.googleState));
		expect(first.status).toBe(302);
		const replay = await started.browser.fetch(callbackPath(started.googleState), { headers: { Cookie: cookie } });
		expect(replay.status).toBe(400);
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(1);
	});

	it("rejects a valid state without the browser's binding cookie", async () => {
		const google = mockGoogle();
		const started = await startLogin();
		const res = await new Browser().fetch(callbackPath(started.googleState));
		expect(res.status).toBe(400);
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("rejects a valid state with another browser's cookie", async () => {
		const google = mockGoogle();
		const victim = await startLogin();
		const attacker = await startLogin();
		// The attacker's browser (own cookies) presents the victim's state.
		const res = await attacker.browser.fetch(callbackPath(victim.googleState));
		expect(res.status).toBe(400);
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("rejects a state whose 10-minute transaction expired", async () => {
		const google = mockGoogle();
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const started = await startLogin();
		// The library stores consent/upstream transactions with a 600 s KV TTL...
		const transactionPuts = put.mock.calls.filter(([key]) => String(key).startsWith("transaction:"));
		expect(transactionPuts.length).toBeGreaterThan(0);
		for (const [, , options] of transactionPuts) expect(options).toMatchObject({ expirationTtl: 600 });
		// ...and binds them with a cookie that also dies after 10 minutes.
		const { challenge } = await pkce();
		const remembered = await started.browser.fetch(authorizePath(started.client, { challenge, method: "S256" }));
		expect(remembered.headers.getSetCookie().join("\n")).toMatch(/__Host-oauth-upstream-[^;]+;.*Max-Age=600/);
		// Simulate the expiry: miniflare can't fast-forward KV TTLs, so delete the rows.
		const rows = await env.OAUTH_KV.list({ prefix: "transaction:" });
		for (const key of rows.keys) await env.OAUTH_KV.delete(key.name);
		const res = await started.browser.fetch(callbackPath(started.googleState));
		expect(res.status).toBe(400);
		expect(google.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("sends Google's error back to the client as access_denied", async () => {
		mockGoogle();
		const started = await startLogin();
		const res = await started.browser.fetch(`/callback?state=${started.googleState}&error=access_denied`);
		expect(res.status).toBe(302);
		const back = new URL(res.headers.get("Location") ?? "");
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.has("code")).toBe(false);
	});
});

describe("consent page", () => {
	it("rejects a consent POST without the browser's cookie", async () => {
		const client = await registerClient();
		const browser = new Browser();
		const { challenge } = await pkce();
		const page = await browser.fetch(authorizePath(client, { challenge, method: "S256" }));
		const handle = consentHandle(await page.text());
		const forged = await postConsent(new Browser(), handle, "approve");
		expect(forged.status).toBe(400);
		expect(forged.headers.get("Location")).toBeNull();
		// The forged attempt didn't consume the handle's binding: the real browser still works.
		const real = await postConsent(browser, handle, "approve");
		expect(real.status).toBe(302);
	});

	it("is unframeable and bound to a __Host- cookie", async () => {
		const client = await registerClient();
		const { challenge } = await pkce();
		const res = await workerFetch(authorizePath(client, { challenge, method: "S256" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-oauth-consent-[^=]+=.*Secure.*HttpOnly/);
	});

	it("HTML-escapes the client name", async () => {
		const client = await registerClient(`<script>alert("x")</script><img src=x onerror=alert(1)>`);
		const { challenge } = await pkce();
		const res = await workerFetch(authorizePath(client, { challenge, method: "S256" }));
		const html = await res.text();
		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;");
	});

	it("Deny sends access_denied back to the client", async () => {
		const client = await registerClient();
		const browser = new Browser();
		const { challenge } = await pkce();
		const page = await browser.fetch(authorizePath(client, { challenge, method: "S256" }));
		const res = await postConsent(browser, consentHandle(await page.text()), "deny");
		expect(res.status).toBe(302);
		const back = new URL(res.headers.get("Location") ?? "");
		expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("error")).toBe("access_denied");
	});
});

describe("remembered approval cookie", () => {
	it("skips consent for the same client, but not for another client or a tampered cookie", async () => {
		mockGoogle();
		const started = await startLogin();
		const approvals = started.browser.cookies.get("__Host-oauth-approvals");
		expect(approvals).toBeTruthy();
		const { challenge } = await pkce();

		// Same client + redirect URI: straight to Google.
		const again = await started.browser.fetch(authorizePath(started.client, { challenge, method: "S256" }));
		expect(again.status).toBe(302);
		expect(new URL(again.headers.get("Location") ?? "").origin).toBe("https://accounts.google.com");

		// Another client in the same browser: the approval is bound to the client ID.
		const other = await registerClient("Other Client");
		const otherPage = await started.browser.fetch(authorizePath(other, { challenge, method: "S256" }));
		expect(otherPage.status).toBe(200);
		expect(await otherPage.text()).toContain('name="handle"');

		// Tampered signature: ignored, consent page shown again.
		const value = approvals as string;
		const [payload = "", signature = ""] = value.split(".");
		const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
		const tampered = `${payload}.${flipped}`;
		const forged = await workerFetch(authorizePath(started.client, { challenge, method: "S256" }), {
			headers: { Cookie: `__Host-oauth-approvals=${tampered}` },
		});
		expect(forged.status).toBe(200);
	});
});

describe("redirect URIs", () => {
	it("never redirects to an unregistered redirect_uri", async () => {
		const client = await registerClient();
		const { challenge } = await pkce();
		const res = await workerFetch(
			authorizePath(client, { challenge, method: "S256", redirectUri: "https://evil.example/callback" }),
		);
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
	});
});

describe("allowlist", () => {
	it("refuses a non-allowlisted email: 403 page, Google token revoked, no grant issued", async () => {
		const google = mockGoogle({ email: "stranger@gmail.com" });
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath(started.googleState));
		expect(res.status).toBe(403);
		expect(res.headers.get("Location")).toBeNull();
		const html = await res.text();
		expect(html).toContain("Access denied");
		expect(html).not.toContain("ya29.");
		await vi.waitFor(() => expect(google.to(GOOGLE_REVOKE_URL)).toHaveLength(1));
		// Revokes the refresh token, which also kills the access token.
		expect(google.to(GOOGLE_REVOKE_URL)[0]?.form).toEqual({ token: "1//google-refresh-1" });
		expect(await grantKeys("stranger@gmail.com")).toEqual([]);
	});

	it("requires email_verified even for an allowlisted email", async () => {
		mockGoogle({ email: "owner@example.com", email_verified: false });
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath(started.googleState));
		expect(res.status).toBe(403);
	});

	it("matches emails case-insensitively", async () => {
		mockGoogle({ email: "Owner@Example.com" });
		const tokens = await login();
		expect(tokens.access_token).toBeTruthy();
	});

	it("allows a Workspace domain via the hd claim", async () => {
		mockGoogle({ email: "someone@allowed.example", hd: "allowed.example" });
		const tokens = await login();
		expect(tokens.access_token).toBeTruthy();
		expect(await grantKeys("someone@allowed.example")).toHaveLength(1);
	});

	it("does not allow a domain by email suffix alone (no hd claim)", async () => {
		mockGoogle({ email: "consumer@allowed.example" });
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath(started.googleState));
		expect(res.status).toBe(403);
	});

	it("does not allow a different hd even with an allowed-looking email", async () => {
		mockGoogle({ email: "user@allowed.example", hd: "other.example" });
		const started = await startLogin();
		const res = await started.browser.fetch(callbackPath(started.googleState));
		expect(res.status).toBe(403);
	});
});

describe("/mcp", () => {
	it("answers 401 with a WWW-Authenticate challenge without a token", async () => {
		const res = await mcpRequest(null, "tools/list");
		expect(res.status).toBe(401);
		const challenge = res.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toMatch(/^Bearer /);
		expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
	});

	it("answers 401 for an unknown token", async () => {
		const res = await mcpRequest("owner@example.com:nope:nope", "tools/list");
		expect(res.status).toBe(401);
	});
});

describe("Google tokens stay inside props", () => {
	it("auth_status shows email and expiry, never tokens", async () => {
		mockGoogle();
		const tokens = await login();
		const result = await callTool(tokens.access_token, "auth_status");
		const text = result.content[0]?.text ?? "";
		const status = JSON.parse(text) as Record<string, unknown>;
		expect(status.email).toBe("owner@example.com");
		expect(typeof status.googleTokenExpiresAt).toBe("string");
		expect(Object.keys(status).sort()).toEqual(
			["email", "googleScopes", "googleTokenExpiresAt", "googleTokenExpiresInSeconds", "name"].sort(),
		);
		for (const secret of ["ya29.", "1//google", tokens.access_token, tokens.refresh_token]) {
			expect(text).not.toContain(secret);
		}
	});

	it("never logs Google or MCP tokens during login, denial or refresh", async () => {
		const logged: string[] = [];
		for (const level of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
			});
		}
		mockFetch({
			// Refreshes fail, so the Worker logs "google refresh failed".
			[GOOGLE_TOKEN_URL]: (call) =>
				call.form.grant_type === "refresh_token" ? json({ error: "backend_error" }, 500) : googleCodeResponse(),
		});
		const tokens = await login();
		await tokenRequest({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: tokens.login.client.clientId,
		});
		vi.restoreAllMocks();
		// The denial path logs a warning.
		const logged2 = logged.length;
		for (const level of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			});
		}
		mockGoogle({ email: "stranger@gmail.com" });
		const denied = await startLogin();
		await denied.browser.fetch(callbackPath(denied.googleState));

		expect(logged.length).toBeGreaterThan(logged2); // something was logged, so the check is real
		const all = logged.join("\n");
		for (const secret of [
			"ya29.",
			"google-refresh",
			"test-client-secret",
			"google-auth-code",
			tokens.access_token,
			tokens.refresh_token,
		]) {
			expect(all).not.toContain(secret);
		}
	});
});
