// Drives the Worker through its public HTTP surface, like a browser plus an MCP client would.
// Requests go through `exports.default.fetch()`, i.e. src/index.ts with the real
// OAuthProvider, KV and rate limiters.

import { exports } from "cloudflare:workers";
import { expect } from "vitest";

export const ORIGIN = "https://gtm-mcp.test";
export const CLIENT_REDIRECT = "https://client.example/callback";

let ipCounter = 0;
/**
 * A fresh client IP. Each test uses its own, so the per-IP rate limiters (which persist for
 * the whole test run) never trip unless a test means them to.
 */
export function freshIp(): string {
	ipCounter++;
	return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function workerFetch(path: string, init: RequestInit = {}, ip = freshIp()): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", ip);
	const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
	return exports.default.fetch(new Request(url, { ...init, headers, redirect: "manual" }));
}

/** Minimal cookie jar: enough for the library's __Host- binding and approval cookies. */
export class Browser {
	readonly cookies = new Map<string, string>();
	constructor(readonly ip = freshIp()) {}

	cookieHeader(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}

	async fetch(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.cookies.size && !headers.has("Cookie")) headers.set("Cookie", this.cookieHeader());
		const res = await workerFetch(path, { ...init, headers }, this.ip);
		for (const line of res.headers.getSetCookie()) {
			const [pair = "", ...attrs] = line.split(";");
			const eq = pair.indexOf("=");
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			const cleared = attrs.some((a) => a.trim().toLowerCase() === "max-age=0");
			if (cleared) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
		return res;
	}
}

export interface Client {
	clientId: string;
	redirectUri: string;
}

/** Dynamic client registration as a public client (no secret: PKCE is mandatory). */
export async function registerClient(name = "Test Client", redirectUri = CLIENT_REDIRECT): Promise<Client> {
	const res = await workerFetch("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: name,
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		}),
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { client_id: string };
	return { clientId: body.client_id, redirectUri };
}

function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizePath(
	client: Client,
	params: { challenge?: string; method?: string; state?: string; redirectUri?: string } = {},
): string {
	const q = new URLSearchParams({
		response_type: "code",
		client_id: client.clientId,
		redirect_uri: params.redirectUri ?? client.redirectUri,
		state: params.state ?? "client-state",
		resource: `${ORIGIN}/mcp`,
	});
	if (params.challenge !== undefined) q.set("code_challenge", params.challenge);
	if (params.method !== undefined) q.set("code_challenge_method", params.method);
	return `/authorize?${q}`;
}

/** Pulls the consent form's hidden handle out of the page. */
export function consentHandle(html: string): string {
	const match = html.match(/name="handle" value="([^"]+)"/);
	if (!match?.[1]) throw new Error("No consent handle on page");
	return match[1];
}

export function postConsent(browser: Browser, handle: string, decision: "approve" | "deny", cookie?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (cookie !== undefined) headers.Cookie = cookie;
	return browser.fetch("/authorize", {
		method: "POST",
		headers,
		body: new URLSearchParams({ handle, decision }).toString(),
	});
}

export interface StartedLogin {
	browser: Browser;
	client: Client;
	verifier: string;
	/** The `state` we sent to Google. */
	googleState: string;
	/** The full Google authorize URL we were redirected to. */
	googleUrl: URL;
}

/** GET /authorize → consent page → approve → redirected to Google. */
export async function startLogin(client?: Client, browser = new Browser()): Promise<StartedLogin> {
	const c = client ?? (await registerClient());
	const { verifier, challenge } = await pkce();
	const page = await browser.fetch(authorizePath(c, { challenge, method: "S256" }));
	expect(page.status).toBe(200);
	const approved = await postConsent(browser, consentHandle(await page.text()), "approve");
	expect(approved.status).toBe(302);
	const googleUrl = new URL(approved.headers.get("Location") ?? "");
	expect(googleUrl.origin).toBe("https://accounts.google.com");
	return { browser, client: c, verifier, googleState: googleUrl.searchParams.get("state") ?? "", googleUrl };
}

export function callbackPath(state: string | null, code = "google-auth-code"): string {
	const q = new URLSearchParams({ code });
	if (state !== null) q.set("state", state);
	return `/callback?${q}`;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	error?: string;
}

export async function tokenRequest(form: Record<string, string>, ip = freshIp()) {
	const res = await workerFetch(
		"/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
		},
		ip,
	);
	return { res, body: (await res.json()) as TokenResponse };
}

/**
 * Full login: consent, Google callback (Google's token endpoint must already be mocked),
 * then the MCP client's code exchange. Returns our MCP tokens.
 */
export async function login(client?: Client): Promise<TokenResponse & { login: StartedLogin }> {
	const started = await startLogin(client);
	const cb = await started.browser.fetch(callbackPath(started.googleState));
	expect(cb.status).toBe(302);
	const back = new URL(cb.headers.get("Location") ?? "");
	expect(`${back.origin}${back.pathname}`).toBe(started.client.redirectUri);
	expect(back.searchParams.get("state")).toBe("client-state");
	const code = back.searchParams.get("code");
	expect(code).toBeTruthy();
	const { res, body } = await tokenRequest({
		grant_type: "authorization_code",
		code: code as string,
		redirect_uri: started.client.redirectUri,
		client_id: started.client.clientId,
		code_verifier: started.verifier,
		resource: `${ORIGIN}/mcp`,
	});
	expect(res.status).toBe(200);
	return { ...body, login: started };
}

export function refresh(client: Client, refreshToken: string) {
	return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId });
}

/** One JSON-RPC request to /mcp. Accepts JSON or SSE responses. */
export async function mcpRequest(accessToken: string | null, method: string, params: unknown = {}) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
	const res = await workerFetch("/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res;
}

export async function mcpResult(res: Response): Promise<{ result?: unknown; error?: unknown }> {
	const text = await res.text();
	if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.at(-1);
		return JSON.parse(data ?? "{}");
	}
	return JSON.parse(text);
}

export async function callTool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
	const res = await mcpRequest(accessToken, "tools/call", { name, arguments: args });
	expect(res.status).toBe(200);
	const { result } = await mcpResult(res);
	return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}
