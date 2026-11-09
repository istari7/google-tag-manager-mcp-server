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
  `revert` and `resolve_conflict`. A mismatch returns 409 or 412.
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
  `Q2 a 409 from Google during the PUT surfaces as 'changed by someone else'…`;
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

### Q8. Template update puts the fingerprint in the body (unverified)

- **Google:** unverified. `CustomTemplate` has a `fingerprint` field, and it
  is not clear whether `templates.update` expects it in the body, as the
  `?fingerprint=` query parameter (like every other update, Q2), or accepts
  both.
- **We:** templates are in the backlog. Our generic update path always uses
  the query parameter and strips the body fingerprint. Check this against the
  sandbox container before adding template tools.
- **Tests:** `Q8 our generic update path never puts the fingerprint in the body`;
  `Q8 verify against the sandbox…` is an `it.todo`.

### Q9. Workspace edits are not live until a version is created and published

- **Google:** every create, update and delete changes only the workspace.
  Nothing reaches the site until `create_version` and then `publish`.
- **We:** this server never publishes (README, "What this server will never
  do"); a person publishes in the GTM UI. Every workspace write (create,
  update, delete, folders, built-ins) ends its result with
  `UNPUBLISHED_CHANGES_NOTE` from `quirks.ts`. `create_workspace` uses
  `WORKSPACE_NOT_LIVE_NOTE` and `create_version` says the version is saved but
  not live until a person publishes it in the GTM UI. No tool ever says "now
  live". Tool descriptions and `get_workspace_status` say the same thing.
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
- **We:** retry 429 and rate-limit 403s for every method. Retry 5xx **only
  for GET**. Backoff is 1 s, 2 s, 4 s, with at most 3 retries. We never retry
  400/401/404/409/412, a plain permission 403, or a daily-quota 403.
- **Why writes are not retried on 5xx:** Google can fail after committing.
  A retried POST (`create_tag`, `create_version`, `quick_preview`,
  `move_entities_to_folder`, …) can then apply twice or make
  a duplicate, and a retried PUT carries the old `?fingerprint=` (Q2), so it
  comes back as a false "changed by someone else". Instead, a 5xx on a
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
  (There is no publish tool, so `tagmanager.publish` is never needed: the
  client refuses every `:publish` request before calling Google.)
- **Tests:** client: `403 API disabled → enable-the-API message that keeps Google's console link`,
  `403 insufficient scopes → reconnect-and-approve message`.

## Side effects of creating tags

### Q23. Google tags are created automatically for GA4, Google Ads and Floodlight tags

- **Google:** creating a GA4 event tag (`gaawe`), a Google Ads conversion tag
  (`awct`) or a Floodlight tag makes GTM auto-create an **unpaused**
  destination Google tag (e.g. "Google Analytics G-…") plus `gtagConfig`
  entries in the workspace, even when the created tag is paused. Deleting
  those tags does not remove the `gtagConfig` entries (confirmed live).
- **We:** no handling yet; documented here. The `tags` best-practices topic
  tells the model to check `get_workspace_status` for the extra Google tag
  after creating one of these tags and to point it out to the user.
- **Tests:** none yet.
