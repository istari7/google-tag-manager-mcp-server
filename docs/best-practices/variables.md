---
title: "Variables"
description: "Picking the right variable type: data layer, built-ins, constants, lookup tables, custom JavaScript."
order: 50
---

# Variables

Variables are how tags and triggers read values. Fewer, well-named variables
make a container easier to audit, so reuse before you create.

## Choose the simplest source

| Need | Type | Notes |
|---|---|---|
| A value the site pushes | `v` Data Layer Variable | First choice. Ask the developer to push it. |
| A fixed ID used in several tags | `c` Constant | `CONST - GA4 Measurement ID` |
| A value that depends on another | `smm` Lookup Table / `remm` RegEx Table | e.g. measurement ID by hostname |
| Part of the URL | `u` URL | Pick the component (query key, path, host) |
| A cookie | `k` 1st-Party Cookie | |
| Clicked element data | built-ins (`Click URL`, `Click ID`…) or `aev` Auto-Event Variable | Enable the built-in before using it |
| Anything else | `jsm` Custom JavaScript | Last resort: small, pure, always returns |

## Rules

- Enable built-in variables (`list_built_in_variables`) instead of recreating
  them as custom variables.
- Data layer variables use version 2 (`dataLayerVersion` = `2`) and the exact
  key the site pushes, including nesting (`ecommerce.transaction_id`).
- A DLV default value is either omitted or a `template` parameter. An empty
  `integer` default is rejected by Google.
- Custom JavaScript must be a single `function() { … }` that returns a value,
  has no side effects (no pushes, no DOM writes) and handles missing data.
- Don't create two variables that read the same thing. Search the list first.
- Reference variables as `{{Exact Name}}`. Renaming a variable does not
  rewrite references inside custom HTML or custom JavaScript: check them.
- Never store secrets in variables. Container contents are public to anyone
  who loads the site.
