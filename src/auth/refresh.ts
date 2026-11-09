// Runs inside the library's /token endpoint for code and refresh grants. Keeps our MCP
// access token from outliving the Google access token it carries, and swaps in a fresh
// Google token every time the MCP client refreshes.

import {
	OAuthError,
	type TokenExchangeCallbackOptions,
	type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "../env";
import { GoogleInvalidGrant, refreshGoogleToken } from "./google";

/** Expire ours this long before Google's, so a refresh always lands while Google's is valid. */
const SAFETY_MARGIN_S = 300;

export function accessTokenTtl(env: Env, googleExpiresAt: number): number {
	const configured = Number(env.ACCESS_TOKEN_TTL_SECONDS) || 3000;
	const googleRemaining = Math.floor((googleExpiresAt - Date.now()) / 1000) - SAFETY_MARGIN_S;
	return Math.max(60, Math.min(configured, googleRemaining));
}

export async function tokenExchangeCallback(
	opts: TokenExchangeCallbackOptions<Env>,
): Promise<TokenExchangeCallbackResult | undefined> {
	const props = opts.props as Props;

	if (opts.grantType === "authorization_code") {
		return { accessTokenTTL: accessTokenTtl(opts.env, props.googleExpiresAt) };
	}

	if (opts.grantType === "refresh_token") {
		try {
			const fresh = await refreshGoogleToken({
				clientId: opts.env.GOOGLE_CLIENT_ID,
				clientSecret: opts.env.GOOGLE_CLIENT_SECRET,
				refreshToken: props.googleRefreshToken,
			});
			const newProps: Props = {
				...props,
				googleAccessToken: fresh.accessToken,
				googleRefreshToken: fresh.refreshToken ?? props.googleRefreshToken,
				googleExpiresAt: fresh.expiresAt,
				googleScopes: fresh.scopes.length ? fresh.scopes : props.googleScopes,
			};
			return { newProps, accessTokenTTL: accessTokenTtl(opts.env, fresh.expiresAt) };
		} catch (error) {
			if (error instanceof GoogleInvalidGrant) {
				// Revoked by the user, or a 7-day "Testing" app token expired. Throwing invalid_grant
				// makes the library revoke this grant, so the client re-runs the login.
				throw new OAuthError("invalid_grant", { description: "Google access was revoked or expired. Reconnect." });
			}
			console.error("google refresh failed", error instanceof Error ? error.message : "unknown");
			throw new OAuthError("temporarily_unavailable", {
				description: "Google is unavailable. Try again shortly.",
				statusCode: 503,
			});
		}
	}
	return undefined;
}
