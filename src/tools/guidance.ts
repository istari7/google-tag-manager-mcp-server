// get_tag_templates, get_trigger_templates: static examples of create_tag / create_trigger
// arguments for common types, so a model gets GTM's parameter shapes right the first time.
// Idea and starting set adapted from Paolo Bietolini's gtm-mcp-server (BSD-3-Clause,
// gtm/templates.go); the examples are rewritten for this server's argument names and quirk
// handling (GTM_API_QUIRKS.md), and most shapes were accepted unchanged by GTM in a live run.
// test/tools/guidance.test.ts sends every example through the real create_* tool.
//
// "Templates" here means examples, not GTM custom templates (src/tools/templates.ts).

import type { TagInput, TriggerInput } from "../gtm/quirks";
import type { ToolGroup } from "../mcp/registry";
import { ok } from "../mcp/result";
import { NO_INPUT } from "./inputs";

export interface Example<A> {
	name: string;
	use: string;
	/** create_* arguments, without accountId / containerId / workspaceId. */
	arguments: A;
	notes?: string;
}

type TagArgs = TagInput & { name: string; type: string };
type TriggerArgs = TriggerInput & { name: string; type: NonNullable<TriggerInput["type"]> };

const t = (key: string, value: string) => ({ type: "template" as const, key, value });
const b = (key: string, value: boolean) => ({ type: "boolean" as const, key, value: String(value) });
/** A list of maps, as GA4 settings tables use: one map per row. */
const table = (key: string, rows: Array<Record<string, string>>) => ({
	type: "list" as const,
	key,
	list: rows.map((row) => ({ type: "map" as const, map: Object.entries(row).map(([k, v]) => t(k, v)) })),
});
/** arg0 is the variable, arg1 the value (every trigger condition). */
const cond = <T extends string>(type: T, variable: string, value: string) => ({
	type,
	parameter: [t("arg0", variable), t("arg1", value)],
});

export const TAG_USAGE: readonly string[] = [
	"Pass `arguments` to create_tag with accountId, containerId and workspaceId; change names and values.",
	'Every parameter value is a string, also for booleans and numbers ("true", "2000").',
	"list items and map entries are parameters too; a map item in a list has no key of its own.",
	"{{Name}} references must name an existing variable (create_variable first) or an enabled built-in (enable_built_in_variables).",
	"A tag fires only with a firingTriggerId. Use consentStatus / consentTypes for consent, not consentSettings.",
	"A tag built from a custom template has the type list_templates shows (cvt_…); its parameter keys are the template's field names.",
	"Nothing is live until a version is created and published.",
];

