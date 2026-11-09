// Mocking outbound fetch to Google.
//
// Choice: `vi.spyOn(globalThis, "fetch")`. The old `fetchMock` export of `cloudflare:test`
// is gone from @cloudflare/vitest-plugin (the renamed vitest-pool-workers), and its docs say
// the `main` Worker runs in the same isolate as the tests, "so any global mocks will apply to
// it too". Spying on fetch therefore intercepts every request the Worker makes, including
// ones made through `exports.default.fetch()`. `outboundService` would also work, but it is
// fixed per project in vitest.config.ts and can't be changed per test.
//
// Every unmatched outbound request fails the test: nothing ever reaches the network.

import { vi } from "vitest";
import { TEST_SECRETS } from "./secrets";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface RecordedCall {
	url: string;
	method: string;
	/** Form fields for form-encoded bodies. */
	form: Record<string, string>;
	/** The raw request body ("" when there is none). */
	body: string;
	headers: Headers;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

/**
 * Replaces global fetch for this test. `routes` maps an exact URL (without query) to a handler.
 * Returns the recorded calls. Restore with `vi.restoreAllMocks()` (done in afterEach by tests).
 */
export function mockFetch(routes: Record<string, Route>) {
	const calls: RecordedCall[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const key = `${url.origin}${url.pathname}`;
		const text = request.body ? new TextDecoder().decode(await request.arrayBuffer()) : "";
		const call: RecordedCall = {
			url: request.url,
			method: request.method,
			form: request.headers.get("Content-Type")?.includes("x-www-form-urlencoded")
				? Object.fromEntries(new URLSearchParams(text))
				: {},
			body: text,
			headers: request.headers,
		};
		calls.push(call);
		const route = routes[key];
		if (!route) throw new Error(`Unexpected outbound fetch in test: ${request.method} ${key}`);
		return route(call);
	});
	return { calls, spy, to: (url: string) => calls.filter((c) => c.url.split("?")[0] === url) };
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export interface IdTokenOverrides {
	email?: string;
	email_verified?: boolean;
	hd?: string;
	name?: string;
	aud?: string;
	iss?: string;
	exp?: number;
}

function base64url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned Google-shaped ID token. The Worker reads claims without checking signatures. */
export function idToken(overrides: IdTokenOverrides = {}): string {
	const claims = {
		iss: "https://accounts.google.com",
		aud: TEST_SECRETS.GOOGLE_CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 3600,
		email: "owner@example.com",
		email_verified: true,
		name: "Owner",
		...overrides,
	};
	return `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.fake-signature`;
}

export interface GoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	id_token?: string;
}

/** A successful Google code-exchange response. */
export function googleCodeResponse(overrides: GoogleTokenResponse & { claims?: IdTokenOverrides } = {}): Response {
	const { claims, ...rest } = overrides;
	return json({
		access_token: "ya29.google-access-1",
		refresh_token: "1//google-refresh-1",
		expires_in: 3599,
		token_type: "Bearer",
		scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/tagmanager.readonly",
		id_token: idToken(claims),
		...rest,
	});
}
