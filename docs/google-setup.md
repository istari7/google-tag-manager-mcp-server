# Google Cloud setup

The Worker signs you in with Google and calls the Tag Manager API with your Google token. For
that it needs a Google OAuth client from a Google Cloud project you own. This takes about ten
minutes.

Before you start, deploy the Worker (see [deploy.md](deploy.md)) and open
`https://<your-worker>/setup`. You'll need the **redirect URI** shown there.

Google renames console menus from time to time. The labels below match the Google Cloud console
("Google Auth Platform" pages) as of November 2026. If a label differs, look for the closest match.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/>.
2. Click the project picker at the top, then **New project**.
3. Name it (for example `gtm-mcp`) and click **Create**. Make sure it's selected afterwards.

[screenshot: project picker with "New project"]

A dedicated project keeps the API quota and the OAuth client separate from anything else you run.

## 2. Enable the Tag Manager API

1. Go to **APIs & Services › Library**.
2. Search for **Tag Manager API** and open it.
3. Click **Enable**.

[screenshot: Tag Manager API page with the Enable button]

Without this, sign-in works but every tool call fails with a permission error.

## 3. Configure the consent screen

1. Go to **Google Auth Platform** (APIs & Services › OAuth consent screen redirects there) and
   click **Get started** if the project has no consent screen yet.
2. **App information:** an app name (shown on Google's sign-in screen, e.g. "GTM MCP") and a
   support email.
3. **Audience:**
   - **Internal** if you use Google Workspace and everyone who will sign in is in your
     organisation. Recommended: no 7-day expiry, no verification.
   - **External** otherwise (for example with a personal Gmail account).
4. **Contact information:** your email. Accept the policy and click **Create**.

[screenshot: Google Auth Platform "Get started" form, Audience step]

### Add the scopes

1. Open **Data Access** and click **Add or remove scopes**.
2. Add these scopes. Filter by "tagmanager", or paste the full URLs into **Manually add scopes**:

   | Scope | Why |
   |---|---|
   | `https://www.googleapis.com/auth/tagmanager.readonly` | All read tools |
   | `https://www.googleapis.com/auth/tagmanager.edit.containers` | Editing workspaces, tags, triggers, variables, folders |
   | `https://www.googleapis.com/auth/tagmanager.edit.containerversions` | `create_version` |

   `openid`, `email` and `profile` are always requested too. They need no setup.

   Do **not** add `tagmanager.publish` or `tagmanager.delete.containers`. This server never
   publishes a version or deletes a container (a person publishes in the GTM UI), so it doesn't
   need them, and `/setup` warns if they are in `GOOGLE_SCOPES`.
3. Click **Update**, then **Save**.

[screenshot: Data Access page listing the three Tag Manager scopes]

The list must match what the Worker asks for: the `GOOGLE_SCOPES` var in `wrangler.jsonc`. The
`/setup` page lists the scopes it requests. If `GOOGLE_SCOPES` also has
`tagmanager.manage.accounts` or `tagmanager.manage.users`, either add them here too or remove them
from `GOOGLE_SCOPES` (no tool uses them).

### Add test users (External apps in Testing only)

While an External app is in **Testing**, only listed test users can sign in. Everyone else gets
"Access blocked".

1. Open **Audience**.
2. Under **Test users**, click **Add users** and add every Google account that will sign in (the
   same accounts as in `ALLOWED_EMAILS`).

[screenshot: Audience page with the Test users section]

## 4. Create the OAuth client

1. Open **Clients** and click **Create client**.
2. **Application type:** Web application.
3. **Name:** anything, e.g. "GTM MCP Worker".
4. **Authorized redirect URIs:** click **Add URI** and paste the redirect URI from `/setup`,
   exactly: `https://<your-worker>/callback`.
   - For local development also add `http://localhost:8787/callback`.
   - **Authorized JavaScript origins** can stay empty.
5. Click **Create**.

[screenshot: Create OAuth client ID form with the redirect URI filled in]

Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** now. Newer
projects show the secret only once. If you lose it, add a new secret on the client's page and
delete the old one.

Google notes that changes to an OAuth client can take a few minutes to apply. If sign-in fails
with `redirect_uri_mismatch` right after you create the client, wait and try again.

## 5. Store the client ID and secret in Cloudflare

From your clone of the repository:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Paste each value when asked. Then set the other secrets if you haven't (see
[deploy.md](deploy.md#secrets)) and reload `/setup`: every item should be ✅.

Connect a client (the `/setup` page has the snippets). The first connection shows the Worker's
consent page and then Google's.

## The 7-day problem

Google gives apps that are **External** and in **Testing** refresh tokens that expire after
**7 days**. After that the Worker can't renew your Google access: Google answers `invalid_grant`,
the Worker revokes the grant, and your MCP client asks you to sign in again. Pick one:

### Option 1: Internal (Google Workspace only)

If every user is in your Workspace organisation, set **Audience › User type** to **Internal**.
Refresh tokens don't expire after 7 days and no verification is needed. Use `ALLOWED_DOMAINS` for
your domain if you want the whole organisation to have access.

### Option 2: Publish to Production

On **Audience**, click **Publish app**. Refresh tokens then last until revoked.

- Tag Manager scopes are sensitive scopes, so Google may ask you to verify the app before it is
  shown to the public. For your own use you don't have to: an unverified app in Production still
  works, but everyone sees a "Google hasn't verified this app" warning (click **Advanced**, then
  continue), and it is capped at 100 users.
- The test-user list no longer applies. Anyone with a Google account can reach Google's consent
  screen, so the Worker's `ALLOWED_EMAILS` / `ALLOWED_DOMAINS` allowlist is what keeps others out.
  Keep it set.

### Option 3: Accept weekly sign-ins

Stay in Testing and sign in again when your client asks. Nothing else breaks: workspaces, edits
and versions are stored in GTM, not in the Worker.

## Changing scopes later

After you add a scope:

1. Add it on **Data Access**.
2. Add it to `GOOGLE_SCOPES` in `wrangler.jsonc` and run `pnpm run deploy`.
3. Reconnect each client (in Claude Code: `/mcp` › `gtm` › re-authenticate). Google only asks for
   new scopes at sign-in, and `auth_status` shows what was granted.

## Revoking access

To cut off the Worker's access to your Google account, remove the app at
<https://myaccount.google.com/permissions>. Clients then need to sign in again.
