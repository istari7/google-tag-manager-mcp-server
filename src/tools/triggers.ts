import { z } from "zod";
import { accounts, type Trigger } from "../gtm/generated";
import { createTrigger, updateTrigger } from "../gtm/merge";
import { triggerPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import {
	conditionsInput,
	fingerprintInput,
	gtmId,
	nameInput,
	notesInput,
	parameterInput,
	parametersInput,
	workspaceInput,
} from "./inputs";
import { referencePreview, rejectedDeleteMessage, triggerReferences } from "./references";
import { isEmptyPatch, okWrite } from "./write";

const triggers = accounts.containers.workspaces.triggers;

const TRIGGER_FIX =
	"First remove it from those tags' firingTriggerId/blockingTriggerId (update_tag) and from those trigger groups, or delete them.";

/** One list_triggers row; also the delete_trigger preview. */
export function triggerRow(t: Trigger) {
	return { triggerId: t.triggerId, name: t.name, type: t.type, parentFolderId: t.parentFolderId };
}

const TRIGGER_TYPES = [
	"pageview",
	"domReady",
	"windowLoaded",
	"customEvent",
	"triggerGroup",
	"init",
	"consentInit",
	"serverPageview",
	"always",
	"firebaseAppException",
	"firebaseAppUpdate",
	"firebaseCampaign",
	"firebaseFirstOpen",
	"firebaseInAppPurchase",
	"firebaseNotificationDismiss",
	"firebaseNotificationForeground",
	"firebaseNotificationOpen",
	"firebaseNotificationReceive",
	"firebaseOsUpdate",
	"firebaseSessionStart",
	"firebaseUserEngagement",
	"formSubmission",
	"click",
	"linkClick",
	"jsError",
	"historyChange",
	"timer",
	"ampClick",
	"ampTimer",
	"ampScroll",
	"ampVisibility",
	"youTubeVideo",
	"scrollDepth",
	"elementVisibility",
] as const satisfies readonly NonNullable<Trigger["type"]>[];

// Compile-time: fails if generated.ts gains a trigger type this list doesn't have.
type MissingTriggerType = Exclude<
	NonNullable<Trigger["type"]>,
	"eventTypeUnspecified" | (typeof TRIGGER_TYPES)[number]
>;
const _allTriggerTypes: [MissingTriggerType] extends [never] ? true : MissingTriggerType = true;

/**
 * Trigger fields a caller may set (Google's names). Conditions go through normalizeTrigger:
 * Q3/Q10 autoEventFilter → filter on click/linkClick/formSubmission, Q4/Q11 companions
 * (linkClick/formSubmission only; Google drops them on click),
 * Q5 doesNotContain/negate, Q6 uniqueTriggerId stripped.
 */
const triggerFields = z.object({
	name: nameInput("Trigger"),
	type: z.enum(TRIGGER_TYPES),
	filter: conditionsInput("Conditions, all must match"),
	customEventFilter: conditionsInput("customEvent: {{_event}} equals <event name>"),
	autoEventFilter: conditionsInput("Appended to filter on click, linkClick, formSubmission"),
	parameter: parametersInput.optional(),
	waitForTags: parameterInput.optional(),
	checkValidation: parameterInput.optional(),
	waitForTagsTimeout: parameterInput.optional(),
	eventName: parameterInput.optional(),
	interval: parameterInput.optional(),
	limit: parameterInput.optional(),
	notes: notesInput,
});

const triggerIdInput = { triggerId: gtmId("Trigger ID") };

const trigger = workspaceEntity({
	kind: "trigger",
	ids: workspaceInput.extend(triggerIdInput),
	id: (ids) => ids.triggerId,
	path: triggerPath,
	api: triggers,
	items: (page) => page.trigger,
	row: triggerRow,
});

export const triggerTools: ToolGroup = (tools) => {
	addListTool(tools, trigger, {
		name: "list_triggers",
		key: "triggers",
		description: "List a workspace's triggers: ID, name, type, folder.",
	});

	addGetTool(tools, trigger, {
		name: "get_trigger",
		description: "Get one trigger with its conditions (filter, autoEventFilter, customEventFilter) and fingerprint.",
	});

	tools.add(
		"create_trigger",
		{
			description:
				"Create a trigger in a workspace. See gtm://best-practices/triggers for condition shapes. Not live until a version is published.",
			input: workspaceInput.extend(triggerFields.shape).extend({ parentFolderId: gtmId("Folder ID").optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const { result, warnings } = await createTrigger(gtm, parent, fields);
			return okWrite({ trigger: result }, { warnings });
		},
	);

	tools.add(
		"update_trigger",
		{
			description:
				"Change some fields of a trigger; omitted fields are kept, [] clears a list. Pass get_trigger's fingerprint to avoid overwriting newer edits.",
			input: workspaceInput
				.extend(triggerIdInput)
				.extend(triggerFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, triggerId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one trigger field.");
			const path = triggerPath({ accountId, containerId, workspaceId, triggerId });
			const { result, warnings } = await updateTrigger(gtm, path, fields, { expectedFingerprint: fingerprint });
			return okWrite({ trigger: result }, { warnings });
		},
	);

	addDeleteTool(tools, trigger, {
		name: "delete_trigger",
		description: "Delete a trigger. Without confirm: true, only previews it and what uses it.",
		// Q26: GTM refuses to delete a trigger that tags (or trigger groups) still use.
		related: async (ids, { gtm }) =>
			referencePreview("trigger", await triggerReferences(gtm, ids, ids.triggerId), TRIGGER_FIX),
		rejected: async (ids, { gtm }) =>
			rejectedDeleteMessage("trigger", ids.triggerId, await triggerReferences(gtm, ids, ids.triggerId), TRIGGER_FIX),
	});
};
