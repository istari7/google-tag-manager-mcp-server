import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Vars, bindings and secrets are typed in worker-configuration.d.ts (`pnpm cf-typegen`, which
// reads secret names from .dev.vars.example). Secrets may still be unset at runtime: check them.
declare global {
	namespace Cloudflare {
		interface Env {
			/** Injected by OAuthProvider into the default handler's env. */
			OAUTH_PROVIDER: OAuthHelpers;
		}
	}
}

/**
 * Everything we keep about a signed-in user. Stored by workers-oauth-provider inside the
 * grant, encrypted with a key derived from the MCP token — readable only by whoever holds
 * that token. Handlers see it as ctx.props. Never log it, never return tokens from tools.
 */
export interface Props extends Record<string, unknown> {
	email: string;
	name?: string;
	googleAccessToken: string;
	googleRefreshToken: string;
	/** Unix ms when googleAccessToken expires. */
	googleExpiresAt: number;
	/** Scopes Google actually granted (users can untick some on the consent screen). */
	googleScopes: string[];
}

export type Env = Cloudflare.Env;
