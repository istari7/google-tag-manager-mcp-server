---
title: "Triggers"
description: "Choosing a trigger type and writing its conditions correctly (filter vs autoEventFilter, negate)."
order: 40
---

# Triggers

## Choosing the type

| Situation | Type |
|---|---|
| The site pushes an event (`dataLayer.push({event: "sign_up"})`) | `customEvent`, the most robust choice |
| The Google tag and other setup tags | `init` (Initialization) |
| Consent defaults and the consent banner tag, nothing else | `consentInit` (Consent Initialization) |
| A tag that needs the page or DOM state | `pageview`, `domReady` or `windowLoaded` |
| Route changes in a single-page app | a custom event the app pushes, or `historyChange` |
| Clicks, link clicks, form submits | `click`, `linkClick`, `formSubmission` |
| Several things must all have happened | `triggerGroup` |

If an existing trigger already has the conditions you need, reuse it.
Prefer a data layer event over watching clicks on a CSS selector: page
redesigns break selectors, not events.

## Writing a condition

Each condition has a `type` and two parameters: `arg0` is the variable,
`arg1` the value to compare with.

```json
{"type": "startsWith", "parameter": [
  {"type": "template", "key": "arg0", "value": "{{Page Path}}"},
  {"type": "template", "key": "arg1", "value": "/account"}]}
```

- Comparison types: `equals`, `contains`, `startsWith`, `endsWith`,
  `matchRegex`, `cssSelector`, `urlMatches`, `less`, `lessOrEquals`,
  `greater`, `greaterOrEquals`.
- **Negation** is not a separate type. Add `negate: true` to the condition
  (the server turns it into Google's boolean `negate` parameter). The
  `doesNotContain` shorthand becomes `contains` plus negate.
- For a case-insensitive regex, add the boolean parameter `ignore_case`.
- Every condition in a list must match (AND). For OR, use one regex or
  separate triggers.
- The variable in `arg0` has to exist. Enable built-ins such as
  `Click Element` or `Page Path` with `enable_built_in_variables` first.

## filter, autoEventFilter, customEventFilter

- `customEventFilter`: on `customEvent` triggers, matches the event name
  (`{{_event}}` equals `sign_up`).
- `filter`: the general conditions. For `click`, `linkClick` and
  `formSubmission` triggers, put **all** conditions here. Google does not
  keep `autoEventFilter` on those types; if you send it anyway, the server
  appends those conditions to `filter` and returns a warning.
- On update, sending `filter` replaces the stored list, `[]` clears it, and
  omitting it keeps it.

## Click, link and form triggers

- Target stable hooks: an element ID or a `data-` attribute, matched with
  `cssSelector` on `{{Click Element}}`. Avoid generated class names and
  visible text that may be translated.
- The "wait for tags" and "check validation" options (`waitForTags`,
  `waitForTagsTimeout`, `checkValidation`) exist only on `linkClick` and
  `formSubmission`. Google drops them on plain `click` triggers.
- Turn on "wait for tags" only when a tag must finish before the browser
  navigates, and limit the trigger to the pages where that matters.

## Trigger groups

A `triggerGroup` fires once every listed trigger has fired on the page. Its
`triggerIds` parameter is a `list` of `triggerReference` items.