export const TAG_EXAMPLES: readonly Example<TagArgs>[] = [
	{
		name: "Google tag",
		use: "Loads GA4 (or another Google product) once per page",
		arguments: {
			name: "Google Tag - GA4",
			type: "googtag",
			firingTriggerId: ["2147479573"],
			parameter: [
				t("tagId", "{{Const - GA4 Measurement ID}}"),
				table("configSettingsTable", [{ parameter: "send_page_view", parameterValue: "true" }]),
			],
		},
		notes:
			'2147479573 is the built-in "Initialization - All Pages" trigger. One Google tag per measurement ID, or every page is counted twice.',
	},
	{
		name: "GA4 event",
		use: "Sends a GA4 event with event parameters and user properties",
		arguments: {
			name: "GA4 - Event - sign_up",
			type: "gaawe",
			firingTriggerId: ["<customEvent trigger ID>"],
			parameter: [
				t("measurementIdOverride", "{{Const - GA4 Measurement ID}}"),
				t("eventName", "sign_up"),
				table("eventSettingsTable", [
					{ parameter: "method", parameterValue: "{{DLV - method}}" },
					{ parameter: "page_path", parameterValue: "{{Page Path}}" },
				]),
				table("userProperties", [{ name: "plan", value: "{{DLV - plan}}" }]),
			],
		},
		notes:
			"The ID goes in measurementIdOverride (Google drops an empty measurementId tagReference). Event parameters are parameter/parameterValue rows, never keys of their own. GTM may add an unpaused Google tag for the ID: check get_workspace_status.",
	},
	{
		name: "GA4 ecommerce event",
		use: "purchase, add_to_cart, view_item, …: items come from the data layer's ecommerce object",
		arguments: {
			name: "GA4 - Event - purchase",
			type: "gaawe",
			firingTriggerId: ["<customEvent trigger ID>"],
			parameter: [
				t("measurementIdOverride", "{{Const - GA4 Measurement ID}}"),
				t("eventName", "purchase"),
				b("sendEcommerceData", true),
				t("getEcommerceDataFrom", "dataLayer"),
			],
		},
		notes: "The site pushes {event: 'purchase', ecommerce: {transaction_id, value, currency, items}}.",
	},
	{
		name: "Custom HTML",
		use: "Runs a script when no built-in or template tag fits",
		arguments: {
			name: "cHTML - Example",
			type: "html",
			firingTriggerId: ["<trigger ID>"],
			parameter: [t("html", "<script>\n  console.log('Hello from GTM');\n</script>"), b("supportDocumentWrite", false)],
		},
		notes: "Everything in a container is public: no secrets or personal data.",
	},
	{
		name: "Custom image (pixel)",
		use: "Requests a tracking pixel URL",
		arguments: {
			name: "Image - Pixel",
			type: "img",
			firingTriggerId: ["<trigger ID>"],
			parameter: [
				t("url", "https://example.com/pixel.gif?event=pageview"),
				b("useCacheBuster", true),
				t("cacheBusterQueryParam", "gtmcb"),
			],
		},
	},
	{
		name: "Google Ads conversion",
		use: "Records a Google Ads conversion",
		arguments: {
			name: "Ads - Conversion - purchase",
			type: "awct",
			firingTriggerId: ["<customEvent trigger ID>"],
			parameter: [
				t("conversionId", "123456789"),
				t("conversionLabel", "AbCdEfGh"),
				t("conversionValue", "{{DLV - value}}"),
				t("currencyCode", "EUR"),
			],
		},
		notes: "Add a Conversion Linker tag on all pages too. GTM may add an unpaused Google tag for the AW- ID.",
	},
	{
		name: "Conversion Linker",
		use: "Keeps ad click IDs for Google Ads and Floodlight conversions",
		arguments: {
			name: "Ads - Conversion Linker",
			type: "gclidw",
			firingTriggerId: ["2147479553"],
			parameter: [b("enableCrossDomain", false), b("enableUrlPassthrough", false), b("enableCookieOverrides", false)],
		},
		notes: '2147479553 is the built-in "All Pages" trigger.',
	},
];

export const TRIGGER_USAGE: readonly string[] = [
	"Pass `arguments` to create_trigger with accountId, containerId and workspaceId; change names and values.",
	"A condition is {type, parameter: [arg0 = the variable, arg1 = the value]}; every condition in a list must match.",
	"customEvent: the event name goes in customEventFilter ({{_event}} equals <event>).",
	"click, linkClick, formSubmission: all conditions go in filter. autoEventFilter is dropped by Google there (the server moves it to filter and warns).",
	"waitForTags, checkValidation and waitForTagsTimeout exist only on linkClick and formSubmission.",
	'To negate a condition add "negate": true ("doesNotContain" also works).',
	"The variables in arg0 must exist: enable built-ins such as Click Element, Form ID or Page Path with enable_built_in_variables.",
	'Built-in triggers need no create: "All Pages" is 2147479553, "Initialization - All Pages" is 2147479573.',
];

