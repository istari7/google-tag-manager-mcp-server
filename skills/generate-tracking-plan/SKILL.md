---
name: generate-tracking-plan
title: Write a tracking plan
description: Document what a GTM workspace tracks as a Markdown tracking plan, covering events, parameters, triggers, variables and the data layer pushes the site must make. Changes nothing.
live-data: workspace
include: [data-layer]
tags: [documentation, read-only]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Write a tracking plan

Produce a Markdown document that explains what the workspace tracks, for
marketers and for the site's developers. This is a read-only task.

## Get the data

If the workspace contents are not included below, find the IDs
(`list_accounts` → `list_containers` → `list_workspaces`, asking the user
when there is a choice) and read `list_tags`, `list_triggers` and
`list_variables`. Use `get_tag` for the full event parameters of each tag
you document.

## Document structure

```markdown
# Tracking plan: <container name>

## Overview
What is tracked, with which tools (GA4, Ads, …), and counts of tags,
triggers and variables.

## Events
One row per event: event name, tag (name and type), trigger(s), parameters
and where each value comes from, destination (measurement ID or account).

## Triggers
Name, type, conditions in plain words, and which tags use it.

## Variables
Name, type, what it returns and where it is used.

## Data layer contract
Every dataLayer event and key the site must push, with an example push per
event.

## Consent
Which tags wait for which consent signals, if any.

## Notes
Paused tags, gaps, inconsistencies, and anything that looks broken.
```

Prefer tables for the Events, Triggers and Variables sections. Describe
conditions in plain words ("Page Path starts with /checkout"), not raw JSON.
Mark anything you infer rather than read as "(inferred)".
