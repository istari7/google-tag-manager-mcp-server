// Google OAuth 2.0 with plain fetch. No Google SDK.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Always requested: needed to identify the user for the allowlist. */
const IDENTITY_SCOPES = ["openid", "email", "profile"];

export function googleScopes(configured: string | undefined): string[] {
	const extra = (configured ?? "").split(/\s+/).filter(Boolean);
	return [...new Set([...IDENTITY_SCOPES, ...extra])];
}

export function googleAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	scopes: string[];
}): string {
	const url = new URL(AUTH_URL);
	url.search = new URLSearchParams({
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		response_type: "code",
		scope: opts.scopes.join(" "),
		state: opts.state,
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
		// offline + consent: Google only returns a refresh token when both are set.
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
	}).toString();
	return url.toString();
}

export interface GoogleTokens {
	accessToken: string;
	/** Absent on refresh responses (Google doesn't rotate refresh tokens). */
	refreshToken?: string;
	/** Unix ms. */
	expiresAt: number;
	scopes: string[];
	idToken?: string;
}

/** Thrown when Google says the grant is dead (revoked, expired 7-day testing token, etc.). */
export class GoogleInvalidGrant extends Error {}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const error = String(json.error ?? res.status);
		// Only the error code — never echo request bodies (they contain secrets).
		if (error === "invalid_grant") throw new GoogleInvalidGrant(String(json.error_description ?? error));
		throw new Error(`Google token endpoint failed: ${error}`);
	}
	return {
		accessToken: String(json.access_token),
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
		expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
		scopes: String(json.scope ?? "")
			.split(" ")
			.filter(Boolean),
		idToken: typeof json.id_token === "string" ? json.id_token : undefined,
	};
}

export function exchangeCode(opts: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
	codeVerifier: string;
}): Promise<GoogleTokens> {
	return tokenRequest({
		grant_type: "authorization_code",
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
		code: opts.code,
		redirect_uri: opts.redirectUri,
		code_verifier: opts.codeVerifier,
	});
}

export function refreshGoogleToken(opts: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<GoogleTokens> {
	return tokenRequest({
		grant_type: "refresh_token",
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
		refresh_token: opts.refreshToken,
	});
}

export interface IdTokenClaims {
	email?: string;
	email_verified?: boolean;
	name?: string;
	/** Google Workspace domain; absent for consumer accounts. */
	hd?: string;
	aud?: string;
	iss?: string;
	exp?: number;
}

/**
 * Read the ID token's claims. We received it directly from Google's token endpoint over
 * TLS, so per OIDC Core §3.1.3.7 the signature check may be skipped; we still check
 * issuer, audience and expiry.
 */
export function readIdToken(idToken: string, clientId: string): IdTokenClaims {
	const payload = idToken.split(".")[1];
	if (!payload) throw new Error("Malformed ID token");
	const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
	const claims = JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims;
	if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
		throw new Error("ID token has wrong issuer");
	}
	if (claims.aud !== clientId) throw new Error("ID token has wrong audience");
	if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("ID token expired");
	return claims;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
