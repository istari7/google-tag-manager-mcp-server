# GTM API quirks

Every known way the Tag Manager API v2 surprises a client, what we do about it,
and the test that proves our handling. Each entry is what we observed from
Google's API (its Discovery document, its responses, and live calls against a
test container). Read this before touching any create or update tool.

- **Tests** are in `test/quirks.test.ts` unless marked `client:`, which means
  `test/gtm-client.test.ts`, or `tools/<file>:`, which means
  `test/tools/<file>.test.ts` (the same behaviour seen through an MCP tool call,
  asserting the exact outgoing request). Test names start with the quirk
  number, so `pnpm test -t Q3` runs one quirk.
- **Code:** `src/gtm/merge.ts` (get-merge-put), `src/gtm/quirks.ts`
  (normalisation), `src/gtm/client.ts` and `src/gtm/errors.ts` (transport),
  `src/tools/*.ts` (the tools that use them).

Add an entry whenever manual testing turns up something new, with a test.

## Updates and concurrency

### Q1. Updates are PUT, which replaces everything

- **Google:** `tags.update`, `triggers.update`, `variables.update` and
  `folders.update` are `PUT`. Any field left out of the body is erased.
- **We:** `updateTag` / `updateTrigger` / `updateVariable` / `updateFolder`
  GET the stored entity, overlay the caller's fields (`mergeForUpdate`) and
  PUT the whole object. The stored object is never mutated.
- **Tests:** `Q1 merge keeps every field the patch omits`,
  `Q1 updateTag GETs the tag, then PUTs the whole merged object`,
  `Q1 updateVariable and updateFolder also send the full object`,
  `Q1 the merge does not mutate the stored object`;
  tools/tags: `Q1/Q2: GETs the tag, then PUTs the whole merged object with ?fingerprint=`,
  `Q1: changing one field keeps parameters, triggers, setup tags, consent, notes and folder`;
  tools/triggers: `Q1/Q2/Q6: GET, then PUT of the merged trigger…`;
  tools/variables: `Q1/Q2: GET, then PUT of the merged variable with ?fingerprint=`.

### Q2. The fingerprint is a query parameter, not a body field

- **Google:** optimistic concurrency uses `?fingerprint=` on `update`,
  `revert` and `resolve_conflict`. A mismatch returns 409 or 412, except on
  `revert`, where Google ignores it (Q32).
- **We:** `prepareUpdate` takes the fingerprint from the GET and sends it as
  the query parameter, and removes `fingerprint` from the body (including one
  the caller put in the patch). Get-merge-put alone only protects the gap
  between our GET and PUT. So the update helpers also take
  `expectedFingerprint`: the fingerprint from the model's earlier read. If it
  no longer matches, we fail with a conflict before writing. 409/412 are
  never retried.
- **Tests:** `Q2 prepareUpdate returns the stored fingerprint separately…`,
  `Q2 the PUT carries ?fingerprint=<stored> and no body fingerprint…`,
  `Q2 a stale expectedFingerprint fails with a conflict before any write`,
  `Q2 a matching expectedFingerprint goes ahead`,
  `Q2 a 409 from Google during the PUT surfaces as a conflict…`;
  client: `Q2: tags.update sends the fingerprint as a query parameter, not in the body`,
  `omits an undefined fingerprint entirely`;
  tools/tags: `Q2: a stale fingerprint fails with a conflict and sends no PUT`,
  `Q2: a 409 from Google on the PUT is a conflict, not retried` (the same stale-fingerprint
  test is in tools/triggers and tools/variables).

### Q3. `autoEventFilter` is silently ignored on click, linkClick and formSubmission triggers

- **Google:** Google silently ignores `autoEventFilter` on `click`,
  `linkClick` and `formSubmission` triggers, so conditions sent there are
  lost.
- **We:** the server adds a non-empty `autoEventFilter` to the end of
  `filter` on all three types and warns the caller. To replace the filter
  instead, send `filter` directly. On update, the effective type is the
  patch's `type` or else the stored type, and with no `filter` in the patch
  the conditions are added to the stored `filter` (Q10). An empty
  `autoEventFilter: []` is a clear (Q7), not a remap.
- **Tests:** `Q3 only those three trigger types are affected`,
  `Q3 create click|linkClick|formSubmission: autoEventFilter is moved to filter`,
  `Q3 other trigger types keep autoEventFilter untouched`,
  `Q3 an empty autoEventFilter is not remapped (it is a clear, Q7)`,
  `Q3 update uses the stored type when the patch has none`,
  `Q3 createTrigger sends the remapped body`;
  tools/triggers: `Q3/Q4: a click trigger's autoEventFilter lands in filter, without companions…`,
  `Q3/Q10/Q11: an autoEventFilter patch on a stored linkClick is appended to its filter…`.

### Q4. Companion fields are only valid on linkClick and formSubmission

- **Google:** `waitForTags`, `checkValidation` and `waitForTagsTimeout` are
  only valid on `linkClick` and `formSubmission` triggers; on plain `click`
  triggers Google silently drops them (confirmed in a live E2E run).
