# Deploying to Cloudflare

The server is one Cloudflare Worker with one KV namespace and three rate-limit bindings. There is no
database or Durable Object. You can deploy it with the Deploy button or with the Wrangler CLI.

Order of work:

1. [Choose your address](#choose-your-address) in `wrangler.jsonc`.
2. Deploy ([button](#option-a-deploy-button) or [CLI](#option-b-cli)).
3. Open `https://<your-worker>/setup` for the redirect URI.
4. Set up Google Cloud: [google-setup.md](google-setup.md).
5. Set the [secrets](#secrets) and reload `/setup` until every item is ✅.
6. Connect a client (snippets on `/setup` and in the [README](../README.md#connect-a-client)).

## Choose your address

`wrangler.jsonc` in this repository is the original author's deployment config. These three
settings are specific to it:

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "gtm-mcp.example.com", "custom_domain": true }],
```

The real file points `routes` at the author's own domain (shown here as `gtm-mcp.example.com`).
That domain isn't in your Cloudflare account, so a deploy with these lines unchanged fails. Pick one
of the two setups below and edit the file before your first deploy.

**A `workers.dev` address** (simplest, no domain needed):

```jsonc
"workers_dev": true,
"preview_urls": false,
// delete the "routes" line
```

The Worker is then at `https://gtm-mcp.<your-subdomain>.workers.dev`. The first part is the
`name` in `wrangler.jsonc`; the subdomain is your account's `workers.dev` subdomain, shown in the
dashboard under Workers & Pages.

**Your own domain** (the domain's DNS must be on Cloudflare, in the same account):

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "gtm.example.com", "custom_domain": true }],
```

Cloudflare creates the DNS record and certificate on deploy.

Use **one** public address. Tokens are tied to the address a client connected to, so a client set
up on `workers.dev` won't work on the custom domain. If you change the address later, update the
redirect URI in Google Cloud and reconnect every client.

## Option A: Deploy button

1. Push your copy of this repository to GitHub (or fork it) and edit `wrangler.jsonc` as above.
   The button only works with public github.com or gitlab.com repositories.
2. Open the button link, with your repository's URL:

   ```
   https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/<repo>
   ```

   or put the button in your README:

   ```markdown
   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/<repo>)
   ```

3. Cloudflare copies the repository into your Git account, creates the `OAUTH_KV` namespace, asks
   for the secrets listed in `.dev.vars.example` (see [Secrets](#secrets)), and deploys. Later
   pushes to that repository redeploy automatically (Workers Builds).
4. If you didn't edit `wrangler.jsonc` first, the first deploy fails on the route. Edit it in the
   new repository, commit, and the build runs again.

You probably don't have the Google client ID and secret yet, since the redirect URI depends on the
Worker's address. If the form insists on values, enter placeholders, then set the real values with
`wrangler secret put` (or in the dashboard: Workers & Pages › your Worker › Settings › Variables
and Secrets) after the Google setup.

## Option B: CLI

Requirements: Node.js 24+, pnpm, a Cloudflare account.

```bash
git clone https://github.com/<you>/<repo>.git gtm-mcp
cd gtm-mcp
pnpm install
npx wrangler login              # opens a browser to authorise Wrangler
# edit wrangler.jsonc (see "Choose your address")
pnpm run deploy                 # wrangler deploy
```

Alternatively, `pnpm create cloudflare@latest -- --template=<you>/<repo>` creates a project from a
template repository in one step.

Wrangler prints the Worker's URL. Open `<url>/setup`. Every secret shows ❌ until you set it.

## Secrets

Set each with `npx wrangler secret put <NAME>` from the project folder. Wrangler prompts for the
value, so it doesn't end up in your shell history. Each `secret put` deploys a new version
straight away; reload `/setup` to check. Wrangler can't show a secret's value after it's set.

| Secret | Required | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID from Google Cloud, ends in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `COOKIE_SECRET` | yes | 32+ random characters. Signs the "remember this client" cookie on the consent page |
| `ALLOWED_EMAILS` | one of these two | Comma-separated Google account emails allowed to sign in |
| `ALLOWED_DOMAINS` | one of these two | Comma-separated Google Workspace domains allowed to sign in |

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Generate a cookie secret and paste it when asked:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put COOKIE_SECRET

npx wrangler secret put ALLOWED_EMAILS     # you@example.com,colleague@example.com
npx wrangler secret put ALLOWED_DOMAINS    # example.com (optional)
```

Notes on the allowlist:

- Sign-in is refused for everyone until `ALLOWED_EMAILS` or `ALLOWED_DOMAINS` is set.
- `ALLOWED_DOMAINS` matches the Google Workspace domain of the account (Google's `hd` claim), not
  the end of the email address. A personal Gmail account never matches a domain, so list those in
  `ALLOWED_EMAILS`.
- `secret put` replaces the whole value. To add someone, enter the complete list again.
- To clear one: `npx wrangler secret delete ALLOWED_DOMAINS`.

Plain settings (not secret) live under `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `GOOGLE_SCOPES` | Tag Manager scopes | Space-separated Google scopes requested at sign-in. `openid email profile` are always added. Must match your consent screen; see [google-setup.md](google-setup.md#add-the-scopes) |
| `ACCESS_TOKEN_TTL_SECONDS` | `3000` | Upper limit for the lifetime of the token the Worker gives MCP clients. It's always shorter than Google's token, so the Worker can refresh Google's in time |

Change them in `wrangler.jsonc` and redeploy.

## KV namespace

`wrangler.jsonc` declares `OAUTH_KV` without an `id`. On the first deploy Wrangler (and the Deploy
button) creates the namespace in your account and reuses it on later deploys, so there's nothing to
create by hand. It holds registered clients, grants (with the encrypted Google tokens) and
short-lived sign-in state.

Deleting the namespace signs everyone out.

## Rate limits

Three [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings limit requests per client IP:

| Binding | Applies to | Default |
|---|---|---|
| `AUTH_RATE_LIMITER` | `/authorize`, `/callback`, `/register` | 30 per minute |
| `TOKEN_RATE_LIMITER` | `/token` | 120 per minute |
| `MCP_RATE_LIMITER` | `/mcp` | 300 per minute |

Over the limit, the Worker answers `429 too_many_requests`. Limits are approximate and counted per
Cloudflare location. Claude web and desktop call `/token` and `/mcp` from Anthropic's servers, so
several users can share one IP. That is why `/token` (code exchanges and token refreshes) has its
own, looser limit, while the browser sign-in pages keep the strict one. Keep the limits generous if
many people use one Worker.

Each binding's `namespace_id` must be unique within your Cloudflare account. If another Worker in
your account already uses `4710`, `4711` or `4712`, pick other numbers. `/setup` shows "Rate limiting: off"
if any of the bindings is missing; the Worker still runs, just without those limits.

## Updating

CLI: `git pull`, `pnpm install`, `pnpm run deploy`. Deploy button: pull the changes into your
copy of the repository and push; Workers Builds redeploys. Secrets and KV data are kept.

## Logs

`npx wrangler tail` streams live logs, or use Workers & Pages › your Worker › Logs in the
dashboard (`observability` is on in `wrangler.jsonc`). The Worker logs error codes only, never
tokens.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the values
pnpm dev                          # http://localhost:8787
```

`pnpm dev` runs `wrangler dev --infer-origin-from-routes=false`. If you run `wrangler dev`
yourself, keep that flag when `routes` has a custom domain. Without it the Worker sees requests as
`http://<your domain>`, and the OAuth library refuses to start because the server address must be
https unless it's localhost.

To finish a Google sign-in locally, add `http://localhost:8787/callback` to your OAuth client's
redirect URIs (or use a separate development client). Claude web and desktop can't reach
`localhost`; test locally with Claude Code, Cursor or Gemini CLI.

## Troubleshooting

**Google says `Error 400: redirect_uri_mismatch`.**
The redirect URI registered in your Google OAuth client doesn't exactly match the one the Worker
sends. Copy it from `/setup` on the address you're connecting through: same scheme (`https`), same
host, path `/callback`, no trailing slash. If you just changed it, wait a few minutes: Google can
take that long to apply client changes.

**"Access blocked: … has not completed the Google verification process" (Google).**
The consent screen is External and in Testing, and this account isn't a test user. Add it under
Google Auth Platform › Audience › Test users, or see the
[7-day problem](google-setup.md#the-7-day-problem) options.

**"Access denied … is not allowed to use this server" (403 page from the Worker).**
The Google account isn't on the allowlist. Add the email to `ALLOWED_EMAILS` (enter the full list
again), or its Workspace domain to `ALLOWED_DOMAINS`. A Gmail address never matches
`ALLOWED_DOMAINS`. The email must also be verified with Google. Then connect again from your client.

**"Server not configured" (500 page from the Worker).**
A required secret is missing or `COOKIE_SECRET` is shorter than 32 characters. `/setup` shows which.

**The client asks you to sign in again after about a week, or the logs show `invalid_grant`.**
Your consent screen is External and in Testing, so Google's refresh token expired after 7 days.
This is expected in that mode; sign in again, or see the
[7-day problem](google-setup.md#the-7-day-problem). The same happens if you removed the app at
myaccount.google.com/permissions.

**"Google didn't return a refresh token."**
Rare, since the Worker always asks Google for consent. Remove the app at
<https://myaccount.google.com/permissions> and connect again.

**Tools fail with a permission error even though sign-in worked.**
Check that the Tag Manager API is enabled in the Google Cloud project, that the scopes were granted
(`auth_status` lists them), and that the Google account has access to that GTM account or
container in the GTM UI.

**The AI says it can't publish a version or delete a container.**
That is by design: this server never publishes and never deletes containers or accounts (see the
README, "What this server will never do"). Ask it to `create_version`, then publish that version
yourself in the GTM UI (Versions › Publish).

**"Google session expired. Reconnect the GTM connector."**
The Worker couldn't refresh the Google token during a tool call. Reconnect from your client.

**`429 too_many_requests`.**
A rate limit was hit. Wait a minute, or raise the limits in `wrangler.jsonc` (see
[Rate limits](#rate-limits)).

**`wrangler dev` fails to start the OAuth provider or redirects to the production host.**
Run it as `pnpm dev`, or add `--infer-origin-from-routes=false` (see
[Local development](#local-development)).

**The deploy fails with an error about the route or zone.**
`routes` still points at a domain that isn't in your account. See
[Choose your address](#choose-your-address).
