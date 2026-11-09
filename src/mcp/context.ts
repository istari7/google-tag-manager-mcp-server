// Per-request context handed to every tool: who is signed in, the Worker env, and a GTM
// client already wired to this user's Google token.

import { GoogleInvalidGrant, refreshGoogleToken } from "../auth/google";
import type { Env, Props } from "../env";
import { createGtmClient, type FetchLike, type GtmClient } from "../gtm/client";
import { GtmApiError, MESSAGES } from "../gtm/errors";

export interface ToolContext {
	/** The signed-in user's grant props. Contains Google tokens: never return or log them. */
	readonly props: Props;
	readonly env: Env;
	/** GTM API client authenticated as the signed-in user. Use with the wrappers in gtm/generated.ts. */
	readonly gtm: GtmClient;
}

export interface ToolContextOptions {
	/** Only for tests. Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Only for tests. Defaults to setTimeout-based backoff. */
	sleep?: (ms: number) => Promise<void>;
}

/** Refresh in memory when Google's token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Returns a getter for the Google access token. Normally the token endpoint keeps it fresh
 * (src/auth/refresh.ts). If a client sits on an MCP token past Google's expiry anyway,
 * refresh in memory for this request only: props can't be saved from /mcp. Parallel
 * GTM calls share one refresh.
 */
export function googleTokenGetter(props: Props, env: Env): () => Promise<string> {
	let refreshing: Promise<string> | undefined;
	return async () => {
		if (props.googleExpiresAt - Date.now() > REFRESH_MARGIN_MS) return props.googleAccessToken;
		refreshing ??= refreshGoogleToken({
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			refreshToken: props.googleRefreshToken,
		}).then(
			(fresh) => {
				props.googleAccessToken = fresh.accessToken;
				props.googleExpiresAt = fresh.expiresAt;
				return fresh.accessToken;
			},
			(error: unknown) => {
				refreshing = undefined;
				if (error instanceof GoogleInvalidGrant) {
					throw new GtmApiError(MESSAGES.auth, { status: 401, kind: "auth", method: "POST", path: "oauth2/token" });
				}
				throw error;
			},
		);
		return refreshing;
	};
}

export function createToolContext(props: Props, env: Env, options: ToolContextOptions = {}): ToolContext {
	const gtm = createGtmClient({
		getToken: googleTokenGetter(props, env),
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.sleep ? { sleep: options.sleep } : {}),
	});
	return { props, env, gtm };
}