- **We:** when an `autoEventFilter` is remapped on `linkClick` or
  `formSubmission`, the server fills in missing or wrongly typed companions
  with typed defaults (`{type:"boolean",value:"false"}`,
  `{type:"boolean",value:"false"}`, `{type:"integer",value:"2000"}`;
  `CLICK_TRIGGER_COMPANIONS`) and keeps any existing values. A wrongly typed
  value is coerced when its value fits the type. On `click` it adds no
  companions.
- **Tests:** `Q4 only linkClick and formSubmission take companions; Google drops them on click`,
  `Q4 the defaults have the exact parameter types…`,
  `Q4 create: companions are set when autoEventFilter is remapped`,
  `Q4 create formSubmission: companions are set when autoEventFilter is remapped`,
  `Q4 create click: autoEventFilter is remapped but no companions are added`,
  `Q4 click: companions the caller sends are passed through unrepaired`,
  `Q4 create: no companions when nothing was remapped`,
  `Q4 companions given by the caller are kept`,
  `Q4 a wrongly typed companion is coerced when its value fits, else reset`.

### Q5. `doesNotContain` is not a valid condition type

- **Google:** the Discovery `Condition.type` enum has no `doesNotContain`.
  The GTM UI stores "does not contain" as `contains` plus a parameter
  `{type:"boolean", key:"negate", value:"true"}`.
- **We:** `normalizeCondition` turns `doesNotContain` into that shape. It also
  accepts a `negate: true` shorthand on any condition type. The negate
  parameter is never duplicated. All three filter lists are normalised.
- **Tests:** `Q5 doesNotContain becomes contains + a boolean negate parameter`,
  `Q5 negate: true is turned into the parameter without duplicating an existing one`,
  `Q5 plain conditions pass through unchanged`,
  `Q5 is applied to filter, autoEventFilter and customEventFilter`,
  `Q5 + Q3: a doesNotContain autoEventFilter on a linkClick lands in filter…`;
  tools/triggers: `Q5: doesNotContain becomes contains + a boolean negate parameter`.

### Q6. `uniqueTriggerId` is server-generated

- **Google:** `Trigger.uniqueTriggerId` is generated when output is built.
  It is not an input field, so we never send it back.
- **We:** it is stripped from every trigger create and update body, along with
  the body `fingerprint` (Q2) (`stripServerFields`, `normalizeTrigger`).
- **Tests:** `Q6 it is stripped from trigger update bodies`,
  `Q6 it is stripped from create bodies and from patches`;
  tools/triggers: `Q1/Q2/Q6: GET, then PUT of the merged trigger…`.

### Q7. An omitted list is not the same as an empty list

- **Google:** because of Q1, leaving a list out of the PUT erases it. Callers
  need a way to say "keep it" and a different way to say "clear it".
- **We:** in a patch, `undefined` keeps the stored value, and `[]` replaces it
  (clears). An empty list is sent as `[]`, never dropped from the JSON.
  This applies to every list: filters, `parameter`, `firingTriggerId`,
  `setupTag`, `teardownTag` and so on.
- **Tests:** `Q7 normalizeConditions keeps undefined apart from []`,
  `Q7 updateTrigger <field>/<omitted|clear|replace>` (12 cases: each filter
  list omitted, cleared or replaced),
  `Q7 tag lists: [] clears firing triggers, setup and teardown; omitted keeps them`,
  `Q7 variable parameter: [] clears, omitted keeps`;
  tools/tags: `Q7/Q12: [] clears firing triggers and "" clears notes…`;
  tools/triggers: `Q7: filter: [] clears the conditions; the other filter lists are kept`.

### Q8. Template update: fingerprint in the query, the body, or both (unverified)

- **Google:** unverified. The Discovery document declares a `fingerprint`
  query parameter on `templates.update`, like every other update (Q2), and
  `CustomTemplate` also has a `fingerprint` field. Paolo's Go server sends it
  only in the body and its update works, so Google at least accepts a body
  fingerprint. Which one Google actually checks is not known.
- **We:** `updateTemplate` (`merge.ts`) GETs the template, merges, and sends
  the **stored** fingerprint both as `?fingerprint=` and in the body (never
  one from the patch). Both carry the same value, so whichever one Google
  reads, an unchanged template is accepted and one changed since our GET is
  refused. The model's own stale read is caught before any write by
  `expectedFingerprint` (the `fingerprint` argument of `update_template`), as
  for every other entity. Every other entity still uses the query parameter
  only.
- **Still to verify live** (sandbox container, a throwaway custom template):
  1. `update_template` with no `fingerprint` succeeds (proves that sending
     both is accepted, no 400).
  2. A raw PUT with a stale `?fingerprint=` and the current body fingerprint:
     409/412 means Google checks the query parameter.
  3. A raw PUT with the current `?fingerprint=` and a stale body fingerprint:
     409/412 means Google checks the body; success means the body value is
     ignored (then the body copy can be dropped).
  4. A PUT that sends `galleryReference` back unchanged on a gallery import
     keeps the gallery link (Q1 makes us send it; whether GTM sets
     `isModified` after a `templateData` change is also unknown).
