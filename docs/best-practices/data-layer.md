# Data layer

The data layer is the contract between the website and the container. Tags
are only as reliable as the pushes they depend on, so treat it as an
interface the site's developers own and you document.

## What a good push looks like

```js
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({
  event: "form_submit",
  form_id: "newsletter",
  form_position: "sidebar"
});
```

- The `event` key and every value that belongs to it travel in the **same**
  push. Values pushed separately may not be there when the trigger fires.
- Name events and keys in `snake_case`, and keep them stable once in use.
- Name the event after what the visitor did (`form_submit`, `purchase`), not
  after the tool that consumes it (`send_to_meta`).
- Initialise `window.dataLayer` before pushing, and before the GTM snippet
  when the page sets values that tags need on page load.

## Ecommerce

- Use GA4's ecommerce shape: an `ecommerce` object holding `items[]`,
  `currency` and `value`, plus `transaction_id` on `purchase`.
- Push `{ ecommerce: null }` before each ecommerce event. The data layer
  merges objects, so old items would otherwise carry into the next event.

```js
window.dataLayer.push({ ecommerce: null });
window.dataLayer.push({
  event: "view_item",
  ecommerce: { currency: "USD", value: 49, items: [{ item_id: "SKU-1", price: 49 }] }
});
```

## Personal data

Do not push email addresses, phone numbers, names or street addresses. The
exception is a feature that is designed for it and covered by consent, such
as enhanced conversions, and even then only in the form that feature
requires.

## Briefing the developer

Whenever you add a custom event trigger or a data layer variable, give the
user a short spec for their developer:

1. the event name and when it should fire;
2. each key, its type and an example value;
3. a sample push, as above.

GTM cannot react to an event the site never sends. Ask the user to confirm
the push in GTM Preview / Tag Assistant before relying on it, and prefer this
route over reading the page with custom JavaScript.
