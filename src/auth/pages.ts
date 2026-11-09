import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SCOPE_LABELS: Record<string, string> = {
	openid: "Confirm your identity",
	email: "See your email address",
	profile: "See your name",
	"https://www.googleapis.com/auth/tagmanager.readonly": "View your GTM containers",
	"https://www.googleapis.com/auth/tagmanager.edit.containers": "Edit tags, triggers and variables",
	"https://www.googleapis.com/auth/tagmanager.edit.containerversions": "Create container versions",
	"https://www.googleapis.com/auth/tagmanager.publish": "Publish container versions",
	"https://www.googleapis.com/auth/tagmanager.manage.accounts": "View and manage GTM accounts",
	"https://www.googleapis.com/auth/tagmanager.manage.users": "Manage GTM user permissions",
	"https://www.googleapis.com/auth/tagmanager.delete.containers": "Delete containers and workspaces",
};

/** Optional scopes and the tools that stop working without them. /setup notes the missing ones. */
const OPTIONAL_SCOPES: Record<string, string> = {
	"https://www.googleapis.com/auth/tagmanager.publish": "publish_version",
	"https://www.googleapis.com/auth/tagmanager.delete.containers": "delete_workspace and delete_container",
	"https://www.googleapis.com/auth/tagmanager.manage.accounts": "get_account and update_account",
	"https://www.googleapis.com/auth/tagmanager.manage.users":
		"list_user_permissions, set_user_permission and delete_user_permission",
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--card:#fff;--border:#ddd;--accent:#1a73e8;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--card:#1b1b1b;--border:#333;--accent:#8ab4f8;--warn:#f0b04a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:480px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}.warn{color:var(--warn)}
ul{padding-left:20px;margin:8px 0}code{font-size:.85rem;word-break:break-all}
.actions{display:flex;gap:8px;margin-top:20px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
main.wide{max-width:720px}h2{font-size:1.05rem;margin:24px 0 8px}h3{font-size:.95rem;margin:16px 0 4px}
pre{margin:6px 0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;overflow-x:auto;font-size:.85rem;white-space:pre}
pre code{word-break:normal}.copy{display:block;margin:8px 0 0 auto;font-size:.8rem;padding:2px 10px}
ul.checks{list-style:none;padding-left:0}`;

function layout(title: string, body: string, opts: { nonce?: string; wide?: boolean } = {}): string {
	const nonce = opts.nonce ? ` nonce="${escapeHtml(opts.nonce)}"` : "";
	const main = opts.wide ? `<main class="wide">` : "<main>";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style${nonce}>${STYLE}</style></head><body>${main}${body}</main></body></html>`;
}

export function consentPage(details: ConsentDescription, handle: string, googleScopes: string[]): string {
	const name = escapeHtml(details.clientName || "An MCP client");
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: `This app registered itself; its name is not verified.`;
	const perms = googleScopes.map((s) => `<li>${escapeHtml(SCOPE_LABELS[s] ?? s)}</li>`).join("");
	return layout(
		`Authorize ${details.clientName}`,
		`<h1>Allow <strong>${name}</strong> to use Google Tag Manager as you?</h1>
<p class="muted">${origin}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>` : ""}
<p>Next you'll sign in with Google, which will ask to:</p>
<ul>${perms}</ul>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="actions"><button class="primary" name="decision" value="approve">Continue to Google</button><button name="decision" value="deny">Deny</button></div>
</form>`,
	);
}

export function messagePage(title: string, message: string, status = 400): Response {
	return new Response(layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`), {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
			"Cache-Control": "no-store",
		},
	});
}

/**
 * What /setup reports. Presence flags and the (public) scope list only: secret values never
 * reach the page.
 */
export interface SetupStatus {
	/** "unexpected": set, but doesn't look like a Google OAuth client ID. */
	googleClientId: "missing" | "unexpected" | "ok";
	googleClientSecret: boolean;
	cookieSecret: "missing" | "short" | "ok";
	allowedEmails: boolean;
	allowedDomains: boolean;
	rateLimits: boolean;
	/** Google scopes requested at sign-in (GOOGLE_SCOPES plus openid/email/profile). */
	scopes: string[];
}