- **Tests:** `Q8 the generic update path (every other entity) never puts the fingerprint in the body`,
  `Q8 updateTemplate sends the stored fingerprint as ?fingerprint= and in the body, not the patch's`,
  `Q8 a stale expectedFingerprint fails before any write…`; `Q8 live: …` is an
  `it.todo` for steps 2 and 3; tools/templates:
  `Q1/Q8: GET, then PUT of the whole template with the stored fingerprint…`.

### Q9. Workspace edits are not live until a version is created and published

- **Google:** every create, update and delete changes only the workspace.
  Nothing reaches the site until `create_version` and then `publish`.
- **We:** only `publish_version` makes a version live, and only on a second
  call with `confirm: true` (README, "Publishing and deleting"). Every
  workspace write (create, update, delete, folders, built-ins) ends its result
  with `UNPUBLISHED_CHANGES_NOTE` from `quirks.ts`. `create_workspace` uses
  `WORKSPACE_NOT_LIVE_NOTE` and `create_version` says the version is saved but
  not live, and that publishing needs the user's explicit go-ahead. Only a
  confirmed `publish_version` says "now LIVE". Tool descriptions and
  `get_workspace_status` say the same thing.
- **Tests:** `Q9 the note tells the model how to make a change live`;
  tools/workspaces: `Q9 says pending changes are not live yet`; every write test in
  `test/tools/` checks the note.

## Trigger, tag and variable details

### Q10. `filter` and `autoEventFilter` both given on a click, linkClick or formSubmission trigger

- **Google:** `autoEventFilter` is dropped (Q3), whatever is in `filter`.
  Remapping only when `filter` is empty, or replacing `filter` with the
  remapped conditions, would silently lose conditions.
- **We:** always append. GTM ANDs all conditions, so the result is what
  the caller meant. The base is the `filter` in the same call when there is
  one, and otherwise, on update, the stored `filter` (an omitted list means
  "keep", Q7).
- **Tests:** `Q10 autoEventFilter is appended to filter, not dropped`,
  `Q10 update without filter: autoEventFilter is appended to the stored filter…`,
  `Q10 update with filter: autoEventFilter is appended to the patch's filter…`;
  tools/triggers: `Q10: on linkClick, autoEventFilter is appended to an existing filter`,
  `Q3/Q10/Q11: an autoEventFilter patch on a stored linkClick is appended to its filter…`.

### Q11. Companions are repaired on update too

- **Google:** the Q4 companion rules apply to whatever the PUT stores, so
  they matter on update as much as on create.
- **We:** apply Q4 on update as well, but keep stored companion values that
  already have the right type. A user's "wait for tags: true" is not reset to
  false. A stored click trigger gets no companions.
- **Tests:** `Q11 stored companion values are kept when the remap happens on update`,
  `Q11 a stored click trigger gets no companions on update`,
  `Q11 missing companions are filled in on update`;
  tools/triggers: `Q3/Q10/Q11: an autoEventFilter patch on a stored linkClick is appended to its filter…`.

### Q12. Notes: an empty string clears them, and omitting them keeps them

- **Google:** under Q1, omitted `notes` are erased. To clear notes you have to
  send `""` explicitly.
- **We:** the merge treats `""` as a value (it replaces) and `undefined` as
  "keep".
- **Tests:** `Q12 tag|trigger|variable: omitted notes are preserved`,
  `Q12 tag|trigger|variable: "" is sent explicitly and clears the notes`;
  tools/tags: `Q7/Q12: [] clears firing triggers and "" clears notes…`;
  tools/variables: `Q12/Q13: a rename keeps notes and folder`.

### Q13. `parentFolderId` must survive updates

- **Google:** under Q1, leaving `parentFolderId` out of the PUT moves the
  entity out of its folder.
- **We:** the merge starts from the stored entity, so the folder is kept unless
  the caller changes it. Moving between folders should use
  `move_entities_to_folder` (Q19).
- **Tests:** `Q13 tag|trigger|variable: an update that doesn't mention the folder keeps it`;
  tools/variables: `Q12/Q13: a rename keeps notes and folder`.

### Q14. Consent settings have a specific nested shape

- **Google:** `Tag.consentSettings.consentStatus` is
  `notSet | notNeeded | needed`. For `needed`, the consent types are a
  `consentType` parameter of type `list` whose items are `template`
  parameters (`ad_storage`, `analytics_storage`, …).
- **We:** `buildConsentSettings(status, types)` builds exactly that shape. It
  trims the type names and drops empty ones. It ignores the types unless the
  status is `needed`. The tools take `consentStatus` / `consentTypes`, and
  `normalizeTag` turns them into `consentSettings` on create and update.
  Because the Q1 merge is shallow, a fresh `consentSettings` would replace the
  stored one whole, so on update: `consentStatus: "needed"` without
  `consentTypes` keeps the stored `consentType`; `consentTypes` alone are
  allowed when the stored status is `needed` (they replace the types and keep
  the status); `consentTypes` alone on any other stored status (or on create)
  are refused before any write; any status other than `needed` drops the
  types.
