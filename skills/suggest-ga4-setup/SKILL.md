---
name: suggest-ga4-setup
title: Design a GA4 setup
description: Recommend the GA4 tags, triggers, variables and data layer pushes for the user's tracking goals, with exact GTM parameter shapes, a build order and a test checklist. Plans only; builds nothing until the user agrees.
arguments:
  - name: goals
    description: What to track, e.g. "purchases, newsletter sign-ups, outbound link clicks"
    required: true
include: [tags, triggers, variables, data-layer]
tags: [ga4, planning]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Design a GA4 setup

Recommend a GA4 implementation in GTM for the user's goals. Plan first; build
only after the user agrees, ideally through the `plan-safe-edit` workflow.

## First

- If you have access to the container, list its tags, triggers and
  variables. Reuse an existing Google tag, measurement ID variable and
  triggers rather than adding parallel ones.
- Ask for anything you can't infer: the measurement ID, whether the site has
  a consent banner, whether the developers can add data layer pushes.

## Recommend

1. **Events.** Map each goal to a GA4 event. Use Google's recommended names
   where one fits (`sign_up`, `generate_lead`, `purchase`, …), otherwise
   `snake_case` starting with a verb. List each event's parameters.
2. **Variables.** One constant or lookup table for the measurement ID; a
   data layer variable (`v`) per changing value; built-ins to enable.
3. **Triggers.** Prefer a custom event (`customEvent`) the site pushes over
   click or CSS-selector triggers.
4. **Tags.** One Google tag (`googtag`) on an Initialization trigger if
   there isn't one, then one GA4 event tag (`gaawe`) per event.
5. **Data layer.** The exact `dataLayer.push` per event for the developers.
6. **Build order and tests.** Variables → triggers → tags, then what to
   check in GTM Preview and GA4 DebugView for each event.

Use names that follow the container's convention, or the naming guide.

## Parameter shapes

When the container already has a similar entity, read it with `get_tag` /
`get_trigger` / `get_variable` and copy its shape. Otherwise:

Data layer variable:

```json
{"name": "DLV - method", "type": "v", "parameter": [
  {"type": "integer", "key": "dataLayerVersion", "value": "2"},
  {"type": "boolean", "key": "setDefaultValue", "value": "false"},
  {"type": "template", "key": "name", "value": "method"}]}
```

Custom event trigger:

```json
{"name": "Custom Event - sign_up", "type": "customEvent", "customEventFilter": [
  {"type": "equals", "parameter": [
    {"type": "template", "key": "arg0", "value": "{{_event}}"},
    {"type": "template", "key": "arg1", "value": "sign_up"}]}]}
```

Google tag (fires on an Initialization trigger):

```json
{"name": "Google Tag - GA4", "type": "googtag", "parameter": [
  {"type": "template", "key": "tagId", "value": "{{CONST - GA4 Measurement ID}}"}]}
```

GA4 event tag with one event parameter (`firingTriggerId` is the trigger's ID):

```json
{"name": "GA4 - Event - sign_up", "type": "gaawe", "firingTriggerId": ["<trigger ID>"],
 "parameter": [
  {"type": "template", "key": "eventName", "value": "sign_up"},
  {"type": "template", "key": "measurementIdOverride", "value": "{{CONST - GA4 Measurement ID}}"},
  {"type": "list", "key": "eventSettingsTable", "list": [
    {"type": "map", "map": [
      {"type": "template", "key": "parameter", "value": "method"},
      {"type": "template", "key": "parameterValue", "value": "{{DLV - method}}"}]}]}]}
```

For ecommerce events, set the boolean parameter `sendEcommerceData` to
`true` and push the `ecommerce` object from the site instead of mapping each
item by hand.
