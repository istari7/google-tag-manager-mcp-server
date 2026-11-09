import type { IdTokenClaims } from "./google";

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export function allowlistConfigured(env: { ALLOWED_EMAILS?: string; ALLOWED_DOMAINS?: string }): boolean {
	return list(env.ALLOWED_EMAILS).length > 0 || list(env.ALLOWED_DOMAINS).length > 0;
}

/**
 * Default-deny. Without an allowlist anyone with a Google account could sign in and spend
 * this project's GTM API quota. Domains match the Workspace `hd` claim, not the email
 * suffix: a consumer Google account can carry any verified email address.
 */
export function isAllowed(claims: IdTokenClaims, env: { ALLOWED_EMAILS?: string; ALLOWED_DOMAINS?: string }): boolean {
	const email = claims.email?.toLowerCase();
	if (!email || claims.email_verified !== true) return false;
	if (list(env.ALLOWED_EMAILS).includes(email)) return true;
	const hd = claims.hd?.toLowerCase();
	return !!hd && list(env.ALLOWED_DOMAINS).includes(hd);
}