- **Tests:** `Q14 needed + types → list of template parameters`,
  `Q14 notSet / notNeeded carry no consent types`,
  `Q14 update: consentStatus "needed" without consentTypes keeps the stored types`,
  `Q14 update: consentTypes alone replace the types when the stored status is "needed"`,
  `Q14 update: consentTypes alone on a tag not stored as "needed" is refused before the PUT`,
  `Q14 update: a status other than needed drops the stored types`,
  `Q14 create: consentTypes without consentStatus is refused before the POST`;
  tools/tags: `POSTs {workspace}/tags with exactly the given fields and Q14 consent settings`,
  `Q14: consentStatus replaces the consent settings`,
  `Q14: a tag stored with consent "needed"` (status alone keeps the types; types alone replace them),
  `Q14: consentTypes alone on a tag not stored as "needed" is refused, with no PUT`.

### Q15. A Data Layer Variable can't have an empty `integer` defaultValue

- **Google:** a DLV (`type: "v"`) whose `defaultValue` parameter has type
  `integer` and an empty value is rejected. Omitting `defaultValue`, or
  sending it as a `template` parameter, works.
- **We:** `normalizeVariable` rewrites that parameter to an empty `template`
  and returns a warning. It runs on create and on update; on update it uses
  the stored type when the patch has none.
- **Tests:** `Q15 an empty integer defaultValue on a DLV is sent as an empty template`,
  `Q15 non-DLV variables and non-empty integers are left alone`,
  `Q15 update uses the stored type, and createVariable applies the fix`;
  tools/variables: `Q15: an empty integer defaultValue on a DLV is sent as an empty template…`,
  `Q15 applies on update using the stored type`.

### Q16. Retry policy

- **Google:** 429 and the rate-limit kinds of 403 (`rateLimitExceeded`,
  `userRateLimitExceeded`, or `RATE_LIMIT_EXCEEDED` in `details`) mean the
  request was not processed and can be sent again after a pause. A plain
  403 is a real permission error, and a daily-quota 403
  (`dailyLimitExceeded`) won't clear within seconds.
- **We:** retry 429 and rate-limit 403s for every method, except the one
  call whose 429 is not a rate limit: `create_google_tag_config` (Q31). Retry 5xx **only
  for GET**. Backoff is 1 s, 2 s, 4 s, with at most 3 retries. We never retry
  400/401/404/409/412, a plain permission 403, or a daily-quota 403.
- **Why writes are not retried on 5xx:** Google can fail after committing.
  A retried POST (`create_tag`, `create_version`, `quick_preview`,
  `move_entities_to_folder`, …) can then apply twice or make
  a duplicate, and a retried PUT carries the old `?fingerprint=` (Q2), so it
  comes back as a false conflict. Instead, a 5xx on a
  write says the write may or may not have been applied and tells the model
  to re-read the entity before retrying.
- **Tests:** `Q16 a plain permission 403 is not retried; a rate-limit 403 is`;
  client: `retries 429 | 403 rateLimitExceeded | 403 userRateLimitExceeded | 500 | 503 with 1s/2s/4s backoff…` (GET),
  `Q16 a POST|PUT|DELETE retries 429 | 403 rateLimitExceeded | 403 userRateLimitExceeded…`,
  `Q16 a POST|PUT|DELETE is not retried on 500|502|503…`,
  `Q16 5xx on a write → the write may or may not have been applied…`,
  `gives up after 3 retries…`, `never retries 400|401|403|404|409|412`,
  `does not retry a daily-quota 403…`.

### Q17. Show Google's error text only when it adds information

