# Tags

## Google tag and GA4

- Load each GA4 property once, with a Google tag (type `googtag`; older
  containers may still have the legacy `gaawc` configuration tag) on an
  Initialization trigger, so it runs before event tags.
- Keep the measurement ID in a variable, not in the tag. Use a constant, or a
  lookup table on hostname when test and staging sites must report to a
  different property.
- Two Google tags that resolve to the same ID double count every page. More
  than one Google tag is only correct when data deliberately goes to several
  properties.
- GA4 event tags (type `gaawe`) refer to the same measurement ID variable in
  `measurementIdOverride` and fire on the trigger for their event.
- Creating a GA4 event, Google Ads conversion (`awct`) or Floodlight tag can
  make GTM add an **unpaused** Google tag for that destination to the
  workspace, even if your tag is paused. Check `get_workspace_status`
  afterwards and tell the user, since it may duplicate an existing Google tag.

## Event names and parameters

- Use Google's recommended event names where one fits (`login`, `sign_up`,
  `view_item`, `add_to_cart`, `begin_checkout`, `purchase`). Name custom events
  in `snake_case`, starting with a verb (`download_brochure`).
- Take changing values from data layer variables (`{{DLV - value}}`); keep
  literals for values that are truly fixed.
- For ecommerce events, turn on the tag's option to send ecommerce data from
  the data layer rather than mapping each item field by hand.

## When a tag fires

- Every active tag needs at least one firing trigger. One without any never
  fires and should be reported.
- To fire "everywhere except ...", add a blocking trigger (exception) instead
  of rewriting the firing trigger's conditions in reverse.
- `tagFiringOption` defaults to `oncePerEvent`, which suits most tags.
  `oncePerLoad` is for tags that must run at most once per page, such as a
  library loader.
- Use tag sequencing (`setupTag`, `teardownTag`) only for a real dependency,
  for example a script that must load before the tag that calls it.

## Custom HTML

- Check for a built-in tag type or a Community Template first. Templates have
  declared permissions and are easier to review; custom HTML (`html`) can do
  anything and some sites block it by policy.
- Never put secrets, API keys or personal data in custom HTML. Everything in
  a container is downloadable by any visitor.
- Read values through GTM variables instead of scraping the DOM.

## Paused tags

`paused: true` keeps a tag in the container without firing it. Always say why
in `notes`, so the next audit can decide whether to resume or remove it.

## Double counting checklist

- The site's source also contains a hard-coded gtag.js snippet for an ID that
  GTM loads too.
- A tag has two firing triggers that match the same event.
- Two event tags send the same event name for the same action.
