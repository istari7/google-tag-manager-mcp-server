---
title: "GTM best practices (index)"
description: "Start here: ground rules for every task, and which topic to read before creating or editing anything."
---

# GTM best practices

Practical guidance for working on a Google Tag Manager container through this
server. Each topic is a separate resource. Open the one that matches the job
before you create or change anything; they are short on purpose.

## Topics

{{topics}}

For whole workflows (auditing a container, planning a change, a tracking
plan), see the skills at `gtm://skills`.

## Ground rules for every task

1. **Follow the house style.** When a container already has a consistent way
   of naming or organising things, keep to it, even if it differs from these
   guides. Point out inconsistencies rather than adding a second style.
2. **Inventory first.** Before adding anything, look at what is there
   (`list_tags`, `list_triggers`, `list_variables`, `list_folders`,
   `list_built_in_variables`). Reusing an existing trigger or variable beats
   creating a near-copy.
3. **Nothing goes live without the user's go-ahead.** Workspace edits and
   saved versions do not reach the website; only publishing a version does.
   Publish (`publish_version`) only when the user has explicitly asked for that
   version to go live, otherwise they publish it in the GTM UI. Say plainly
   whether a change is live whenever you report one.
4. **Deleting is the user's decision.** Suggest removals with reasons; delete
   only after the user has agreed to that specific item. Deleting a workspace
   or a container is never a clean-up step: propose it on its own.
5. **Audits are lists of findings.** When asked to review a container, go
   topic by topic, rate each finding (fine / should fix / broken) and attach a
   concrete fix to every item that isn't fine.
