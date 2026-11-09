import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth/handler";
import { limitBody, rateLimit } from "./auth/limits";
import { tokenExchangeCallback } from "./auth/refresh";
import type { Env } from "./env";
import { mcpApiHandler } from "./mcp/server";

// The provider needs its public origin (token audience + discovery metadata). Build one per
// origin on first request instead of hard-coding the host, so the same code runs on any
// custom domain and on `wrangler dev`.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler,
			defaultHandler: authHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			// Newer MCP clients (Claude, VS Code) identify themselves with a metadata URL instead of registering.
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
			},
			tokenExchangeCallback,
			// Our token lifetime is set per token in tokenExchangeCallback (≤ Google's).
			accessTokenTTL: 3000,
			// A grant lives 30 days, but slides while in use.
			refreshTokenTTL: 30 * 86400,
			refreshTokenIdleTTL: 30 * 86400,
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		// Cheap rejections first: per-IP rate limits, then body size caps (src/auth/limits.ts).
		const limited = await rateLimit(request, env, url.pathname);
		if (limited) return limited;
		const checked = await limitBody(request, url.pathname);
		if (checked instanceof Response) return checked;
		return providerFor(url.origin).fetch(checked, env, ctx);
	},
} satisfies ExportedHandler<Env>;