- **Google:** errors repeat the same text in `error.message` and
  `error.errors[].message`, and many messages ("Not Found", "The caller does
  not have permission") only restate the status code.
- **We:** `informativeDetail` removes duplicate messages, drops a list of
  generic phrasings, uses a raw text body only when there is no structured
  error (and never HTML), and caps the result at 500 characters. Each status
  gets its own fixed sentence.
- **Tests:** `Q17 Google's duplicate errors[] message is shown once, generic messages not at all`;
  client: the whole `error mapping` block.

### Q18. List endpoints paginate

- **Google:** `list` methods return `nextPageToken`. Reading only the first
  page silently misses entities in large containers.
- **We:** `listAll()` follows `nextPageToken` for every list, up to 20 pages
  by default. It returns `truncated: true` and the next token when it hits the
  cap, and it stops if Google repeats a token.
- **Tests:** `Q18 tags are read from every page, not just the first`; client:
  the `pagination` block (cap, custom cap, repeated token, empty page).

### Q19. `move_entities_to_folder` takes the IDs as repeated query parameters

- **Google:** the entity IDs are `?tagId=1&tagId=2&triggerId=3…`. The body
  is an empty Folder. Folder ID `0` means "move out of the current folder"
  (Discovery description).
- **We:** query arrays are encoded as repeated keys, and empty arrays are
  skipped. `folderPath` accepts `0`.
- **Tests:** client: `Q19: move_entities_to_folder repeats tagId/triggerId/variableId query keys`;
  tools/folders: `Q19: POSTs {folder}:move_entities_to_folder with repeated ID query keys…`,
  `Q19: folder "0" moves entities out of their folder`.

### Q20. `create_version` can succeed without creating a version

- **Google:** `CreateContainerVersionResponse` can be a 200 response with no
  `containerVersion` (nothing to version), with `compilerError: true`, or
  with `syncStatus.mergeConflict` / `syncError`.
- **We:** `create_version` first reads the workspace status and refuses
  (without calling `create_version`) when there are no changes or there are
  merge conflicts, naming the conflicting entities. After the call,
  `createVersionProblem(response)` turns each failure shape into an error
  result. `quick_preview_workspace` gets the same treatment
  (`quickPreviewProblem`), since `QuickPreviewResponse` has the same fields.
- **Tests:** `Q20 each failure shape has its own message`,
  `Q20 a created version is not a problem`;
  tools/versions: `Q20: a 200 with … is an error`, `refuses a workspace with no changes…`,
  `refuses a workspace with merge conflicts…`;
  tools/workspaces: `Q20 shapes: … is an error`.

### Q21. Custom methods use `{+path}:verb` and reserved expansion

- **Google:** paths such as `{+path}:sync`, `{+path}:move_entities_to_folder`
  and `{+path}/bulk_update` expand `path` without encoding `/`.
- **We:** generated wrappers check each path parameter against the Discovery
  `pattern`, reject empty, `.` and `..` segments, and percent-encode each
  segment, so `?` or `#` in an ID can't change the URL. `request()` also
  refuses absolute URLs and leading slashes, so the bearer token only ever goes
  to `tagmanager.googleapis.com/tagmanager/v2/`.
- **Tests:** client: `Q21: custom verbs keep '/' in {+path} and append ':verb'`,
  `Q21: wrappers reject a path that doesn't match the Discovery pattern`,
  `percent-encodes odd characters inside a segment…`,
  `refuses absolute URLs, leading slashes and dot segments…`.

## From Google's general error model

### Q22. Not every 403 is a permission problem

- **Google:** 403 is also returned when the Tag Manager API is not enabled in
  the Cloud project (`SERVICE_DISABLED` / `accessNotConfigured`, with a
  console link in the message) and when the token lacks a scope
  (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, "insufficient authentication scopes"),
  e.g. when the user unticked `tagmanager.edit.containers` on Google's consent
  screen and then calls a write tool.
- **We:** map these to their own messages: enable the API (keeping Google's
  link), or reconnect and approve every permission. Neither is retried.
  The same scope message covers `publish_version`, `delete_workspace` and
  `delete_container` on a deployment that leaves out `tagmanager.publish` or
  `tagmanager.delete.containers`.
- **Tests:** client: `403 API disabled → enable-the-API message that keeps Google's console link`,
  `403 insufficient scopes → reconnect-and-approve message`.

## Side effects of creating tags

### Q23. Google tags are created automatically for GA4, Google Ads and Floodlight tags

- **Google:** creating a GA4 event tag (`gaawe`), a Google Ads conversion tag
  (`awct`) or a Floodlight tag makes GTM auto-create an **unpaused**
  destination Google tag (e.g. "Google Analytics G-…") plus `gtagConfig`
  entries in the workspace, even when the created tag is paused. Deleting
  those tags does not remove the `gtagConfig` entries (confirmed live).
- **We:** for these types (`gaawe`, `awct`, `sp`, `flc`, `fls`), `create_tag`
  reads the workspace status before and after the POST (2 extra GETs) and
  returns every entity that appeared in between, other than the new tag, as
  `alsoChangedByGtm`, with a warning that counts the unpaused tags among them.
  `update_tag` does the same when the update sets one of these types, or
  changes `parameter` (a new measurement ID) on a tag that ends up as one of
  them; it skips the second read if the tag is another type. If a status read
  fails, the tool still returns the saved tag, with a warning to check
  `get_workspace_status`. Which of these types make GTM add a Google tag is
  confirmed live only for `gaawe`; the others follow Google's docs. The
  `tags` best-practices topic also tells the model to point the Google tag out
  to the user. To clean up, delete the auto-created Google tag with
  `delete_tag` and the leftover configs (seen live: `ogt_auto_events`,
  `ogt_1p_data_v2`) with `list_google_tag_configs` /
  `delete_google_tag_config`; that leaves the workspace with no trace (confirmed live, 2026-11-09).
- **Tests:** tools/tags: `Q23 GTM's own Google tag and gtagConfigs` (the
  status reads, the reported entities and warning, html skips the reads, a
  failed status read); tools/gtag-configs (requests and confirm gating).

## Workspace lifecycle

### Q24. Workspaces disappear and reappear on their own

- **Google:** `create_version` consumes a non-default workspace: after the
  version is saved, the workspace is gone from `list_workspaces` (it may hand
  back a `newWorkspacePath`). Deleting the last remaining workspace, even
  `Default Workspace`, succeeds, and GTM immediately creates a fresh
  `Default Workspace` with a new ID. A container never ends up with zero
  workspaces (both confirmed live, 2026-11-09).
- **We:** `create_version` reports a replacement workspace when Google names
  one. `delete_workspace` lets Google decide; the model should call
  `list_workspaces` again before editing rather than reuse an old workspace ID.
- **Tests:** none (Google-side behaviour).

### Q25. A folder must be empty before it can be deleted

- **Google:** `folders.delete` on a folder that still holds a tag, trigger or
  variable fails with a bare 400 ("Returned an error response for your
  request"). Once its contents are moved out, the same call succeeds (confirmed
  live, 2026-11-09).
- **We:** `delete_folder` lists the folder's contents in its preview. When
  confirmed, it moves them out of any folder (`move_entities_to_folder` to
  folder `0`, Q19), then deletes the folder, so nothing in it is lost.
- **Tests:** tools/folders: `Q25 with confirm: true moves the contents out (folder 0) before the DELETE`.

### Q26. A trigger or variable that is still in use can't be deleted

- **Google:** `triggers.delete` on a trigger that a tag fires on, and
  `variables.delete` on a variable a tag refers to as `{{Name}}` in a
  parameter, fail with the same bare 400 as Q25 ("Returned an error response
  for your request"), which doesn't say why. Once the tag is gone, the same
  call succeeds (both confirmed live, 2026-11-09). The same holds for a
  trigger used only in a trigger group and a variable used only in a trigger
  condition (also confirmed live); we assume it for a blocking trigger and a
  variable used in another variable (not verified).
- **We:** the `delete_trigger` preview lists the tags that fire on or are
  blocked by the trigger and the trigger groups that list it
  (`triggerReference`); the `delete_variable` preview lists the tags,
  triggers and other variables whose fields (not name or notes) contain
  `{{Name}}`. When there are any, the preview warns that GTM will refuse the
  delete until they are removed. When a confirmed delete still gets a 400, the
  tool looks the references up again and returns them in the error, with how
  to remove them (naming only the kinds that use it: tags' trigger lists
  and/or trigger groups); with none found, it says what usually causes the 400.
  References from places we don't scan (zones, clients, transformations,
  custom templates) are not detected.
- **Tests:** tools/triggers: `Q26 without confirm only reads, and lists the tags and trigger groups…`,
  `Q26 with confirm: true, GTM's bare 400 becomes an error naming what still uses the trigger`,
  `Q26 a trigger used only by a trigger group: the advice names only the group, not tags`,
  `Q26 a 400 with no reference found still says what usually causes it`;
  tools/variables: `Q26 without confirm only reads, and lists what uses {{name}}…`,
  `Q26 with confirm: true, GTM's bare 400 becomes an error naming what still uses the variable`.

### Q27. A new workspace starts from the latest saved version, not the live one

- **Google:** `workspaces.create` bases the new workspace on the container's
  latest version, even when that version was never published. Seen live
  (2026-11-09): with version 1 live and an unpublished version 2, a new
  workspace already held version 2's tags, triggers and variables.
- **We:** `create_workspace`'s result says so, so the model doesn't take
  those entities for its own changes or assume they are live. To see what is
  live, use `get_live_version`.
- **Tests:** tools/workspaces: `create_workspace POSTs name and description…`
  (the note).

## Custom templates

### Q28. The API never says what type a template's tags have

- **Google:** a tag or variable built from a custom template has a type of
  the form `cvt_…`, but `CustomTemplate` has no field for it. Paolo's server
  derives `cvt_<containerId>_<templateId>` for templates made in the
  container and `cvt_<galleryTemplateId>` for Community Template Gallery
  imports (he changed the gallery rule after using it). Both forms confirmed
  live (2026-11-09): a gallery import got `cvt_K8GSG`, a container template
  `cvt_285882497_96`, and a made-up `cvt_ZZZZZ` was refused ("Unknown entity
  type"), so GTM does check the type.
- **We:** `templateType` (`src/tools/templates.ts`) applies the same rule
  (container ID from `containerId`, else from `path`), and every template
  result carries it as `type`, next to `for` (tag, variable or client, read
  from the `___INFO___` section of `templateData`). `delete_template` lists
  the tags and variables with that type in its preview.
- **Tests:** tools/templates: `templateType: cvt_<containerId>_<templateId>, or cvt_<galleryTemplateId> for gallery imports`,
  `without confirm: true previews, listing the tags and variables of the template's type`.

## From the full live test (2026-11-09)

Every tool was called against a real web container on a standard (non-360) account. These
entries are what that run showed.

### Q29. User environments have no `type`

- **Google:** `environments.get` and `environments.list` leave `type` out of
  user environments; only Live, Latest and workspace environments carry it
  (`live`, `latest`, `workspace`). Seen on an environment made with
  `create_environment`, which sends `type: "user"`.
- **We:** `environmentType` (`src/tools/environments.ts`) reads a missing
  type as `user`. `update_environment` restricts name, description and the
  served version/workspace only on environments whose type is set and isn't
  `user`, and its refusal names that type. `list_environments` shows
  `type: "user"` for them.
- **Tests:** tools/environments: `Q29 an environment without type is a user one…`,
  `Q29 repointing an environment without type previews it…`,
  `Q29 list_environments shows type user…`,
  `refuses user-only fields on a workspace environment, naming its type`.

### Q30. A deleted version can't be read

- **Google:** `versions.get` on a deleted (archived) version answers 404 "Not
  found or permission denied", although `versions.undelete` on the same path
  works. `version_headers.list` with `includeDeleted=true` still lists it,
  with `deleted: true`.
- **We:** the `undelete_version` preview reads the version's header from
  `version_headers.list?includeDeleted=true` (every page) instead of
  `versions.get`, and says so when no version, deleted or not, has that ID.
  The confirmed call POSTs `:undelete` as before.
- **Tests:** tools/version-admin: `Q30 without confirm: true previews from the version list with includeDeleted…`,
  `Q30 refuses to preview a version that is not deleted`,
  `Q30 says so when no such version exists, deleted or not`.

### Q31. One Google tag config per type: a second create is a 429; `googtag` is not a config type

- **Google:** `gtag_config.create` with the type of a config the workspace
  already has (seen with `ogt_auto_events`) answers HTTP 429, every time
  (5 tries over ~15 minutes, while other writes went through). Once the
  existing config was deleted, the same create succeeded at once. The config
  types seen are `ogt_auto_events` and `ogt_1p_data_v2` (Q23);
  `type: "googtag"` (a *tag* type) failed with HTTP 500 "Experienced an
  internal error" and created nothing.
- **We:** `create_google_tag_config` lists the workspace's configs first and
  refuses a type that exists, naming the config ID and pointing at
  `update_google_tag_config` / `delete_google_tag_config`. The POST is sent
  once (`withoutRetries` in `src/gtm/client.ts` skips Q16's 429 retry, which
  never clears here); after a 429 the tool lists again and gives the same
  answer if a config of the type is there by then, else reports the rate
  limit. Any 429 now shows Google's text when it says more than "rate limit"
  (Q17). The `type` description names the real config types and warns off
  `googtag`.
- **Tests:** tools/gtag-configs: `Q31 lists the configs, then POSTs…`,
  `Q31 refuses a second config of a type…`, `Q31 a 429 on the POST is not retried…`,
  `Q31 a 429 with no config of the type behind it is reported as a rate limit…`,
  `Q31 the type description names real config types…`;
  client: `Q31 withoutRetries sends a 429 once`, `Q31 a 429 shows Google's text…`.

### Q32. `?fingerprint=` is ignored on `:revert`

- **Google:** `variables.revert` with a made-up `?fingerprint=1111111111111`
  succeeded, so Google doesn't check the fingerprint on revert, despite Q2
  and the Discovery document.
- **We:** `revert_workspace_entity` keeps its `fingerprint` argument and
  checks it itself: when one is passed, it GETs the entity just before the
  revert and fails with the usual conflict (Q2) if the fingerprint differs.
  That catches changes made since the caller's read, but not ones in the
  moment between our GET and the POST. If the entity can't be read (deleted
  in the workspace), the tool says to call again without a fingerprint.
  Built-in variables have no fingerprint, so one passed with them is refused.
  The fingerprint is still sent to Google, in case it starts checking.
- **Tests:** tools/reverts: `Q32 %s: GETs it to check the fingerprint, then POSTs…`,
  `Q32 a stale fingerprint is refused before the revert…`,
  `Q32 without a fingerprint, reverts with no GET`,
  `Q32 a fingerprint for an entity that can't be read…`,
  `Q32 refuses a fingerprint on a built-in variable…`.

### Q33. `bulk_update` needs a deleted entity's name and type

- **Google:** in `workspaces.bulk_update`, a change `{changeStatus:
  "deleted", trigger: {triggerId: "93"}}` is rejected with `trigger.name: The
  name length must be between 1 and 255 characters.`, and nothing in the
  call is applied. With the name and type, deletes work.
- **We:** `bulk_update_workspace` still accepts a deleted entity by ID only.
  For each deleted tag, trigger, variable or folder that lacks its name (or
  type, except folders), it GETs the stored entity and sends that, with the
  caller's fields on top. That is 1 GET each, before the preview too (so the
  preview shows names), capped at 24 (`LIST_PAGE_BUDGET`, the Workers
  subrequest budget); with more, it asks for the entities whole.
