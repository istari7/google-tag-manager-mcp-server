// Unprotected routes: /setup (also at /), /llms.txt, /authorize (consent → Google), /callback (Google → MCP client).
// The browser-binding, state and single-use guarantees come from workers-oauth-provider's
// beginConsent/approveConsent/beginUpstream/finishUpstream helpers.

import {
	AuthorizationError,
	type AuthRequest,
	authorizationErrorRedirect,
	CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "../env";
import { llmsTxtResponse } from "../skills/instructions";
import { describeToolGroups, isDefaultSelection, parseToolGroups, ToolGroupsError } from "../tools/groups";
import { allowlistConfigured, isAllowed } from "./allowlist";
import { exchangeCode, GoogleInvalidGrant, googleAuthorizeUrl, googleScopes, pkcePair, readIdToken } from "./google";
import { consentPage, messagePage, type SetupStatus, setupPage } from "./pages";

interface UpstreamData {
	verifier: string;
}

/** Checks for /setup: whether each secret is set (plus a shape check on two). Never the values. */
export function setupStatus(env: Env): SetupStatus {
	const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
	const cookie = env.COOKIE_SECRET ?? "";
	return {
		googleClientId: !clientId ? "missing" : clientId.endsWith(".apps.googleusercontent.com") ? "ok" : "unexpected",
		googleClientSecret: !!env.GOOGLE_CLIENT_SECRET,
		cookieSecret: !cookie ? "missing" : cookie.length < 32 ? "short" : "ok",
		allowedEmails: allowlistConfigured({ ALLOWED_EMAILS: env.ALLOWED_EMAILS }),
		allowedDomains: allowlistConfigured({ ALLOWED_DOMAINS: env.ALLOWED_DOMAINS }),
		rateLimits: !!env.AUTH_RATE_LIMITER && !!env.TOKEN_RATE_LIMITER && !!env.MCP_RATE_LIMITER,
		scopes: googleScopes(env.GOOGLE_SCOPES),
		toolGroups: toolGroupsStatus(env.GTM_TOOL_GROUPS),
	};
}

function toolGroupsStatus(value: string | undefined): SetupStatus["toolGroups"] {
	try {
		const groups = parseToolGroups(value);
		return { groups: describeToolGroups(groups), isDefault: isDefaultSelection(groups) };
	} catch (error) {
		// /setup is public: never echo any part of the value there.
		if (error instanceof ToolGroupsError) return { error: error.publicMessage };
		throw error;
	}
}

export const authHandler = {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		try {
			if ((url.pathname === "/setup" || url.pathname === "/") && req.method === "GET") {
				return setupPage(url.origin, setupStatus(env));
			}
			if (url.pathname === "/llms.txt" && req.method === "GET") return llmsTxtResponse(url.origin);
			if (url.pathname === "/authorize" && req.method === "GET") return await showConsent(req, env);
			if (url.pathname === "/authorize" && req.method === "POST") return await submitConsent(req, env);
			if (url.pathname === "/callback" && req.method === "GET") return await callback(req, env, ctx);
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) {
				return Response.redirect(error.redirectTo, 302);
			}
			if (error instanceof AuthorizationError) {
				return messagePage("Sign-in could not continue", `${error.description} Start connecting again from your app.`);
			}
			if (error instanceof CimdFetchError) {
				return messagePage("Unknown app", "This app's metadata could not be fetched, so it can't be verified.");
			}
			throw error;
		}
	},
};

function configError(env: Env): Response | null {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return messagePage("Server not configured", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.", 500);
	}
	if ((env.COOKIE_SECRET ?? "").length < 32) {
		return messagePage("Server not configured", "COOKIE_SECRET must be at least 32 characters.", 500);
	}
	if (!allowlistConfigured(env)) {
		return messagePage(
			"Server not configured",
			"Set ALLOWED_EMAILS or ALLOWED_DOMAINS. Sign-in is refused until one is set.",
			500,
		);
	}
	return null;
}

const remember = (env: Env) => ({ secret: env.COOKIE_SECRET });