export const TRIGGER_EXAMPLES: readonly Example<TriggerArgs>[] = [
	{
		name: "Some pages",
		use: "Page view on matching pages",
		arguments: { name: "PV - /account", type: "pageview", filter: [cond("startsWith", "{{Page Path}}", "/account")] },
	},
	{
		name: "Custom event",
		use: "A dataLayer.push({event: 'sign_up'}) from the site: the most robust trigger",
		arguments: {
			name: "CE - sign_up",
			type: "customEvent",
			customEventFilter: [cond("equals", "{{_event}}", "sign_up")],
		},
	},
	{
		name: "Several custom events",
		use: "One trigger for several event names (regex, case-insensitive)",
		arguments: {
			name: "CE - purchase|refund",
			type: "customEvent",
			customEventFilter: [
				{
					type: "matchRegex",
					parameter: [t("arg0", "{{_event}}"), t("arg1", "^(purchase|refund)$"), b("ignore_case", true)],
				},
			],
		},
	},
	{
		name: "Click on an element",
		use: "Clicks on an element and its children, by CSS selector",
		arguments: {
			name: "Click - #cta",
			type: "click",
			filter: [cond("cssSelector", "{{Click Element}}", "#cta, #cta *")],
		},
		notes: "Needs the Click Element built-in variable.",
	},
	{
		name: "Link click",
		use: "Clicks on links, optionally waiting for tags before the page navigates",
		arguments: {
			name: "Link - PDF downloads",
			type: "linkClick",
			filter: [cond("endsWith", "{{Click URL}}", ".pdf")],
			waitForTags: { type: "boolean", value: "true" },
			checkValidation: { type: "boolean", value: "true" },
			waitForTagsTimeout: { type: "integer", value: "2000" },
		},
		notes: "Needs the Click URL built-in variable.",
	},
	{
		name: "Form submission",
		use: "Submits of one form",
		arguments: {
			name: "Form - contact",
			type: "formSubmission",
			filter: [cond("equals", "{{Form ID}}", "contact-form")],
		},
		notes: "Needs the Form ID built-in variable.",
	},
	{
		name: "Negated condition",
		use: "Pages that do not match",
		arguments: {
			name: "DOM Ready - not staging, not /private",
			type: "domReady",
			filter: [
				cond("doesNotContain", "{{Page Hostname}}", "staging"),
				{ ...cond("equals", "{{Page Path}}", "/private"), negate: true },
			],
		},
		notes: 'Stored as Google\'s shape: the condition plus a boolean "negate" parameter.',
	},
	{
		name: "Element visibility",
		use: "An element scrolls into view",
		arguments: {
			name: "Visibility - #footer 50%",
			type: "elementVisibility",
			parameter: [
				t("selectorType", "CSS"),
				t("elementSelector", "#footer"),
				t("firingFrequency", "ONCE_PER_ELEMENT"),
				b("useDomChangeListener", true),
				t("onScreenRatio", "50"),
			],
		},
	},
	{
		name: "Scroll depth",
		use: "Vertical scroll thresholds",
		arguments: {
			name: "Scroll - 25/50/75/90",
			type: "scrollDepth",
			parameter: [
				b("verticalThresholdOn", true),
				t("verticalThresholdUnits", "PERCENT"),
				t("verticalThresholdsPercent", "25,50,75,90"),
				b("horizontalThresholdOn", false),
				t("triggerStartOption", "WINDOW_LOAD"),
			],
		},
	},
	{
		name: "Timer",
		use: "Fires every interval ms, at most limit times",
		arguments: {
			name: "Timer - 5s x3",
			type: "timer",
			eventName: { type: "template", value: "gtm.timer" },
			interval: { type: "template", value: "5000" },
			limit: { type: "template", value: "3" },
			autoEventFilter: [cond("matchRegex", "{{Page URL}}", ".*")],
		},
		notes: "On timers, autoEventFilter is the 'enable when' condition and Google keeps it.",
	},
	{
		name: "Trigger group",
		use: "Fires once all listed triggers have fired",
		arguments: {
			name: "Group - PV + Scroll",
			type: "triggerGroup",
			parameter: [
				{
					type: "list",
					key: "triggerIds",
					list: [
						{ type: "triggerReference", value: "<trigger ID>" },
						{ type: "triggerReference", value: "<trigger ID>" },
					],
				},
			],
		},
	},
	{
		name: "Single-page app route change",
		use: "History changes, when the app pushes no event of its own",
		arguments: { name: "History Change - all", type: "historyChange" },
	},
];

export const guidanceTools: ToolGroup = (tools) => {
	tools.add(
		"get_tag_templates",
		{
			description:
				"Example create_tag arguments for common tags (Google tag, GA4 event and ecommerce, HTML, pixel, Ads). Read before building a tag.",
			input: NO_INPUT,
			annotations: { readOnlyHint: true },
		},
		() => ok({ usage: TAG_USAGE, examples: TAG_EXAMPLES }),
	);

	tools.add(
		"get_trigger_templates",
		{
			description:
				"Example create_trigger arguments for common triggers (page, custom event, click, link, form, visibility, scroll, timer, group).",
			input: NO_INPUT,
			annotations: { readOnlyHint: true },
		},
		() => ok({ usage: TRIGGER_USAGE, examples: TRIGGER_EXAMPLES }),
	);
};
