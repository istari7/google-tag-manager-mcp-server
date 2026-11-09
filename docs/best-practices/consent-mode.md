# Consent Mode v2

Relevant whenever the site shows a consent banner (a CMP) or has visitors from
the EEA or the UK. Consent settings carry legal weight: describe what you
would change and get the user's explicit approval before changing any of it.

## The four signals

Consent Mode v2 tracks `ad_storage`, `analytics_storage`, `ad_user_data` and
`ad_personalization`. Each is `granted` or `denied`.

## How a compliant container is wired

- **Defaults first.** The CMP's template tag (or a dedicated consent-defaults
  tag) runs on the Consent Initialization trigger (`consentInit`), ahead of
  every other tag. It sets the four signals, normally to `denied` by default
  for the regions where consent is required.
- **Updates on choice.** When the visitor accepts or rejects, the CMP sends a
  consent update. Most CMP templates do this for you; check that it happens
  in GTM Preview.
- **Every tag has a decision.** Each tag's consent settings are set on
  purpose, never left at "not set".

## Per-tag settings

| Tag | `consentStatus` | `consentTypes` |
|---|---|---|
| Google tag, GA4, Google Ads, Floodlight | `notNeeded` (they read consent themselves) | none |
| Other advertising pixels (Meta, TikTok, LinkedIn, custom HTML pixels) | `needed` | `ad_storage`, plus `ad_user_data` / `ad_personalization` where they apply |
| Non-Google analytics or heatmap tools that set cookies | `needed` | `analytics_storage` |

With this server, pass `consentStatus` and `consentTypes` to `create_tag` or
`update_tag`. In the stored tag they appear as `consentSettings`, with the
types held in a `consentType` list of `template` parameters.

## Audit checklist

- **Broken:** the banner tag fires on All Pages or Initialization instead of
  Consent Initialization.
- **Broken:** a non-Google advertising tag is `notSet` or `notNeeded` in a
  container that has a CMP.
- **Broken:** an advertising pixel fires on a plain page view with no consent
  requirement at all.
- **Should fix:** any tag left at `notSet` in a container that uses consent
  mode. Ask the user what it should be and record the answer in its notes.
- **Fine:** Google tags at `notNeeded`, provided the defaults are set before
  they run.
