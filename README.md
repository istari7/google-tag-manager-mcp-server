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
- **Nothing goes live without a yes.** The AI edits workspaces and saves versions. Publishing a
  version, deleting a workspace and deleting a container are confirm-gated: the tool shows a
  preview first and acts only on a second call with `confirm: true`. See
  [Publishing and deleting](#publishing-and-deleting).

Written in TypeScript. OAuth comes from
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) and
the GTM client is generated from Google's Discovery document.

## Contents

- [How it works](#how-it-works)
- [Tools](#tools)
  - [Tool groups](#tool-groups)
- [Publishing and deleting](#publishing-and-deleting)
- [Skills and prompts](#skills-and-prompts)
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
on your website changes until a version is published. *admin* changes account or container
settings, which apply immediately. *destructive* deletes something, changes who has access, or
changes what your sites load, and needs `confirm: true` (without it, the tool returns a preview
of what it would do). Workspace edits reach your site only when a version is published, but some
tools act the moment they are confirmed: `publish_version`, `delete_container`,
`combine_containers` and `move_tag_id` change what your sites load; `update_account`,
`update_container`, `set_user_permission` and `delete_user_permission` change account or
container settings or access, which are not versioned; the environment tools and
`link_destination` also act at once, at container level.

The **Group** column is the tool group that [`GTM_TOOL_GROUPS`](#tool-groups) switches on.
Groups marked *optional* are off unless you enable them. A test (`test/readme.test.ts`) checks
that this table lists every tool, in its group.

| Group | Tool | What it does | Kind |
|---|---|---|---|
| `core` (always on) | `ping` | Checks the server is reachable | read |
| | `auth_status` | Shows the signed-in email, granted scopes and token expiry (never the tokens) | read |
| `accounts` | `list_accounts` | Lists the GTM accounts you can access | read |
| | `get_account` | Gets an account's settings (name, data sharing, features) | read |
| | `update_account` | Renames an account or changes its data sharing; the preview shows before and after | destructive |
| | `list_containers` | Lists the containers in an account | read |
| | `lookup_container` | Finds a container by its public ID (`GTM-XXXXXXX`); an error if there is none | read |
| | `get_container_snippet` | Returns the container's install code: the `<head>` script and the `<noscript>` body part | read |
| | `delete_container` | Deletes a container for good; needs `confirm: true` and its public ID typed back by you (the preview masks it) | destructive |
| `workspaces` | `list_workspaces` | Lists a container's workspaces | read |
| | `get_workspace` | Gets a workspace's name, description and fingerprint | read |
| | `create_workspace` | Creates a workspace (containers allow only a few); it starts from the latest saved version, which may not be the live one | write |
| | `update_workspace` | Renames a workspace or changes its description (other fields are kept) | write |
| | `delete_workspace` | Deletes a workspace and its unversioned changes; the preview counts them | destructive |
| | `get_workspace_status` | Shows pending changes and merge conflicts | read |
| | `quick_preview_workspace` | Checks a workspace compiles by building a throwaway preview; saves and publishes nothing | read |
| | `create_version` | Saves the workspace as a new container version. Does not publish. Refuses when there are no changes or there are merge conflicts | write |
| | `publish_version` | Makes a version live; the preview shows the version (each tag's paused state) and what is live now | destructive |
| | `get_live_version` | Gets the currently published version | read |
| | `list_versions` | Lists container versions and marks the live one | read |
| | `get_version` | Summarises a saved version (or returns all of it with `full: true`) | read |
| | `get_latest_version_header` | Gets the latest version, the base new workspaces start from (may differ from live) | read |
| `tags` | `list_tags`, `get_tag` | Lists tags / gets one tag in full | read |
| | `create_tag`, `update_tag` | Creates a tag / changes some fields of a tag (other fields are kept); for GA4, Google Ads and Floodlight tags, also reports the Google tag and configs GTM adds by itself | write |
| | `delete_tag` | Deletes a tag; the preview shows the tag | destructive |
| `triggers` | `list_triggers`, `get_trigger` | Lists triggers / gets one trigger in full | read |
| | `create_trigger`, `update_trigger` | Creates a trigger / changes some fields of a trigger, fixing known API pitfalls in its conditions | write |
| | `delete_trigger` | Deletes a trigger; the preview lists the tags and trigger groups that use it (GTM refuses the delete until they stop) | destructive |
| `variables` | `list_variables`, `get_variable` | Lists variables / gets one variable in full | read |
| | `create_variable`, `update_variable` | Creates a variable / changes some fields of a variable | write |
| | `delete_variable` | Deletes a variable; the preview lists the tags, triggers and variables that use it as `{{name}}` (GTM refuses the delete until they stop) | destructive |
| `builtins` | `list_built_in_variables` | Lists the enabled built-in variables | read |
| | `enable_built_in_variables` | Enables built-in variables (Page URL, Click ID, …) | write |
| | `disable_built_in_variables` | Disables built-in variables; the preview skips ones that are not enabled | destructive |
| `folders` | `list_folders` | Lists folders | read |
| | `get_folder_entities` | Lists the tags, triggers and variables in a folder | read |
| `guidance` | `get_tag_templates`, `get_trigger_templates` | Example `create_tag` / `create_trigger` arguments for common tag and trigger types (no API call) | read |
| `templates` (optional) | `list_templates` | Lists custom templates with the `cvt_…` type their tags or variables use (no template code) | read |
| | `get_template` | Gets one template with its `.tpl` code (optionally without it) | read |
| | `create_template`, `update_template` | Creates a template from `.tpl` code / changes its name or code (other fields are kept) | write |
| | `import_gallery_template` | Imports a Community Template Gallery template by GitHub owner and repository, accepting its declared permissions | write |
| | `delete_template` | Deletes a template; the preview lists the tags and variables that use it | destructive |
| `zones` (optional, GTM 360) | `list_zones`, `get_zone` | Lists zones / gets one zone in full | read |
| | `create_zone`, `update_zone` | Creates a zone / changes some fields of a zone (boundary conditions as a JSON string) | write |
| | `delete_zone` | Deletes a zone; the preview shows the zone | destructive |
| `server` (optional, server containers) | `list_clients`, `get_client` | Lists clients / gets one client in full | read |
| | `create_client`, `update_client` | Creates a client / changes some fields of a client (other fields are kept) | write |
| | `delete_client` | Deletes a client; the preview shows the client | destructive |
| | `list_transformations`, `get_transformation` | Lists transformations / gets one transformation in full | read |
| | `create_transformation`, `update_transformation` | Creates a transformation / changes some fields of a transformation (other fields are kept) | write |
| | `delete_transformation` | Deletes a transformation; the preview shows the transformation | destructive |
| `environments` (optional) | `list_environments`, `get_environment` | Lists a container's environments / gets one with its authorization code | read |
| | `create_environment` | Creates a user environment (e.g. staging); applies immediately | admin |
| | `update_environment` | Changes an environment; repointing it to another version or workspace needs `confirm: true` | destructive |
| | `reauthorize_environment` | Issues a new authorization code; the old one stops working | destructive |
| | `delete_environment` | Deletes a user environment; pages using its snippet stop loading it | destructive |
| `destinations` (optional) | `list_destinations`, `get_destination` | Lists the Google tag destinations linked to a container / gets one | read |
| | `link_destination` | Links a destination to this container, moving it from its current one | destructive |
| `gtag` (optional) | `list_google_tag_configs`, `get_google_tag_config` | Lists the Google tag configs GTM creates with GA4, Ads and Floodlight tags (type and tag ID) / gets one in full | read |
| | `create_google_tag_config`, `update_google_tag_config` | Creates a Google tag config / changes its type or parameters | write |
| | `delete_google_tag_config` | Deletes a Google tag config, e.g. one left behind after its tag was deleted | destructive |
| `users` (optional) | `list_user_permissions` | Lists who can access an account and its containers | read |
| | `set_user_permission` | Adds a user or changes their account / container access; the preview shows before and after | destructive |
| | `delete_user_permission` | Removes a user from an account | destructive |
| `container-admin` (optional) | `get_container` | Gets a container's settings, tag IDs, features and fingerprint | read |
| | `create_container` | Creates a container (web, android, ios, amp or server) | admin |
| | `update_container` | Changes a container's name, domains, notes or server URLs (other fields are kept) | admin |
| | `combine_containers` | Merges another container of the account into this one; the preview shows both | destructive |
| | `move_tag_id` | Moves a tag ID out into a new container; confirming also needs `acceptTerms: true` | destructive |
| `folder-admin` (optional) | `get_folder` | Gets a folder with its fingerprint | read |
| | `create_folder` | Creates a folder | write |
| | `update_folder` | Renames a folder or changes its notes (other fields are kept) | write |
| | `move_entities_to_folder` | Moves tags, triggers and variables into a folder (folder `0` = out of any folder) | write |
| | `delete_folder` | Deletes a folder; the preview lists what is in it, which is kept, and the result says what was moved out | destructive |
| `workspace-admin` (optional) | `sync_workspace` | Brings a workspace's unchanged entities up to the latest version; clashes become merge conflicts; needs `confirm: true` | write |
| | `resolve_workspace_conflict` | Replaces a conflicting tag, trigger, variable or folder with the resolved one; the preview shows both sides | destructive |
| | `bulk_update_workspace` | Adds, updates and deletes several tags, triggers, variables and folders in one call (new IDs `new_1`, `new_2`, …) | destructive |
| `version-admin` (optional) | `update_version` | Renames a version or changes its description | write |
| | `delete_version` | Deletes (archives) a version other than the live one; `undelete_version` restores it | destructive |
| | `undelete_version` | Restores a deleted version; needs `confirm: true` | write |
| | `set_latest_version` | Makes a version the latest (the base for new workspaces and syncs); does not publish; needs `confirm: true` | write |
| `reverts` (optional) | `revert_workspace_entity` | Discards a workspace's changes to one tag, trigger, variable, folder, zone, template, client, transformation or built-in variable; the preview shows what is undone | destructive |

The server also offers best-practice guides and skills as MCP resources and prompts; see
[Skills and prompts](#skills-and-prompts).

### Tool groups

Every tool's name, description and input schema is sent to the AI in each conversation, so a
long tool list costs context. `GTM_TOOL_GROUPS` (a var in `wrangler.jsonc`, or in the Cloudflare
dashboard under the Worker's Settings › Variables) picks which groups MCP clients see. The group
names are the same as the Go `gtm-mcp-server`'s `GTM_TOOL_GROUPS`, so a value that works there
works here.

| Value | Tools listed |
|---|---|
| empty (the default) | The default groups below: 44 tools, about 33 KB of tool definitions (the limit is 40 KB) |
| `default,users,gtag` | The default groups plus `users` and `gtag` |
| `tags,triggers,variables` | Only those groups (plus `core`) |
| `all` | Every group: 100 tools, about 75 KB, so every conversation starts with more context used |

The value is comma-separated and case-insensitive. `core` (`ping`, `auth_status`) is always on.
An unknown name makes every `/mcp` request fail with an error that names it, and `/setup` shows
the same error, so a typo can't silently change what clients see.

- **Default:** `accounts`, `workspaces` (including versions and publishing), `tags`, `triggers`,
  `variables`, `folders` (reading), `builtins`, `guidance`.
- **Optional:** `templates` (custom templates), `zones` (GTM 360), `server` (server-side
  containers), `environments`, `destinations`, `gtag` (Google tag configs), `users` (user
  permissions), `container-admin`, `folder-admin` (create, edit, fill and delete folders),
  `workspace-admin` (sync, conflicts, bulk edits), `version-admin`, `reverts`.

Unlike the Go server, `templates`, `zones` and `server` are optional here, to keep the default
list small. `pnpm tools-report` prints the size of each group.

## Publishing and deleting

These tools change your live site or remove work for good, so each one takes two calls:

- **`publish_version`** makes a saved version live on every site that loads the container. The
  first call (no `confirm`) shows what the version contains and what is live now; only a second
  call with `confirm: true` publishes. The best-practices guide tells the AI to publish only when
  you have explicitly asked for that version to go live. To roll back, publish an earlier version.
- **`delete_workspace`** discards a workspace and its unversioned changes. Saved versions and the
  live container are not affected.
- **`delete_container`** deletes a container, its workspaces and its versions. Besides
  `confirm: true` it needs the container's public ID (`GTM-XXXXXXX`) typed back, so a wrong
  numeric ID can't delete the wrong container.
- **`combine_containers`** and **`move_tag_id`** change which container a tag ID loads, at once.
  Their previews show the containers involved; `move_tag_id` also needs `acceptTerms: true` for
  the terms of service copied to the new container, and never copies users.

`publish_version`, `delete_workspace` and `delete_container` need the `tagmanager.publish` and
`tagmanager.delete.containers` scopes. If you'd rather not allow them, leave those scopes out of
`GOOGLE_SCOPES` and the consent screen: the tools then fail with a permission error, and `/setup`
lists which tools are affected. There is no tool to delete an account (the API has no such
method).

## Skills and prompts

Besides tools, the server ships guidance the AI can load when it needs it. None of it counts
against the `tools/list` budget.

| What | Over MCP | Source |
|---|---|---|
| Best practices | Resources `gtm://best-practices` (index) and `gtm://best-practices/{topic}` | `docs/best-practices/*.md` |
| Skills | Resources `gtm://skills` (index) and `gtm://skills/{name}`, plus one prompt per skill | `skills/<name>/SKILL.md` |
| Server instructions | Sent at `initialize`; point the AI at both resource trees | Built from the files above |
| `GET /llms.txt` | Public plain-text overview of the server, its skills and topics | Built from the files above |

| Skill (= prompt) | What it does | Prompt arguments |
|---|---|---|
| `gtm-mcp` | How to use this server: IDs, build order, review, versions, confirm-gated tools | none |
| `audit-container` | Finds problems in a workspace and proposes a fix for each | `accountId`, `containerId`, `workspaceId` (optional) |
| `best-practices-review` | Scores a workspace pass / warn / fail per best-practice area | `accountId`, `containerId`, `workspaceId` (optional) |
| `generate-tracking-plan` | Writes a Markdown tracking plan for a workspace | `accountId`, `containerId`, `workspaceId` (optional) |
| `plan-safe-edit` | Turns a change request into a step-by-step plan to approve | `change`; `accountId`, `containerId` (optional) |
| `suggest-ga4-setup` | Designs GA4 tags, triggers, variables and data layer pushes | `goals` |
| `find-gallery-template` | Finds a Community Template Gallery template, checks it and imports it (`import_gallery_template`, optional `templates` group) | `templateName` |

A prompt is the skill's text plus the arguments you give it and the best-practice topics the
skill relies on. When a prompt that takes IDs gets them, it also reads the workspace (tags,
triggers, variables, folders) or the container (its workspaces) as you and includes a compact
summary, so the AI starts with the data. Without IDs it tells the AI how to find them. In Claude
Code the prompts appear as `/mcp__gtm__<name>`.

The skill files use the Agent Skills layout (a folder with a `SKILL.md` that has `name` and
`description` frontmatter), so you can also copy a `skills/<name>/` folder into `.claude/skills/`
to use it as a local Claude Code skill. The live data only comes with the MCP prompt.

### Adding a skill or a best-practice topic

1. Create `skills/<name>/SKILL.md` (or `docs/best-practices/<topic>.md`) with YAML frontmatter:

   ```yaml
   ---
   name: my-skill            # must equal the folder name: lowercase letters, digits, hyphens
   title: My skill           # optional
   description: One or two sentences, shown in resource and prompt lists.
   arguments:                # optional prompt arguments (always strings)
     - name: goal
       description: What the user wants
       required: true
   live-data: workspace      # optional: workspace | container. Adds the ID arguments and live data
   include: [naming, tags]   # optional: best-practice topics added to the prompt
   tags: [audit]             # optional; skills tagged "guide" are included in full in /llms.txt
   order: 50                 # optional list position (default 100), then by name
   license: ...              # optional; attribution for adapted material
   ---

   # My skill

   The instructions, in Markdown.
   ```

   A best-practice topic takes only `title`, `description` and `order`; its file name is its
   name. `docs/best-practices/index.md` lists the topics where it says `{{topics}}`.
2. Run `pnpm gen:skills`. It validates the frontmatter and rewrites `src/skills/generated.ts`
   (never edit that file by hand). `pnpm test` and CI fail when the file is stale.
3. Deploy. Workers have no file system at runtime, so the files are bundled at build time.

Editing only the Markdown body of an existing file needs no regeneration.

## Safety model

- **Allowlist.** Sign-in is refused unless the Google account is in `ALLOWED_EMAILS` or belongs
  to a Google Workspace domain in `ALLOWED_DOMAINS`. With neither set, nobody can sign in. Without
  this, anyone who found your URL could sign in and use your project's GTM API quota.
- **Per-client consent.** Each MCP client must be approved on a consent page before the Google
  sign-in. The approval is remembered in that browser for 30 days.
- **`confirm: true`** is required by every *destructive* tool: the `delete_*` tools,
  `disable_built_in_variables`, `set_user_permission`, `update_account`, `publish_version`,
  `reauthorize_environment`, `link_destination`, `update_environment` (when it repoints),
  `revert_workspace_entity`, `resolve_workspace_conflict`, `bulk_update_workspace`,
  `combine_containers` and `move_tag_id` (which also needs `acceptTerms: true`), and by the
  hard-to-undo `sync_workspace`, `undelete_version` and `set_latest_version`. Without it they only
  describe what would happen. `delete_container` also needs the container's public ID, and the
  user-access tools warn when the change is to your own access.
- **No lost edits.** GTM updates replace the whole object. Update tools read the current entity,
  merge only the fields you change, and write it back with Google's fingerprint. They also take
  the `fingerprint` the AI saw in its earlier `get_*` call: if someone changed the entity since
  (in the GTM UI, say), the update fails with a conflict instead of overwriting their work. See
  [GTM_API_QUIRKS.md](GTM_API_QUIRKS.md).
- **Workspaces are drafts.** Changes made in a workspace are not on your site until a version is
  created (`create_version`) and published (`publish_version`, or in the GTM UI). `create_version`
  refuses when the workspace has no changes or has merge conflicts.
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
| `tagmanager.edit.containers` | Every other write: workspaces and everything in them (tags, triggers, variables, folders, built-in variables, Google tag configs, zones, clients, transformations, custom templates; syncs, conflicts, bulk edits, reverts), containers (create, update, combine, move tag ID), environments (except reauthorizing), destinations, and `set_latest_version` |
| `tagmanager.edit.containerversions` | `create_version`, `quick_preview_workspace`, `update_version`, `delete_version`, `undelete_version` |
| `tagmanager.publish` | `publish_version`, `reauthorize_environment` |
| `tagmanager.delete.containers` | `delete_workspace`, `delete_container` |
| `tagmanager.manage.accounts` | `get_account`, `update_account` |
| `tagmanager.manage.users` | `list_user_permissions`, `set_user_permission`, `delete_user_permission` |

- `tagmanager.publish` and `tagmanager.delete.containers` are optional. Without them the server
  works the same, except that `publish_version`, `reauthorize_environment`, `delete_workspace`
  and `delete_container` fail with a permission error. `/setup` lists any that are missing.
- After changing `GOOGLE_SCOPES`, redeploy and reconnect each client so Google asks for the new
  set of permissions.
- `tagmanager.manage.accounts` and `tagmanager.manage.users` are optional too: without them only
  the account and user tools fail.
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
  create). Previews are reads: 1 call for a delete (`delete_trigger` also reads the tag and
  trigger lists, `delete_variable` the tag, trigger and variable lists, `delete_workspace` the
  workspace status), 2 for `publish_version` (the version and the live one). Creating a GA4,
  Google Ads or Floodlight tag costs 2 more calls (the workspace status before and after). A confirmed `delete_container` costs 2 (it re-reads the public ID). The server retries rate-limit errors with backoff.

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
| `pnpm gen:skills` | Regenerate `src/skills/generated.ts` after adding a skill or best-practice file or changing frontmatter (`--check` to verify) |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `pnpm tools-report` | Size of the `tools/list` response per tool group, for the default groups and for `all` |
| `pnpm run deploy` | Deploy to your Cloudflare account |

`pnpm dev` runs `wrangler dev --infer-origin-from-routes=false`. To finish a Google sign-in locally,
add `http://localhost:8787/callback` as a redirect URI in your OAuth client.

[GTM_API_QUIRKS.md](GTM_API_QUIRKS.md) lists the Tag Manager API behaviour the server works
around, with the tests for each.

## Trademarks

Google Tag Manager is a trademark of Google LLC. This project is not affiliated with Google.

## License

BSD 3-Clause. See [LICENSE](LICENSE). The skills adapt material from
[gtm-mcp-server](https://github.com/paolobietolini/gtm-mcp-server) by Paolo Bietolini
(BSD 3-Clause); see [NOTICE](NOTICE).
