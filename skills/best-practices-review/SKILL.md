---
name: best-practices-review
title: Score a workspace against the best practices
description: Score a GTM workspace pass / warn / fail per best-practice area (naming and organisation, tags, triggers, variables, consent) and give a concrete fix for every warn and fail. Changes nothing.
live-data: workspace
include: [naming, tags, triggers, variables, consent-mode]
tags: [audit, review, read-only, best-practices]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Score a workspace against the best practices

Grade the workspace against the best-practice guides included below (or
read them from `gtm://best-practices`). This is a read-only task.

## Get the data

If the workspace contents are not included below, find the IDs
(`list_accounts` → `list_containers` → `list_workspaces`, asking the user
when there is a choice) and read `list_tags`, `list_triggers`,
`list_variables` and `list_folders`.

## Scoring

Score each area:

| Area | Guide |
|---|---|
| Naming and organisation | naming |
| Tags | tags |
| Triggers | triggers |
| Variables | variables |
| Consent | consent-mode (skip it when the site has no consent banner, and say so) |

- **pass**: the rules are followed.
- **warn**: minor deviations. List each one.
- **fail**: clear violations. List each one.

The container's own house style wins: when it consistently follows a
different convention than the guide, score that as a pass and note the
difference instead of asking for a rename.

## For every warn and fail

Name the entity (name and ID) and give the exact fix: the new name, the
field and value to change, or the tool call to make. Keep it short.

## Finish

End with a prioritised fix list (broken first, then the changes that make
the container easier to maintain) and ask which fixes to make. Make no
change until the user says so.
