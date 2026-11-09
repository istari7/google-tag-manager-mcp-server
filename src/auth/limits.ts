// Abuse limits applied in front of the OAuth provider: per-IP rate limits and request body
// size caps. Both answer with JSON so OAuth and MCP clients can parse the error.

import type { Env } from "../env";

/** Browser sign-in paths, sent to the strict AUTH_RATE_LIMITER. */
const SIGN_IN_PATHS = new Set(["/authorize", "/callback", "/register"]);
/** /token has its own, looser TOKEN_RATE_LIMITER: Claude web/desktop refresh from shared egress IPs. */
const TOKEN_PATH = "/token";
/** Every OAuth endpoint, for the body cap. */
const AUTH_PATHS = new Set([...SIGN_IN_PATHS, TOKEN_PATH]);

export const MCP_BODY_LIMIT = 5 * 1024 * 1024;
export const AUTH_BODY_LIMIT = 64 * 1024;

/** Every binding uses a 60 s period (wrangler.jsonc), so that is the longest a client waits. */
const RETRY_AFTER_SECONDS = 60;

export function isMcpPath(pathname: string): boolean {
	return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function jsonError(status: number, error: string, description: string, headers: HeadersInit = {}): Response {
	return new Response(JSON.stringify({ error, error_description: description }), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
	});
}

/**
 * Returns a 429 when the caller's IP is over its limit, otherwise null. Fails open: a
 * missing binding (some test or dev setups) or a limiter error never blocks a request.
 */
export async function rateLimit(request: Request, env: Env, pathname: string): Promise<Response | null> {
	let limiter: RateLimit | undefined;
	if (isMcpPath(pathname)) limiter = env.MCP_RATE_LIMITER;
	else if (pathname === TOKEN_PATH) limiter = env.TOKEN_RATE_LIMITER;
	else if (SIGN_IN_PATHS.has(pathname)) limiter = env.AUTH_RATE_LIMITER;
	if (!limiter) return null;

	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	try {
		const { success } = await limiter.limit({ key: ip });
		if (success) return null;
	} catch (error) {
		console.error("rate limiter failed", error instanceof Error ? error.message : "unknown");
		return null;
	}
	return jsonError(429, "too_many_requests", "Too many requests. Try again in a minute.", {
		"Retry-After": String(RETRY_AFTER_SECONDS),
	});
}

function bodyLimitFor(request: Request, pathname: string): number | null {
	if (isMcpPath(pathname)) return MCP_BODY_LIMIT;
	if (request.method === "POST" && AUTH_PATHS.has(pathname)) return AUTH_BODY_LIMIT;
	return null;
}

const tooLarge = (limit: number) =>
	jsonError(413, "request_too_large", `Request body must be at most ${limit} bytes.`, { Connection: "close" });

/**
 * Enforces the body cap. With a Content-Length header the check is free. Without one
 * (chunked upload) the body is read up to the cap and the request rebuilt from the bytes;
 * the caps are small enough that buffering is cheap.
 */
export async function limitBody(request: Request, pathname: string): Promise<Request | Response> {
	const limit = bodyLimitFor(request, pathname);
	if (limit === null || request.body === null) return request;

	const declared = request.headers.get("Content-Length");
	if (declared !== null) {
		const length = Number(declared);
		return Number.isFinite(length) && length <= limit ? request : tooLarge(limit);
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return tooLarge(limit);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new Request(request, { body });
}
