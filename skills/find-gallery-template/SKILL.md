---
name: find-gallery-template
title: Find a Community Template Gallery template
description: Find a tag or variable template in the GTM Community Template Gallery (consent banners, ad pixels, …), check it before use, and walk the user through adding it. This server cannot import gallery templates itself.
arguments:
  - name: templateName
    description: The template or vendor to look for, e.g. "Cookiebot" or "LinkedIn Insight"
    required: true
tags: [templates, gallery]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Find a Community Template Gallery template

Help the user find and add a Community Template Gallery template. This
server has no tool to import templates, so the user adds it in the GTM UI and
you take over from there.

## Find it

1. Search the gallery: `https://tagmanager.google.com/gallery/#/?filter=<name>`.
   If you can browse the web, also search for "<name> GTM community
   template github": every gallery template lives in a public GitHub
   repository.
2. Prefer the vendor's own template (published by the vendor's GitHub
   organisation) over a third-party one.
3. Before recommending it, check the repository: recent updates, open
   issues, and the permissions the template asks for (which URLs it may
   inject scripts from, cookies, data layer access). Tell the user what it
   can access.
4. If no maintained template exists, say so and suggest the vendor's
   documented setup instead. Custom HTML is a last resort.

## Add it

The user imports it in the GTM UI, in the workspace you are working in:
**Templates → Tag Templates (or Variable Templates) → Search Gallery**, pick
the template, then **Add to workspace**.

Then:

1. `get_workspace_status` shows the imported template as a pending change
   with its template ID.
2. A tag created from the template has the type `cvt_<containerId>_<templateId>`.
   If another tag already uses the template, read it with `get_tag` and copy
   its type and parameter shape.
3. Create the tag with `create_tag` following the template's documentation,
   then review, version and publish as usual (`plan-safe-edit`).
