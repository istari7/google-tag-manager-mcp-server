import { z } from "zod";
import { accounts, type BuiltInVariable } from "../gtm/generated";
import { builtInVariablesPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { ok, okList } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { confirmInput, workspaceInput } from "./inputs";
import { okWrite } from "./write";

const builtIns = accounts.containers.workspaces.builtInVariables;

type BuiltInType = Exclude<NonNullable<BuiltInVariable["type"]>, "builtInVariableTypeUnspecified">;

/** Every built-in variable type Google accepts (BuiltInVariable.type in generated.ts). */
export const BUILT_IN_TYPES = [
	"pageUrl",
	"pageHostname",
	"pagePath",
	"referrer",
	"event",
	"clickElement",
	"clickClasses",
	"clickId",
	"clickTarget",
	"clickUrl",
	"clickText",
	"firstPartyServingUrl",
	"formElement",
	"formClasses",
	"formId",
	"formTarget",
	"formUrl",
	"formText",
	"errorMessage",
	"errorUrl",
	"errorLine",
	"newHistoryUrl",
	"oldHistoryUrl",
	"newHistoryFragment",
	"oldHistoryFragment",
	"newHistoryState",
	"oldHistoryState",
	"historySource",
	"containerVersion",
	"debugMode",
	"randomNumber",
	"containerId",
	"appId",
	"appName",
	"appVersionCode",
	"appVersionName",
	"language",
	"osVersion",
	"platform",
	"sdkVersion",
	"deviceName",
	"resolution",
	"advertiserId",
	"advertisingTrackingEnabled",
	"htmlId",
	"environmentName",
	"ampBrowserLanguage",
	"ampCanonicalPath",
	"ampCanonicalUrl",
	"ampCanonicalHost",
	"ampReferrer",
	"ampTitle",
	"ampClientId",
	"ampClientTimezone",
	"ampClientTimestamp",
	"ampClientScreenWidth",
	"ampClientScreenHeight",
	"ampClientScrollX",
	"ampClientScrollY",
	"ampClientMaxScrollX",
	"ampClientMaxScrollY",
	"ampTotalEngagedTime",
	"ampPageViewId",
	"ampPageLoadTime",
	"ampPageDownloadTime",
	"ampGtmEvent",
	"eventName",
	"firebaseEventParameterCampaign",
	"firebaseEventParameterCampaignAclid",
	"firebaseEventParameterCampaignAnid",
	"firebaseEventParameterCampaignClickTimestamp",
	"firebaseEventParameterCampaignContent",
	"firebaseEventParameterCampaignCp1",
	"firebaseEventParameterCampaignGclid",
	"firebaseEventParameterCampaignSource",
	"firebaseEventParameterCampaignTerm",
	"firebaseEventParameterCurrency",
	"firebaseEventParameterDynamicLinkAcceptTime",
	"firebaseEventParameterDynamicLinkLinkid",
	"firebaseEventParameterNotificationMessageDeviceTime",
	"firebaseEventParameterNotificationMessageId",
	"firebaseEventParameterNotificationMessageName",
	"firebaseEventParameterNotificationMessageTime",
	"firebaseEventParameterNotificationTopic",
	"firebaseEventParameterPreviousAppVersion",
	"firebaseEventParameterPreviousOsVersion",
	"firebaseEventParameterPrice",
	"firebaseEventParameterProductId",
	"firebaseEventParameterQuantity",
	"firebaseEventParameterValue",
	"videoProvider",
	"videoUrl",
	"videoTitle",
	"videoDuration",
	"videoPercent",
	"videoVisible",
	"videoStatus",
	"videoCurrentTime",
	"scrollDepthThreshold",
	"scrollDepthUnits",
	"scrollDepthDirection",
	"elementVisibilityRatio",
	"elementVisibilityTime",
	"elementVisibilityFirstTime",
	"elementVisibilityRecentTime",
	"requestPath",
	"requestMethod",
	"clientName",
	"queryString",
	"serverPageLocationUrl",
	"serverPageLocationPath",
	"serverPageLocationHostname",
	"visitorRegion",
	"analyticsClientId",
	"analyticsSessionId",
	"analyticsSessionNumber",
] as const satisfies readonly BuiltInType[];

// Compile-time: fails if generated.ts gains a type this list doesn't have.
type MissingBuiltInType = Exclude<BuiltInType, (typeof BUILT_IN_TYPES)[number]>;
const _allBuiltInTypes: [MissingBuiltInType] extends [never] ? true : MissingBuiltInType = true;

const KNOWN = new Set<string>(BUILT_IN_TYPES);
const isBuiltInType = (value: string): value is BuiltInType => KNOWN.has(value);

/**
 * The 116 types are checked here rather than listed as a JSON Schema enum: the enum would
 * add about 2.5 KB to every tools/list response. The error message lists close matches.
 */
const builtInTypesInput = z
	.array(z.string())
	.min(1)
	.superRefine((types, ctx) => {
		for (const type of types) {
			if (isBuiltInType(type)) continue;
			const lower = type.toLowerCase();
			const near = BUILT_IN_TYPES.filter((t) => t.toLowerCase().includes(lower) || lower.includes(t.toLowerCase()));
			ctx.addIssue({
				code: "custom",
				message: `Unknown built-in variable type "${type}".${near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : ""}`,
			});
		}
	})
	.transform((types) => [...new Set(types.filter(isBuiltInType))])
	.describe(
		"Built-in types, e.g. pageUrl, pagePath, referrer, event, clickUrl, clickText, clickId, formId, scrollDepthThreshold",
	);

export const builtInTools: ToolGroup = (tools) => {
	tools.add(
		"list_built_in_variables",
		{
			description: "List a workspace's enabled built-in variables (e.g. Page URL, Click Classes) by type and name.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = workspacePath(ids);
			const list = await gtm.listAll(
				(pageToken) => builtIns.list(gtm, { parent, pageToken }),
				(page) => page.builtInVariable,
			);
			return okList("builtInVariables", list, (b) => ({ type: b.type, name: b.name }));
		},
	);

	tools.add(
		"enable_built_in_variables",
		{
			description:
				"Enable built-in variables (Page URL, Click URL, Form ID, …) in a workspace so conditions and tags can use {{Name}}.",
			input: workspaceInput.extend({ types: builtInTypesInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ types, ...ids }, { gtm }) => {
			const response = await builtIns.create(gtm, { parent: workspacePath(ids), type: types });
			const enabled = (response?.builtInVariable ?? []).map((b) => ({ type: b.type, name: b.name }));
			// Google returns only the types it newly enabled (none at all when every type was
			// already on), so the rest were already enabled. Inferred, to save a list call.
			const returned = new Set(enabled.map((b) => b.type));
			const alreadyEnabled = types.filter((t) => !returned.has(t));
			if (enabled.length === 0) {
				return okWrite({ alreadyEnabled }, { note: "Nothing changed: all requested built-ins were already enabled." });
			}
			return okWrite({ enabled, alreadyEnabled });
		},
	);

	tools.add(
		"disable_built_in_variables",
		{
			description:
				"Disable built-in variables in a workspace. Anything still using {{Name}} then breaks. Without confirm: true, only previews.",
			input: workspaceInput.extend({ types: builtInTypesInput, confirm: confirmInput("disable them") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ types, confirm, ...ids }, { gtm }) => {
			const parent = workspacePath(ids);
			const { items } = await gtm.listAll(
				(pageToken) => builtIns.list(gtm, { parent, pageToken }),
				(page) => page.builtInVariable,
			);
			const enabled = new Map(items.map((b) => [b.type, b.name]));
			const toDisable = types.filter((t) => enabled.has(t));
			const notEnabled = types.filter((t) => !enabled.has(t));
			if (toDisable.length === 0) {
				return ok({ notEnabled, message: "Nothing to disable: none of these built-ins is enabled." });
			}
			const rows = toDisable.map((type) => ({ type, name: enabled.get(type) }));
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{ wouldDisable: rows, ...(notEnabled.length ? { notEnabled } : {}) },
						"Nothing was changed. Check nothing still uses these variables, get the user's go-ahead, then call disable_built_in_variables again with confirm: true.",
					),
				apply: async () => {
					await builtIns.delete(gtm, { path: builtInVariablesPath(ids), type: toDisable });
					return okWrite({ disabled: rows, notEnabled });
				},
			});
		},
	);
};
