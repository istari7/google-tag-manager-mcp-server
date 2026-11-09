import { z } from "zod";
import { accounts, type Trigger } from "../gtm/generated";
import { createTrigger, updateTrigger } from "../gtm/merge";
import { triggerPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, okEntity, okList } from "../mcp/result";
import {
	conditionsInput,
	confirmInput,
	fingerprintInput,
	gtmId,
	nameInput,
	notesInput,
	parameterInput,
	parametersInput,
	workspaceInput,
} from "./inputs";
import { deleteWithConfirm, isEmptyPatch, okWrite } from "./write";

const triggers = accounts.containers.workspaces.triggers;
const tags = accounts.containers.workspaces.tags;

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

export const triggerTools: ToolGroup = (tools) => {
	tools.add(
		"list_triggers",
		{
			description: "List the triggers in a GTM workspace: ID, name, type and folder.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = workspacePath(ids);
			const list = await gtm.listAll(
				(pageToken) => triggers.list(gtm, { parent, pageToken }),
				(page) => page.trigger,
			);
			return okList("triggers", list, triggerRow);
		},
	);

	tools.add(
		"get_trigger",
		{
			description: "Get one trigger with its conditions (filter, autoEventFilter, customEventFilter) and fingerprint.",
			input: workspaceInput.extend(triggerIdInput),
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(await triggers.get(gtm, { path: triggerPath(ids) })),
	);

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
				"Change some fields of a trigger; omitted fields are kept, [] clears a list. Pass the fingerprint from get_trigger to avoid overwriting newer edits.",
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

	tools.add(
		"delete_trigger",
		{
			description:
				"Delete a trigger from a workspace. Without confirm: true, only shows what would be deleted and which tags use it.",
			input: workspaceInput.extend(triggerIdInput).extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = triggerPath(ids);
			return deleteWithConfirm({
				confirm,
				kind: "trigger",
				id: ids.triggerId,
				get: () => triggers.get(gtm, { path }),
				summarize: triggerRow,
				// Tags that fire on or are blocked by this trigger lose it when it is deleted.
				related: async () => {
					const parent = workspacePath(ids);
					const list = await gtm.listAll(
						(pageToken) => tags.list(gtm, { parent, pageToken }),
						(page) => page.tag,
					);
					const usedByTags = list.items
						.filter((t) => t.firingTriggerId?.includes(ids.triggerId) || t.blockingTriggerId?.includes(ids.triggerId))
						.map((t) => ({ tagId: t.tagId, name: t.name }));
					return { usedByTags };
				},
				remove: () => triggers.delete(gtm, { path }),
			});
		},
	);
};
