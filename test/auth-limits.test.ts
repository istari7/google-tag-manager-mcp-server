// Per-IP rate limits and request body caps applied in src/index.ts before the OAuth
// provider (src/auth/limits.ts, wrangler.jsonc `ratelimits`).

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT, limitBody, MCP_BODY_LIMIT, rateLimit } from "../src/auth/limits";
import type { Env } from "../src/env";
import worker from "../src/index";
import { freshIp, ORIGIN, workerFetch } from "./helpers/oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

// Must match wrangler.jsonc.
const AUTH_LIMIT = 30;
const TOKEN_LIMIT = 120;
const MCP_LIMIT = 300;

async function hammer(path: string, ip: string, times: number, init: RequestInit = {}): Promise<number[]> {
	const statuses: number[] = [];
	for (let i = 0; i < times; i++) statuses.push((await workerFetch(path, init, ip)).status);
	return statuses;
}

/** Both limiters use a 60 s period (wrangler.jsonc). */
const WINDOW_MS = 60_000;
/** Clock skew allowed between this isolate and the limiter's Durable Object. */
const EDGE_MS = 500;

/**
 * Miniflare's simple rate limiter counts in fixed windows aligned to the wall clock
 * (`floor(now / period)`), so a burst that straddles a minute boundary is split across two
 * counters and never reaches the limit. That made these tests flaky (a 401 where a 429 was
 * due). Run the burst with a fresh IP and keep the first attempt that stayed inside one
 * window, away from its edges; a burst takes seconds, so at most one retry is needed.
 */
async function inOneWindow<T>(burst: (ip: string) => Promise<T>): Promise<T> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const start = Date.now();
		const result = await burst(freshIp());
		const end = Date.now();
		const sameWindow = Math.floor(start / WINDOW_MS) === Math.floor(end / WINDOW_MS);
		if (sameWindow && start % WINDOW_MS >= EDGE_MS && WINDOW_MS - (end % WINDOW_MS) >= EDGE_MS) return result;
	}
	throw new Error("Could not run the burst inside one rate-limit window in 3 attempts.");
}

describe("rate limiting", () => {
	it("limits /authorize, /callback and /register per IP with a 429 and Retry-After", async () => {
		const { ip, statuses, limited, others, token } = await inOneWindow(async (ip) => {
			const statuses = await hammer("/register", ip, AUTH_LIMIT, { method: "POST" });
			const limited = await workerFetch("/register", { method: "POST" }, ip);
			// The auth limiter is shared by /authorize, /callback and /register.
			const others: number[] = [];
			for (const path of ["/authorize", "/callback"]) others.push((await workerFetch(path, {}, ip)).status);
			// /token has its own limiter (TOKEN_RATE_LIMITER).
			const token = (await workerFetch("/token", { method: "POST" }, ip)).status;
			return { ip, statuses, limited, others, token };
		});
		expect(statuses).not.toContain(429);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toMatchObject({ error: "too_many_requests" });
		expect(others).toEqual([429, 429]);
		expect(token).not.toBe(429);

		// Other IPs, /mcp and discovery are unaffected.
		expect((await workerFetch("/register", { method: "POST" })).status).not.toBe(429);
		expect((await workerFetch("/mcp", { method: "POST" }, ip)).status).toBe(401);
		expect((await workerFetch("/.well-known/oauth-authorization-server", {}, ip)).status).toBe(200);
	});

	it("limits /token per IP on its own, looser limit (shared egress IPs refresh tokens often)", async () => {
		const { statuses, limited, register } = await inOneWindow(async (ip) => {
			const statuses = await hammer("/token", ip, TOKEN_LIMIT, { method: "POST" });
			const limited = await workerFetch("/token", { method: "POST" }, ip);
			const register = (await workerFetch("/register", { method: "POST" }, ip)).status;
			return { statuses, limited, register };
		});
		expect(TOKEN_LIMIT).toBeGreaterThan(AUTH_LIMIT);
		expect(statuses).not.toContain(429);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(register).not.toBe(429);
	});

	it("limits /mcp per IP with a looser limit", async () => {
		const { statuses, limited } = await inOneWindow(async (ip) => {
			const statuses = await hammer("/mcp", ip, MCP_LIMIT, { method: "POST" });
			const limited = await workerFetch("/mcp", { method: "POST" }, ip);
			return { statuses, limited };
		});
		expect(statuses.every((s) => s === 401)).toBe(true);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
	});

	it("fails open when the bindings are missing", async () => {
		const bare = {
			...env,
			AUTH_RATE_LIMITER: undefined,
			TOKEN_RATE_LIMITER: undefined,
			MCP_RATE_LIMITER: undefined,
		} as unknown as Env;
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST" }), bare, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect(await rateLimit(new Request(`${ORIGIN}/token`), bare, "/token")).toBeNull();
	});

	it("fails open when the limiter throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const broken = {
			...env,
			TOKEN_RATE_LIMITER: {
				limit: () => Promise.reject(new Error("boom")),
			},
		} as unknown as Env;
		expect(await rateLimit(new Request(`${ORIGIN}/token`), broken, "/token")).toBeNull();
	});

	it("keys on CF-Connecting-IP", async () => {
		const seen: string[] = [];
		const spy = {
			...env,
			MCP_RATE_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					seen.push(key);
					return { success: true };
				},
			},
		} as unknown as Env;
		const req = new Request(`${ORIGIN}/mcp`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
		await rateLimit(req, spy, "/mcp");
		expect(seen).toEqual(["203.0.113.9"]);
	});
});

describe("body size limits", () => {
	const bytes = (n: number) => new Uint8Array(n).fill(97);

	it("rejects an /mcp body over 5 MiB with 413", async () => {
		const res = await workerFetch("/mcp", { method: "POST", body: bytes(MCP_BODY_LIMIT + 1) });
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: "request_too_large" });
	});

	it("lets a 5 MiB /mcp body through to the provider", async () => {
		const res = await workerFetch("/mcp", { method: "POST", body: bytes(MCP_BODY_LIMIT) });
		expect(res.status).toBe(401); // reached the OAuth provider, which wants a token
	});

	it.each(["/token", "/register", "/authorize"])("rejects a %s POST body over 64 KiB with 413", async (path) => {
		const res = await workerFetch(path, { method: "POST", body: bytes(AUTH_BODY_LIMIT + 1) });
		expect(res.status).toBe(413);
	});

	it("lets a 64 KiB auth POST through", async () => {
		const res = await workerFetch("/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: bytes(AUTH_BODY_LIMIT),
		});
		expect(res.status).not.toBe(413);
	});

	it("does not limit GET requests or other paths", async () => {
		expect((await workerFetch("/.well-known/oauth-authorization-server")).status).toBe(200);
	});

	describe("without Content-Length (streamed body)", () => {
		function streamed(path: string, chunks: number, chunkSize: number): Request {
			const chunk = bytes(chunkSize);
			let sent = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent++ < chunks) controller.enqueue(chunk);
					else controller.close();
				},
			});
			return new Request(`${ORIGIN}${path}`, { method: "POST", body });
		}

		it("rejects once the streamed body passes the cap", async () => {
			const req = streamed("/mcp", 6, 1024 * 1024);
			expect(req.headers.get("Content-Length")).toBeNull();
			const result = await limitBody(req, "/mcp");
			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(413);
		});

		it("rebuilds the request with the same body when under the cap", async () => {
			const req = streamed("/token", 4, 1024);
			const result = await limitBody(req, "/token");
			expect(result).toBeInstanceOf(Request);
			expect((await (result as Request).arrayBuffer()).byteLength).toBe(4096);
		});
	});
});
