---
name: gtm-mcp
title: Working with this GTM MCP server
description: How to use the Google Tag Manager MCP server well. Covers finding IDs, creating tags, triggers and variables in the right order, reviewing and versioning changes, the confirm-gated publish and delete tools, and the other skills. Read it before the first GTM task in a session.
tags: [guide, workflow, safety]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
order: 10
---

# Working with this GTM MCP server

You can read and edit the user's Google Tag Manager containers through the
Tag Manager API, signed in as the user. You see exactly what their Google
account can see.

## How GTM is organised

Account → container → workspace → tags, triggers, variables and folders.

- A **container** is one website or app. Its `publicId` looks like `GTM-ABC1234`.
- A **workspace** is a draft, like a branch. Every edit happens in one.
- A **version** is a saved snapshot of a workspace. Only **publishing** a
  version changes the live site.

Nothing you do in a workspace is live. Never say it is.

## Find the IDs first

Never guess an ID. Walk down the tree and keep the IDs for the session:

1. `list_accounts` → `accountId`
2. `list_containers` → `containerId` (or `lookup_container` with a `GTM-…` ID)
3. `list_workspaces` → `workspaceId`

When there is more than one candidate at any step, ask the user which one.
Use `Default Workspace` only for small fixes the user asked for there;
otherwise `create_workspace` with a name that says what the change is.
Standard containers allow three workspaces in total.

## Look before you add

Before creating anything, list what is there (`list_tags`, `list_triggers`,
`list_variables`, `list_folders`, `list_built_in_variables`). Reuse an
existing trigger or variable instead of adding a near-copy, and follow the
container's existing naming style.

## Build bottom-up

1. **Variables**: anything tags or triggers refer to as `{{Name}}`. Enable
   built-ins such as `Click Element` with `enable_built_in_variables`.
2. **Triggers**: tags point at them by ID.
3. **Tags** last, with `firingTriggerId` set to the trigger IDs from step 2.

Format tips:

- Parameters use Google's nested shape:
  `{"type": "template", "key": "eventName", "value": "sign_up"}`; lists and
  maps nest further. When a similar entity exists, `get_tag` /
  `get_trigger` / `get_variable` it and copy its shape.
- GA4 event tags are type `gaawe`; the Google tag is `googtag`.
- Custom event triggers match the event name in `customEventFilter`. Click,
  link click and form triggers keep **all** conditions in `filter`.
- Negate a condition with `negate: true`, not a "does not" type.

## Updates

Read the entity with `get_*` first, then send only the fields that change
plus the `fingerprint` you read. A list you send replaces the stored one,
`[]` clears it, and omitted fields are kept. A fingerprint conflict means
someone else edited it: read it again and redo your change.

## Review, version, publish

1. `get_workspace_status`: summarise every pending change for the user and
   check for merge conflicts (those are resolved in the GTM UI).
2. `quick_preview_workspace` checks that the workspace compiles.
3. `create_version` with a name and notes a reviewer will understand later.
   This does **not** publish.
4. Publish only when the user explicitly asks for that version to go live:
   call `publish_version` without `confirm` first, show the preview, and call
   it again with `confirm: true` after they agree. Otherwise the user
   publishes it in the GTM UI.

## Confirm-gated tools

`delete_tag`, `delete_trigger`, `delete_variable`, `delete_folder`,
`delete_gtag_config`, `delete_workspace`, `delete_container`,
`disable_built_in_variables`, `set_user_permission`,
`delete_user_permission` and `publish_version` change nothing without
`confirm: true`. Call them without it, show the user the preview, and confirm
only after the user agrees to that specific action. `delete_container` also
needs the container's public ID typed back. Never delete as a side effect of
another task.

## Side effects to tell the user about

- Creating a GA4 event (`gaawe`), Google Ads conversion (`awct`) or
  Floodlight tag can make GTM add an unpaused Google tag and `gtagConfig`
  entries to the workspace. Check `get_workspace_status` and say so.
- `create_version` can consume a non-default workspace. Call
  `list_workspaces` again before editing further.

## Reference material

- Best practices: `gtm://best-practices` (index) and
  `gtm://best-practices/{topic}` (publishing, naming, tags, triggers,
  variables, data-layer, consent-mode). Read the relevant topic before
  creating or changing anything.
- Skills: `gtm://skills` lists the workflow guides. Each is also a prompt of
  the same name; the ones that take IDs fetch the workspace for you:
  - `audit-container`: find problems in a workspace.
  - `best-practices-review`: score a workspace against the best practices.
  - `plan-safe-edit`: turn a requested change into a step-by-step plan.
  - `generate-tracking-plan`: document what a workspace tracks.
  - `suggest-ga4-setup`: design GA4 tracking for the user's goals.
  - `find-gallery-template`: find a Community Template Gallery template.

## Mistakes to avoid

- Guessing IDs or parameter formats.
- Creating a tag before its trigger exists.
- Saving a version the user has not reviewed.
- Publishing because the user asked to "set up" or "fix" something. Ask.
- Calling a workspace change or an unpublished version "live".