- **Tests:** tools/workspace-admin: `Q33 without confirm: true only GETs the bare deleted entity…`,
  `Q33 with confirm: true POSTs … the deleted tag completed by a GET`,
  `Q33 a deleted entry already carrying name and type is sent as given…`,
  `Q33 refuses more bare deleted entries than it may look up…`.

### Q34. More bare 400s: in-use template, non-empty added folder, latest or base version

- **Google:** these fail with the same bare 400 as Q25/Q26 ("Returned an
  error response for your request"): `templates.delete` while a tag still
  has the template's type; `folders.revert` on a folder added in the
  workspace that still holds entities (the revert would delete it, as in
  Q25); `versions.delete` on the latest version; and `versions.delete` on a
  version a workspace is still based on (it worked once that workspace was
  synced).
- **We:** `delete_template` re-reads the template and the tags and variables
  of its type after a 400 and names them (its preview already did).
  `revert_workspace_entity` with kind `folder` lists an added folder's
  contents in the preview with a warning, and after a 400 names them and how
  to move them out (`move_entities_to_folder` to folder `0`, Q19).
  `delete_version` reads the latest version header along with the live
  version and refuses the latest one before any write (preview and confirmed
  call). No API call says which version a workspace is based on, so the
  preview only warns about that case, and a 400 on the DELETE becomes an
  error that says to sync those workspaces.
- **Tests:** tools/templates: `Q34 a bare 400 on the confirmed DELETE becomes an error naming the tags…`;
  tools/reverts: `Q34 previews an added folder that still holds entities…`,
  `Q34 a bare 400 reverting an added folder becomes an error…`;
  tools/version-admin: `Q34 refuses the latest version before any DELETE`,
  `Q34 a bare 400 on the DELETE becomes an error about workspaces still based on the version`.

### Q35. `combine` and `move_tag_id` are for Google tag containers only

- **Google:** `containers.move_tag_id` on a GTM container fails with "tag_id:
  For Google tag only, this operation is not supported by GTM container.",
  and `containers.combine` of two GTM containers failed with HTTP 500
  "Experienced an internal error" and changed nothing. Both are meant for
  Google tag containers, the ones a Google tag (`G-…`, `AW-…`) creates,
  whose public ID is not `GTM-…`.
- **We:** both tools read the target container before the gate and refuse a
  container whose public ID starts with `GTM-`, in the preview and the
  confirmed call, saying what they are for and pointing GTM containers at
  the GTM UI's export/import. Their descriptions start with "Google tag
  containers only". Telling the two kinds apart by the `GTM-` prefix is our
  inference from the error text: the API has no field that says so.
- **Tests:** tools/container-admin: `Q35 refuses a GTM-… container with a clear message…`,
  `Q35 refuses a GTM-… container before anything is moved`.

### Q36. A template's name comes from its code; `name` on update is ignored

- **Google:** `templates.update` accepts a `name` and answers 200, but the
  template keeps the name from the `displayName` in the `___INFO___` section
  of its `templateData`. Seen on a gallery import (name only) and on a
  container template (name and templateData together).
- **We:** `update_template` takes no `name` (input schema changed): it
  replaces `templateData`, and its description says to rename a template by
  editing `displayName` in the code. A call with only `name` fails validation
  before any request.
- **Tests:** tools/templates: `Q36 takes no name (GTM ignores it)…`,
  `Q1/Q8: GET, then PUT of the whole template…`.

### Q37. `set_latest_version` saves a copy; it does not re-point "latest"

- **Google:** `versions.set_latest` on version 2 (with 3 the latest) did not
  make version 2 the latest: GTM saved a copy of it as a new version 4 named
  "Restored_2" (description "Restored from 2") and returned that. Version 2
  itself is unchanged.
- **We:** the preview says a copy will be saved. The result reports the
  version Google returns, and when its ID differs from the one asked for,
  the note names the new version and says the original is unchanged.
- **Tests:** tools/version-admin: `Q37 reports the new version GTM saves as a copy…`.

### Q38. Two 404s that aren't about the IDs: zones without GTM 360, unknown emails

- **Google:** on a standard (non-360) account, `zones.list` returns an empty
  list, while `zones.get` / `create` / `update` / `delete` answer 404 "Not
  found or permission denied". `user_permissions.create` for an email with
  no Google account answers 404 "User not found".
- **We:** a 404 on a `zones` path keeps the usual "check the IDs" hint and
  adds that zones exist only in GTM 360 accounts. A user-permission 404
  whose Google message is "User not found" says the email has no Google
  account instead of pointing at the account ID (`notFoundMessage` in
  `src/gtm/errors.ts`).
- **Tests:** client: `Q38 a zone 404 adds that zones need GTM 360…`,
  `Q38 a user-permission 404 'User not found' says the email has no Google account…`.

### Q39. `domainName` is dropped on web containers

- **Google:** `containers.update` on a web container with `domainName:
  ["tmp.example.com"]` (and again with two domains plus a `notes` change)
  answered 200 with a new fingerprint and the other changes stored, but no
  `domainName` in the response or in a later `containers.get`. Our PUT body
  carried the list (get-merge-put, Q1/Q7), so Google drops it. Not checked on
  other container types or on `containers.create`.
- **We:** `update_container` keeps get-merge-put as for every update
  (omitted fields are kept, `[]` clears). After the PUT it compares each
  setting it was asked to change (name, domainName, notes,
  taggingServerUrls) with Google's response and adds a warning for any that
  didn't stick, so the model doesn't report a change that didn't happen.
- **Tests:** tools/container-admin: `Q1/Q7 domainName: omitted keeps the stored domains…`,
  `Q1/Q7 domainName: [] clears them…`, `Q1/Q7 domainName: a list replaces them…`,
  `Q39 warns when GTM answers 200 but drops the domainName it was sent`.

### Q40. `bulk_update`'s response is about the workspace, not the call

- **Google:** the `changes` in a `workspaces.bulk_update` response carry each
  entity's `changeStatus` against the workspace's base version, not what the
  call did. Seen live: a variable updated by the call (added earlier in the
  same workspace) came back `added`; a trigger the call deleted (also added
  earlier in the workspace) was missing; and a trigger the call didn't name
  was listed. Discovery says the list "does not include entities that were
  deleted or updated by the system".
- **We:** `bulk_update_workspace` reports `changed` from the caller's own
  changes, with the `changeStatus` it asked for and the entity's name. An
  added entity gets the ID GTM gave it, matched in the response by kind and
  name; if none matches, it keeps its `new_N` ID. Response entities that
  match no change are listed apart as `alsoReportedByGtm`.
- **Tests:** tools/workspace-admin: `Q33 with confirm: true POSTs … the deleted tag completed by a GET`,
  `Q40 reports what the call did, not GTM's changeStatus against the base version…`.