async function showConsent(req: Request, env: Env): Promise<Response> {
	const misconfigured = configError(env);
	if (misconfigured) return misconfigured;

	const oauth = env.OAUTH_PROVIDER;
	const authReq = await oauth.parseAuthRequest(req);

	// This browser already approved this client + redirect URI: go straight to Google.
	if (await oauth.isConsentRemembered(req, authReq, remember(env))) {
		return redirectToGoogle(req, env, authReq, new Headers());
	}

	const details = await oauth.describeConsent(authReq);
	const consent = await oauth.beginConsent(authReq);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(consentPage(details, consent.handle, googleScopes(env.GOOGLE_SCOPES)), {
		headers: consent.headers,
	});
}

async function submitConsent(req: Request, env: Env): Promise<Response> {
	const misconfigured = configError(env);
	if (misconfigured) return misconfigured;

	const oauth = env.OAUTH_PROVIDER;
	const form = await req.formData();
	const handle = String(form.get("handle") ?? "");

	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(req, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(req, handle, { remember: remember(env) });
	return redirectToGoogle(req, env, approved.request, approved.headers);
}

async function redirectToGoogle(req: Request, env: Env, authReq: AuthRequest, headers: Headers): Promise<Response> {
	const { verifier, challenge } = await pkcePair();
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(authReq, {
		data: { verifier } satisfies UpstreamData,
		headers,
	});
	upstream.headers.set(
		"Location",
		googleAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			redirectUri: new URL("/callback", req.url).toString(),
			state: upstream.state,
			codeChallenge: challenge,
			scopes: googleScopes(env.GOOGLE_SCOPES),
		}),
	);
	return new Response(null, { status: 302, headers: upstream.headers });
}

async function callback(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const url = new URL(req.url);

	// Verifies state exists, is unused, unexpired, and bound to this browser's cookie.
	const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(req);

	if (url.searchParams.get("error")) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied", "Google sign-in was cancelled"));
		return new Response(null, { status: 302, headers });
	}
	const code = url.searchParams.get("code");
	if (!code) return messagePage("Sign-in failed", "Google didn't return an authorization code.");

	let tokens: Awaited<ReturnType<typeof exchangeCode>>;
	try {
		tokens = await exchangeCode({
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			code,
			redirectUri: new URL("/callback", req.url).toString(),
			codeVerifier: data.verifier,
		});
	} catch (error) {
		const reason =
			error instanceof GoogleInvalidGrant
				? "The Google code expired or was already used."
				: "Google token exchange failed.";
		console.error("google code exchange failed", error instanceof Error ? error.message : "unknown");
		return messagePage("Sign-in failed", `${reason} Start connecting again from your app.`, 502);
	}

	if (!tokens.idToken) return messagePage("Sign-in failed", "Google didn't return an ID token.", 502);
	const claims = readIdToken(tokens.idToken, env.GOOGLE_CLIENT_ID);

	if (!isAllowed(claims, env)) {
		// Don't keep a token for someone we won't serve.
		ctx.waitUntil(revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken));
		console.warn("sign-in refused: not on allowlist");
		return messagePage(
			"Access denied",
			`${claims.email ?? "This account"} is not allowed to use this server. Ask the owner to add it to ALLOWED_EMAILS or ALLOWED_DOMAINS.`,
			403,
		);
	}
	if (!tokens.refreshToken) {
		return messagePage(
			"Sign-in failed",
			"Google didn't return a refresh token. Remove this app at myaccount.google.com/permissions and try again.",
			502,
		);
	}

	const email = claims.email as string;
	const props: Props = {
		email,
		name: claims.name,
		googleAccessToken: tokens.accessToken,
		googleRefreshToken: tokens.refreshToken,
		googleExpiresAt: tokens.expiresAt,
		googleScopes: tokens.scopes,
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: email,
		metadata: { email },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

async function revokeGoogleToken(token: string): Promise<void> {
	await fetch("https://oauth2.googleapis.com/revoke", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token }),
	}).catch(() => undefined);
}
