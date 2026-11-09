---
title: "Naming and organisation"
description: "How to name tags, triggers and variables, when to use folders, and what counts as clutter."
order: 20
---

# Naming and organisation

Someone scanning the container list should know what each entity does
without opening it. Good names also make search, audits and code review of
versions much faster.

## Format

Lead with the vendor or kind, then narrow down. Separate the parts with
` - ` and use the same separator everywhere in the container.

| Entity | Shape | Examples |
|---|---|---|
| Tag | vendor - tag type - purpose | `GA4 - Event - generate_lead`, `Google Ads - Conversion - Purchase`, `LinkedIn - Insight Tag` |
| Trigger | trigger kind - condition | `Custom Event - sign_up`, `Click - Download PDF`, `Page View - Thank You`, `Link Click - Outbound` |
| Variable | source - value | `DLV - order_id`, `Constant - GA4 Measurement ID`, `Lookup - Environment`, `CJS - Page Category` |

Guidelines:

- A custom event trigger repeats the exact event name it listens for, so a
  search for the event finds both the push and the trigger.
- Use the same spelling for the same vendor everywhere (`GA4`, never a mix
  of `GA4`, `Analytics` and `ga4`).
- Defaults such as `New Tag`, `Untitled Trigger`, numbers alone or
  `Copy of ...` are always a finding in a review.
- If an ID or URL appears in more than one place (measurement ID, pixel ID,
  conversion label), keep it in one constant or lookup-table variable and
  reference that.

## Folders

- Once a container has more than a couple of dozen entities, group them in
  folders by vendor or role, for example `GA4`, `Ads`, `Consent`, `Helpers`.
- When folders exist, put every new entity in the right one
  (`parentFolderId` on create, or `move_entities_to_folder` afterwards).
  Create a folder with `create_folder` if none fits.

## Clutter to report

List these for the user with a short reason each. Remove them only once the
user agrees to each item:

- **Unused triggers:** not used as a firing or blocking trigger by any tag.
- **Unused variables:** no tag, trigger or other variable refers to
  `{{Variable Name}}` (check custom HTML and custom JavaScript too).
- **Long-paused tags:** paused with no note explaining why, and still paused
  after several releases.
- **Near-duplicates:** two triggers or variables that do the same thing
  under different names.
