# gtm-mcp

> [!WARNING]
> **Work in progress — not ready for use.** This project is under active development. APIs, tools
> and setup steps may change without notice, it has not been security-reviewed for production, and
> it may modify your GTM workspaces. Do not connect it to production containers.

An MCP server for Google Tag Manager that you host yourself on Cloudflare Workers.

Connect it to Claude, Claude Code, Cursor, Gemini CLI or any MCP client that supports remote
servers with OAuth. You sign in with your Google account, and the AI can then read and edit your
GTM containers through the Tag Manager API v2: tags, triggers, variables, folders, workspaces and
versions.

- **Self-hosted.** It runs in your own Cloudflare account against your own Google Cloud project,
  so the API quota and the tokens are yours.
- **Default-deny.** Only the Google accounts or Workspace domains you list can sign in.
- **It never publishes.** The AI can edit workspaces and save versions, but only a person can make
  a version live, in the GTM UI. It also never deletes a container or an account. See
  [What this server will never do](#what-this-server-will-never-do).

Written in TypeScript. OAuth comes from
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) and
the GTM client is generated from Google's Discovery document.

## Contents

- [How it works](#how-it-works)
- [Tools](#tools)
- [What this server will never do](#what-this-server-will-never-do)
- [Safety model](#safety-model)
- [Deploy](#deploy)
- [Connect a client](#connect-a-client)
- [Google scopes](#google-scopes)
- [Costs and quotas](#costs-and-quotas)
- [The 7-day sign-in problem](#the-7-day-sign-in-problem)
- [Development](#development)
- [Trademarks](#trademarks)
- [License](#license)

## How it works

```
MCP client ──OAuth──▶ your Worker (/authorize, /token, /mcp) ──▶ Google sign-in
           ◀─tools──┘                │
                                     └──Bearer <your Google token>──▶ Tag Manager API v2
```

1. Your MCP client connects to `https://<your-worker>/mcp` and is sent to the Worker's sign-in page.
2. You approve the client, then sign in with Google. The Worker checks your email against the
   allowlist.
3. The Worker keeps your Google tokens encrypted inside the OAuth grant (in Workers KV) and gives the
   client its own token. It refreshes the Google token for you.
4. Tool calls go to the Tag Manager API as you. You only see the GTM accounts your Google account
   can already access.

## Tools

**Kind:** *read* changes nothing. *write* changes a workspace or creates a version, but nothing
on your website changes until a person publishes a version in the GTM UI. *destructive* deletes a
tag, trigger or variable from a workspace, and needs `confirm: true` (without it, the tool returns
a preview of what it would do). No tool changes your live site.

| Group | Tool | What it does | Kind |
|---|---|---|---|
| Utility | `ping` | Checks the server is reachable | read |
| | `auth_status` | Shows the signed-in email, granted scopes and token expiry (never the tokens) | read |
| Accounts & containers | `list_accounts` | Lists the GTM accounts you can access | read |
| | `list_containers` | Lists the containers in an account | read |
| | `lookup_container` | Finds a container by its public ID (`GTM-XXXXXXX`) | read |
| | `get_container_snippet` | Returns the container's install snippet | read |
| Workspaces | `list_workspaces` | Lists a container's workspaces | read |
| | `create_workspace` | Creates a workspace (containers allow only a few) | write |
| | `get_workspace_status` | Shows pending changes and merge conflicts | read |
| | `quick_preview_workspace` | Checks a workspace compiles by building a throwaway preview; saves and publishes nothing | read |
| Tags | `list_tags`, `get_tag` | Lists tags / gets one tag in full | read |
| | `create_tag`, `update_tag` | Creates a tag / changes some fields of a tag (other fields are kept) | write |
| | `delete_tag` | Deletes a tag; the preview shows the tag | destructive |
| Triggers | `list_triggers`, `get_trigger` | Lists triggers / gets one trigger in full | read |
| | `create_trigger`, `update_trigger` | Creates a trigger / changes some fields of a trigger, fixing known API pitfalls in its conditions | write |
| | `delete_trigger` | Deletes a trigger; the preview also lists the tags that use it | destructive |
| Variables | `list_variables`, `get_variable` | Lists variables / gets one variable in full | read |
| | `create_variable`, `update_variable` | Creates a variable / changes some fields of a variable | write |
| | `delete_variable` | Deletes a variable; the preview shows the variable | destructive |
| Built-in variables | `list_built_in_variables` | Lists the enabled built-in variables | read |
| | `enable_built_in_variables` | Enables built-in variables (Page URL, Click ID, …) | write |
| Folders | `list_folders` | Lists folders | read |
| | `create_folder` | Creates a folder | write |
| | `move_entities_to_folder` | Moves tags, triggers and variables into a folder (folder `0` = out of any folder) | write |
| Versions | `create_version` | Saves the workspace as a new container version. Does not publish: a person publishes it in the GTM UI. Refuses when there are no changes or there are merge conflicts | write |
| | `get_live_version` | Gets the currently published version | read |
| | `list_versions` | Lists container versions | read |

The server also offers best-practices guides as MCP resources (`gtm://best-practices`).

## What this server will never do

These are deliberate, permanent limits, not missing features:

- **Publish a container version.** The AI can prepare changes in a workspace and save them as a
  version with `create_version`. A person then reviews that version and publishes it in the GTM
  UI (Versions › Publish). Nothing the AI does reaches your live site on its own.
- **Delete a container or an account.** Only tags, triggers and variables inside a workspace can be
  deleted, and only with `confirm: true`.

This is enforced in the GTM API client (`src/gtm/client.ts`), not just by leaving the tools out:
every request whose path ends in `:publish`, and every `DELETE` of a container or account, is
refused before anything is sent to Google. The server does not need the `tagmanager.publish` or
`tagmanager.delete.containers` scopes, and `/setup` tells you to remove them if they are configured.

## Safety model

- **Allowlist.** Sign-in is refused unless the Google account is in `ALLOWED_EMAILS` or belongs
  to a Google Workspace domain in `ALLOWED_DOMAINS`. With neither set, nobody can sign in. Without
  this, anyone who found your URL could sign in and use your project's GTM API quota.
- **Per-client consent.** Each MCP client must be approved on a consent page before the Google
  sign-in. The approval is remembered in that browser for 30 days.
- **`confirm: true`** is required by every `delete_*` tool. Without it they only describe what
  would be deleted.
- **No lost edits.** GTM updates replace the whole object. Update tools read the current entity,
  merge only the fields you change, and write it back with Google's fingerprint. They also take
  the `fingerprint` the AI saw in its earlier `get_*` call: if someone changed the entity since
  (in the GTM UI, say), the update fails with a conflict instead of overwriting their work. See
  [GTM_API_QUIRKS.md](GTM_API_QUIRKS.md).
- **Workspaces are drafts.** Changes made in a workspace are not on your site until a version is
  created (`create_version`) and a person publishes it in the GTM UI. `create_version` refuses when
  the workspace has no changes or has merge conflicts.
- **Tokens stay server-side.** Google tokens are stored only inside the encrypted grant. They are
  never logged and never returned by a tool.
- **Rate limits.** Per-IP limits on the sign-in endpoints, a looser one on `/token` (Claude web and
  desktop refresh tokens from shared IPs), one on `/mcp`, plus request size caps.

## Deploy

You need a Cloudflare account (the free plan works for light use, see
[Costs and quotas](#costs-and-quotas)) and a Google Cloud project.

**Step 1: set your Worker's address.** `wrangler.jsonc` in this repository is set up for the
original author's deployment (a custom domain with `workers_dev: false`). Change `routes` /
`workers_dev` to your own domain or to a `*.workers.dev` address before deploying.
[docs/deploy.md](docs/deploy.md#choose-your-address) shows both.

**Step 2: deploy.** Either use the button (it copies this repository to your GitHub account,
creates the KV namespace, asks for the secrets and deploys). The button is meant for testers
while the project is a work in progress (see the warning at the top):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/<repo>)

or the CLI:

```bash
git clone https://github.com/<you>/<repo>.git gtm-mcp && cd gtm-mcp
pnpm install
npx wrangler login
# edit wrangler.jsonc (step 1), then:
pnpm run deploy
```

**Step 3: open `https://<your-worker>/setup`.** It shows which secrets are missing, the exact
Google redirect URI and your MCP URL.

**Step 4: Google Cloud.** Enable the Tag Manager API, set up the consent screen and create a Web
OAuth client with the redirect URI from `/setup`. Follow
[docs/google-setup.md](docs/google-setup.md).

**Step 5: secrets.**

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_SECRET      # 32+ random characters
npx wrangler secret put ALLOWED_EMAILS     # e.g. you@example.com,colleague@example.com
npx wrangler secret put ALLOWED_DOMAINS    # optional: your Workspace domain
```

Reload `/setup` until every item is ✅. Details, custom domains and troubleshooting:
[docs/deploy.md](docs/deploy.md).

## Connect a client

Your MCP URL is `https://<your-worker>/mcp`. The `/setup` page shows it with ready-to-copy
snippets. In every client, the first connection opens a browser for the consent page and the
Google sign-in.

So far the full sign-in has been tested end to end with Claude Code only. The config shapes below
follow each product's documentation as of November 2026.

**Claude Code**

```bash
claude mcp add --transport http gtm https://<your-worker>/mcp
```

Then run `/mcp` in Claude Code, select `gtm` and choose Authenticate. Add `--scope user` to use it
in every project.

**Claude (web and desktop)**

Customize › Connectors › Add custom connector, paste the MCP URL, and leave the OAuth client ID and
secret empty. On Team and Enterprise plans an Owner adds it under Organization settings ›
Connectors, and each member then connects. Claude connects from Anthropic's servers, so the
Worker must be reachable on the public internet (a `localhost` URL won't work).

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "gtm": {
      "url": "https://<your-worker>/mcp"
    }
  }
}
```

**Gemini CLI**: `~/.gemini/settings.json` (or `.gemini/settings.json` in a project), then run
`/mcp auth gtm`:

```json
{
  "mcpServers": {
    "gtm": {
      "httpUrl": "https://<your-worker>/mcp"
    }
  }
}
```

`gemini mcp add --transport http gtm https://<your-worker>/mcp` writes the same entry. Google's
Gemini CLI docs say it has been succeeded by Antigravity CLI; we haven't checked Antigravity's
config format.

**Other clients**: any client that supports remote (Streamable HTTP) MCP servers with OAuth
should work with the MCP URL. The server supports both dynamic client registration and client ID
metadata documents, so no client ID needs to be entered.

Try first: *"List my GTM accounts, containers and workspaces. Don't change anything."*

## Google scopes

The Worker asks Google for `openid email profile` (to identify you) plus the scopes in the
`GOOGLE_SCOPES` var in `wrangler.jsonc`. Add the same scopes to your consent screen.

| Scope (`https://www.googleapis.com/auth/…`) | Needed for |
|---|---|
| `tagmanager.readonly` | Every read tool |
| `tagmanager.edit.containers` | Creating, updating and deleting workspaces, tags, triggers, variables, folders and built-in variables |
| `tagmanager.edit.containerversions` | `create_version` |

- **Not needed, by design:** `tagmanager.publish` and `tagmanager.delete.containers`. The server
  never publishes or deletes containers (see
  [What this server will never do](#what-this-server-will-never-do)). Leave them out of
  `GOOGLE_SCOPES` and the consent screen; `/setup` warns if they are there.
- After changing `GOOGLE_SCOPES`, redeploy and reconnect each client so Google asks for the new
  set of permissions.
- `tagmanager.manage.accounts` and `tagmanager.manage.users` are not used by any tool. If your
  `GOOGLE_SCOPES` has them, you can remove them for a shorter consent screen.
- On Google's consent screen you can untick scopes. `auth_status` shows what was actually granted.

## Costs and quotas

**Cloudflare**

- Expected use is small: one tool call is one Worker request plus one or two GTM API calls.
- The **free plan** (100,000 requests/day, 10 ms CPU per request) should be fine for light use.
  Very large container reads may hit the 10 ms CPU limit; we haven't measured that yet.
- The **Workers Paid plan** ($5/month) removes that concern; this volume costs nothing extra.
- Workers KV on the free plan allows 1,000 writes a day. Sign-ins and token refreshes write to KV
  (roughly one refresh per hour of active use per client). Fine for one or a few people; heavy
  multi-user use needs the paid plan.

**Google**

- The Tag Manager API allows 10,000 requests a day per Google Cloud project, plus a low per-user
  rate limit (see APIs & Services › Tag Manager API › Quotas). Your project, your quota.
- An update costs 2 API calls (read, then write). `create_version` costs 2 (status check, then
  create). Previews are reads: 1 call for a delete (`delete_trigger` also reads the tag list). The server retries rate-limit errors with backoff.

## The 7-day sign-in problem

If your Google consent screen is **External** and in **Testing**, Google's refresh tokens expire
after 7 days. The Worker then can't refresh your Google token: it revokes the grant and your client
asks you to sign in again, about once a week. Ways around it:

1. **Google Workspace:** make the consent screen **Internal**. No expiry, no verification.
2. **Publish the app to Production.** Tag Manager scopes may need Google verification, but for your
   own use an unverified app works: you click through a "Google hasn't verified this app" warning,
   and there's a 100-user cap.
3. **Accept the weekly sign-in.**

Details in [docs/google-setup.md](docs/google-setup.md#the-7-day-problem).

## Development

Requires Node.js 24 and pnpm (version pinned in `package.json`).

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Local Worker on `http://localhost:8787`. Copy `.dev.vars.example` to `.dev.vars` first |
| `pnpm test` | Tests (vitest inside workerd). No `.dev.vars` or network needed |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm format` | Biome check / check with fixes |
| `pnpm gen` | Regenerate `src/gtm/generated.ts` from Google's Discovery document |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `pnpm run deploy` | Deploy to your Cloudflare account |

`pnpm dev` runs `wrangler dev --infer-origin-from-routes=false`. To finish a Google sign-in locally,
add `http://localhost:8787/callback` as a redirect URI in your OAuth client.

[GTM_API_QUIRKS.md](GTM_API_QUIRKS.md) lists the Tag Manager API behaviour the server works
around, with the tests for each.

## Trademarks

Google Tag Manager is a trademark of Google LLC. This project is not affiliated with Google.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
