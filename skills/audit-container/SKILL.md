---
name: audit-container
title: Audit a GTM workspace
description: Find problems in a GTM workspace (naming, duplicates, unused triggers and variables, tags that never fire, GA4 and consent wiring, risky custom HTML) and report each with a concrete fix. Changes nothing.
live-data: workspace
include: [naming, tags, triggers, consent-mode]
tags: [audit, review, read-only]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Audit a GTM workspace

Review the workspace and report what is wrong or risky. This is a read-only
task: change nothing, and propose deletions as findings for the user to
decide on.

## Get the data

If the workspace contents are not included below, find the IDs
(`list_accounts` → `list_containers` → `list_workspaces`, asking the user
when there is a choice), then read `list_tags`, `list_triggers`,
`list_variables` and `list_folders`. Use `get_tag` / `get_trigger` /
`get_variable` when you need the full parameters of an item.

## What to check

1. **Naming.** Is there one consistent pattern? Flag defaults (`New Tag`,
   `Untitled Trigger`, `Copy of …`) and names that don't say what the item
   does. If the container has its own consistent convention, accept it and
   only flag the items that break it.
2. **Duplicates.** Tags of the same type sending the same event or ID;
   triggers with the same conditions; variables reading the same value.
3. **Unused and dead items.** Triggers nothing uses (`usedBy: 0`),
   variables nothing refers to (`references: 0`, but check custom HTML and
   custom JavaScript too), active tags with no firing trigger, tags paused
   without a note.
4. **GA4.** Exactly one Google tag per measurement ID, on an Initialization
   trigger; the ID kept in a variable; event tags using recommended event
   names and data layer variables for changing values.
5. **Consent.** If the site has a consent banner: the CMP tag on Consent
   Initialization, consent defaults set, and consent settings on tags that
   need them.
6. **Security and performance.** Custom HTML that loads external scripts,
   holds secrets or personal data, or scrapes the DOM; tags that could use a
   built-in type or a Community Template instead.
7. **Organisation.** In bigger containers, entities outside folders or in
   the wrong one.

## Report

Group findings by the headings above. For each finding give the entity
(name and ID), a rating (**fine**, **should fix** or **broken**) and the
concrete fix: the new name, the field to change, or the tool call to make.
End with a short, prioritised list of fixes and ask which ones the user
wants you to make. Make no change until they say so.
