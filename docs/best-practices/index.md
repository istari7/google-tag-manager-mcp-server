# GTM best practices

Practical guidance for working on a Google Tag Manager container through this
server. Each topic is a separate resource. Open the one that matches the job
before you create or change anything; they are short on purpose.

## Topics

- **publishing** (`gtm://best-practices/publishing`): the life of a change,
  from a draft in a workspace to a saved version that a person publishes in
  the GTM UI. Includes how to undo a bad release.
- **naming** (`gtm://best-practices/naming`): how to name tags, triggers and
  variables, when to use folders, and what counts as clutter.
- **tags** (`gtm://best-practices/tags`): Google tag and GA4 event tags,
  firing options, custom HTML, double counting.
- **triggers** (`gtm://best-practices/triggers`): choosing a trigger type and
  writing its conditions correctly.
- **variables** (`gtm://best-practices/variables`): picking the right variable
  type, built-ins, constants and lookup tables.
- **data-layer** (`gtm://best-practices/data-layer`): what the website should
  push, and what to ask its developer for.
- **consent-mode** (`gtm://best-practices/consent-mode`): Consent Mode v2,
  the consent banner tag and per-tag consent settings.

## Ground rules for every task

1. **Follow the house style.** When a container already has a consistent way
   of naming or organising things, keep to it, even if it differs from these
   guides. Point out inconsistencies rather than adding a second style.
2. **Inventory first.** Before adding anything, look at what is there
   (`list_tags`, `list_triggers`, `list_variables`, `list_folders`,
   `list_built_in_variables`). Reusing an existing trigger or variable beats
   creating a near-copy.
3. **Nothing goes live from here.** Workspace edits and saved versions do not
   reach the website. A person has to publish a version in the GTM UI. Say
   this plainly whenever you report a change.
4. **Deleting is the user's decision.** Suggest removals with reasons; delete
   only after the user has agreed to that specific item.
5. **Audits are lists of findings.** When asked to review a container, go
   topic by topic, rate each finding (fine / should fix / broken) and attach a
   concrete fix to every item that isn't fine.
