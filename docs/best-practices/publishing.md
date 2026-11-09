# Publishing workflow and safety

A change moves through four stages: **workspace → review → version → a person
publishes in the GTM UI**. This server covers the first three. It has no way
to publish a version and no way to delete a container or an account; the API
client refuses those requests outright. Your job ends at a saved, clearly
described version.

## Stage 1: pick a workspace

- Give each piece of work its own workspace, named for the change
  (`GA4 checkout events`). Use `Default Workspace` only for a quick fix the
  user asked for there.
- Keep unrelated changes apart, so each version can be reviewed and rolled
  back on its own.
- Standard (non-360) containers allow three workspaces, `Default Workspace`
  included. Call `list_workspaces` first; if the slots are taken, ask the
  user which stale workspace to finish or abandon instead of failing.

## Stage 2: make the edits

- Build bottom-up: variables, then triggers, then tags. Tags point at
  triggers by ID, and anything can refer to a variable as `{{Name}}`.
- Before an update, fetch the entity with `get_*`. Send only the fields that
  change, together with the `fingerprint` you just read. Omitted fields are
  kept; a list you send replaces the stored list, and `[]` empties it.
- A fingerprint conflict means someone else edited the entity in the
  meantime. Fetch it again and redo your change on top; never try to force it.
- `delete_*` tools do nothing without `confirm: true`. Call them without it
  first, show the user the preview, and confirm only after they agree.

## Stage 3: review with the user

- `get_workspace_status` lists every pending change and any merge conflict.
  Summarise it for the user by type and name: what is added, changed and
  removed.
- `quick_preview_workspace` checks that the workspace compiles without saving
  anything.
- Conflicts have to be resolved in the GTM UI before a version can be saved.
- Wait for the user to accept the summary before you go further.

## Stage 4: save a version

- `create_version` needs a name and notes a reviewer can understand later:
  what changed and why (`GA4: add purchase and refund events`). Names like
  `update` or `v3` are not acceptable.
- Saving a version does not change the website.

## Handing over

Tell the user the version ID, what is in it, and that it is **not live**. They
should test it in GTM Preview / Tag Assistant, then publish it themselves from
the Versions page in the GTM UI. Publishing affects every visitor to the site.

## Undoing a bad release

The clean fix is for a person to republish the last good version in the GTM
UI. Help them find it: `get_live_version` shows what is live now and
`list_versions` lists versions newest first. Rebuilding the old state by hand
in a new workspace is slower and error-prone.

## Hard rules

- Never say, or imply, that you published something or that you can.
- Never save a version the user has not reviewed.
- Never describe a workspace change as live.
- Never delete things as a by-product of another task; raise deletions as
  their own proposal.
