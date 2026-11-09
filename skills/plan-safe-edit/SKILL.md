---
name: plan-safe-edit
title: Plan a safe change
description: Turn a requested GTM change into a step-by-step plan with the exact tool calls, in dependency order, through a dedicated workspace, review and a saved version, and publishing only on the user's go-ahead. Shows the plan before doing anything.
live-data: container
arguments:
  - name: change
    description: The change to make, e.g. "Track sign_up as a GA4 event"
    required: true
include: [publishing, naming]
tags: [planning, workflow, safety]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Plan a safe change

Turn the user's change request into a plan they can approve before anything
is touched. Do not call any tool that writes until the user accepts the plan.

## Before planning

- If the container and its workspaces are not included below, find them
  (`list_accounts` → `list_containers` → `list_workspaces`), asking the user
  when there is a choice.
- Read what exists in the workspace you will build on (`list_tags`,
  `list_triggers`, `list_variables`, `list_folders`) so the plan reuses
  existing triggers and variables and follows the container's naming.
- If the request is ambiguous (which pages, which event names, which
  property), ask before planning.

## The plan

Number every step and give the exact tool and the important arguments:

1. **Workspace.** `create_workspace` named after the change. If the
   container already has three workspaces, ask which stale one to finish or
   delete first; never delete one yourself.
2. **Variables** to create or enable (`create_variable`,
   `enable_built_in_variables`), with proposed names.
3. **Triggers** (`create_trigger`), with type and conditions.
4. **Tags** (`create_tag`), with type, key parameters and which trigger
   from step 3 fires each one. Note any Google tag GTM may add on its own.
5. **Folders** for the new items when the container uses folders.
6. **Review.** `get_workspace_status` and `quick_preview_workspace`, then
   summarise the changes for the user.
7. **Version.** `create_version` with a proposed name and notes.
8. **Publish.** Only if the user explicitly wants this version live:
   `publish_version` without `confirm` to preview, then with
   `confirm: true` after they agree. Otherwise they publish it in the GTM UI.
   Suggest testing in GTM Preview first either way.

Also list what to test after publishing, and how to roll back (republish the
previous live version).

Show the plan and wait for the user's go-ahead before step 1.
