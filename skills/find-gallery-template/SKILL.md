---
name: find-gallery-template
title: Find a Community Template Gallery template
description: Find a tag or variable template in the GTM Community Template Gallery (consent banners, ad pixels, …), check it before use, and import it with import_gallery_template.
arguments:
  - name: templateName
    description: The template or vendor to look for, e.g. "Cookiebot" or "LinkedIn Insight"
    required: true
tags: [templates, gallery]
license: BSD-3-Clause. Adapts material from gtm-mcp-server by Paolo Bietolini; see NOTICE.
---

# Find a Community Template Gallery template

Help the user find and add a Community Template Gallery template. Importing
needs the optional `templates` tool group (`GTM_TOOL_GROUPS`); if
`import_gallery_template` is not in your tool list, the user can add the
template in the GTM UI instead (see the end of this skill).

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

1. Call `import_gallery_template` with the workspace IDs, `galleryOwner` and
   `galleryRepository` (the GitHub owner and repository), and optionally
   `gallerySha` to pin a commit, without `confirm`: it only previews. The
   API can't read a template before importing it, so the preview can't list
   its permissions; read them in the repository's `template.tpl`.
2. Tell the user which template you will import (owner and repository) and
   what its permissions allow, and get their go-ahead: importing accepts the
   template's declared permissions on their behalf. Then call it again with
   `confirm: true`. The result includes the template's `type` (`cvt_…`),
   which tags or variables built from it use.
3. Create the tag (or variable) with `create_tag` / `create_variable` using
   that type, following the template's documentation for its parameters. If
   another tag already uses the template, read it with `get_tag` and copy its
   parameter shape. `list_templates` shows the templates already in the
   workspace and their types.
4. Review, version and publish as usual (`plan-safe-edit`).

Without the `templates` group, the user imports it in the GTM UI, in the
workspace you are working in: **Templates → Tag Templates (or Variable
Templates) → Search Gallery**, pick the template, then **Add to workspace**.
`get_workspace_status` then shows it as a pending change, and a tag created
from it has the type `cvt_<containerId>_<templateId>`.