/** Same conditions as the "Server not configured" checks in handler.ts. */
export function setupReady(s: SetupStatus): boolean {
	return (
		s.googleClientId !== "missing" &&
		s.googleClientSecret &&
		s.cookieSecret === "ok" &&
		(s.allowedEmails || s.allowedDomains)
	);
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

const tick = (ok: boolean) => (ok ? "✅" : "❌");
const snippet = (text: string) => `<pre data-copy><code>${escapeHtml(text)}</code></pre>`;
const mcpServers = (entry: Record<string, string>) => JSON.stringify({ mcpServers: { gtm: entry } }, null, 2);

// Adds a Copy button above each snippet; if the clipboard is blocked it selects the text instead.
// Runs under a per-response nonce (see the CSP below). Without JavaScript the snippets are still
// plain selectable text.
const COPY_SCRIPT = `document.querySelectorAll("pre[data-copy]").forEach(function(pre){var b=document.createElement("button");b.type="button";b.className="copy";b.textContent="Copy";b.addEventListener("click",function(){navigator.clipboard.writeText(pre.textContent).then(function(){b.textContent="Copied"},function(){var r=document.createRange();r.selectNodeContents(pre);var sel=getSelection();sel.removeAllRanges();sel.addRange(r);b.textContent="Selected: press Ctrl+C"});setTimeout(function(){b.textContent="Copy"},3000)});pre.before(b)});`;

function checks(s: SetupStatus): string {
	const clientId = {
		missing: `${tick(false)} <code>GOOGLE_CLIENT_ID</code>: not set`,
		unexpected: `⚠️ <code>GOOGLE_CLIENT_ID</code>: set, but it doesn't end in <code>.apps.googleusercontent.com</code>. Check you copied the client ID, not the project ID.`,
		ok: `${tick(true)} <code>GOOGLE_CLIENT_ID</code>: set`,
	}[s.googleClientId];
	const cookie = {
		missing: `${tick(false)} <code>COOKIE_SECRET</code>: not set`,
		short: `${tick(false)} <code>COOKIE_SECRET</code>: too short, use at least 32 characters`,
		ok: `${tick(true)} <code>COOKIE_SECRET</code>: set`,
	}[s.cookieSecret];
	const allowlist = s.allowedEmails || s.allowedDomains;
	const lists = `<code>ALLOWED_EMAILS</code> ${s.allowedEmails ? "set" : "not set"}, <code>ALLOWED_DOMAINS</code> ${s.allowedDomains ? "set" : "not set"}`;
	return `<ul class="checks">
<li>${clientId}</li>
<li>${tick(s.googleClientSecret)} <code>GOOGLE_CLIENT_SECRET</code>: ${s.googleClientSecret ? "set" : "not set"}</li>
<li>${cookie}</li>
<li>${tick(allowlist)} Sign-in allowlist: ${lists}${allowlist ? "" : ". Every sign-in is refused until one is set."}</li>
<li>${s.rateLimits ? "✅ Rate limiting: on" : "⚠️ Rate limiting: off (a <code>AUTH_RATE_LIMITER</code> / <code>TOKEN_RATE_LIMITER</code> / <code>MCP_RATE_LIMITER</code> binding is missing)"}</li>
</ul>`;
}

/** The /setup page (also served at /). `origin` comes from the request URL. */
export function setupPage(origin: string, s: SetupStatus): Response {
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const mcpUrl = `${origin}/mcp`;
	const redirectUri = `${origin}/callback`;
	let host = "";
	let protocol = "";
	try {
		({ hostname: host, protocol } = new URL(origin));
	} catch {
		// Unparseable origin: skip the protocol hints below.
	}
	const loopback = isLoopback(host);
	const ready = setupReady(s);

	const scopes = s.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
	const missing = Object.entries(OPTIONAL_SCOPES).filter(([scope]) => !s.scopes.includes(scope));
	const missingNote = missing
		.map(
			([scope, tools]) =>
				`<p class="muted">Without <code>${escapeHtml(scope)}</code>, ${tools} will fail with a permission error. Add it to <code>GOOGLE_SCOPES</code> and the consent screen to use ${tools.includes(" and ") ? "them" : "it"}.</p>`,
		)
		.join("");
	const httpNote =
		protocol === "http:" && !loopback
			? `<p class="warn">This page was loaded over http. Google only accepts http redirect URIs for localhost, and MCP clients expect https. Use the https address.</p>`
			: "";
	const loopbackNote = loopback
		? `<p class="warn">This is a local address. Claude web and desktop connect from Anthropic's servers and can't reach it; use Claude Code, Cursor or Gemini CLI on this machine.</p>`
		: "";

	const body = `<h1>GTM MCP server setup</h1>
<p><strong>${ready ? "✅ Ready. Accounts on the allowlist can connect." : "❌ Not ready. Fix the items marked ❌, then reload this page."}</strong></p>
<p class="muted">This page shows whether each secret is set, never its value. Set secrets with <code>npx wrangler secret put &lt;NAME&gt;</code>; they apply right away. The repository's <code>docs/google-setup.md</code> and <code>docs/deploy.md</code> walk through every step.</p>

<h2>Configuration</h2>
${checks(s)}

<h2>Google OAuth client</h2>
<p>Add this exact URI under <strong>Authorized redirect URIs</strong> in your Google OAuth client (type Web application):</p>
${snippet(redirectUri)}
${httpNote}
<p>Scopes requested at sign-in. Add the Tag Manager ones to the consent screen's Data access page:</p>
<ul>${scopes}</ul>
${missingNote}

<h2>Connect a client</h2>
<p>MCP server URL:</p>
${snippet(mcpUrl)}
${loopbackNote}
<h3>Claude Code</h3>
${snippet(`claude mcp add --transport http gtm ${mcpUrl}`)}
<p class="muted">Then run <code>/mcp</code> in Claude Code, select <code>gtm</code> and choose Authenticate.</p>
<h3>Claude (web and desktop)</h3>
<p>Go to Customize › Connectors › Add custom connector and paste the MCP server URL. Leave the OAuth client ID and secret empty. On Team and Enterprise plans an Owner adds it under Organization settings › Connectors, then each member connects.</p>
<h3>Cursor</h3>
<p class="muted"><code>~/.cursor/mcp.json</code> (all projects) or <code>.cursor/mcp.json</code> (one project):</p>
${snippet(mcpServers({ url: mcpUrl }))}
<h3>Gemini CLI</h3>
<p class="muted"><code>~/.gemini/settings.json</code> (or <code>.gemini/settings.json</code> in a project), then run <code>/mcp auth gtm</code>:</p>
${snippet(mcpServers({ httpUrl: mcpUrl }))}
<h3>Other clients</h3>
<p class="muted">Any MCP client that supports remote (Streamable HTTP) servers with OAuth: use the MCP server URL.</p>
<script nonce="${nonce}">${COPY_SCRIPT}</script>`;

	return new Response(layout("GTM MCP setup", body, { nonce, wide: true }), {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			"X-Frame-Options": "DENY",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			// The checks change as soon as a secret is set.
			"Cache-Control": "no-store",
		},
	});
}
