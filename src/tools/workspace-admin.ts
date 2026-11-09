// Workspace maintenance: sync_workspace, resolve_workspace_conflict, bulk_update_workspace.
// All three rewrite entities in a workspace in ways that are hard to undo, so all three are
// confirm-gated (./confirm.ts), as in Paolo's server. None of them changes the live site.

import { z } from "zod";
import { GtmInputError } from "../gtm/errors";
import { accounts, type Entity, type Folder, type Variable } from "../gtm/generated";
import { containerPath, isGtmId, workspacePath } from "../gtm/paths";
import { normalizeTag, normalizeTrigger, normalizeVariable, type TagInput, type TriggerInput } from "../gtm/quirks";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { confirmInput, workspaceInput } from "./inputs";
import { describeEntity, summarizeWorkspaceStatus } from "./summaries";
import { okWrite } from "./write";

const workspaces = accounts.containers.workspaces;
const versionHeaders = accounts.containers.versionHeaders;

// ---- Entities in the GTM shape --------------------------------------------------------

/**
 * One entity, as get_* returns it (plus the shorthands create_* accepts: consentStatus on a
 * tag, doesNotContain / negate in trigger conditions). Google checks most fields; onlyEntity
 * checks the ID and the fields every entity needs, and applies the create/update quirk fixes.
 */
const entityFields = {
	tag: z
		.looseObject({})
		.transform((v): TagInput => v)
		.optional(),
	trigger: z
		.looseObject({})
		.transform((v): TriggerInput => v)
		.optional(),
	variable: z
		.looseObject({})
		.transform((v): Variable => v)
		.optional(),
	folder: z
		.looseObject({})
		.transform((v): Folder => v)
		.optional(),
};

type EntityFields = { tag?: TagInput; trigger?: TriggerInput; variable?: Variable; folder?: Folder };

type ChangeStatus = "added" | "updated" | "deleted";

interface CheckedEntity {
	kind: string;
	id: string | undefined;
	/** The entity to send, quirk fixes applied. */
	entity: Entity;
	/** What the fixes changed (quirks.ts), as create_* and update_* report it. */
	warnings: string[];
}

const hasText = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** The fields GTM needs to add or replace an entity whole: a name, and a type except on folders. */
function missingFields(entity: { name?: unknown; type?: unknown }, typed: boolean): string | undefined {
	const missing = [!hasText(entity.name) && "name", typed && !hasText(entity.type) && "type"].filter(Boolean);
	return missing.length ? `needs ${missing.join(" and ")}` : undefined;
}

/**
 * The one entity in a change, with its kind and ID, checked and normalised the way
 * create_* and update_* do it: Q14 (tag consent shorthand), Q3/Q4/Q5/Q6 (trigger conditions:
 * autoEventFilter → filter on click/linkClick/formSubmission, doesNotContain, negate,
 * uniqueTriggerId), Q15 (Data Layer Variable defaultValue). A deleted entity needs only its
 * ID. Returns a message when the change can't be sent.
 */
function onlyEntity(change: EntityFields, changeStatus: ChangeStatus | undefined): CheckedEntity | string {
	const count = [change.tag, change.trigger, change.variable, change.folder].filter((e) => e !== undefined).length;
	if (count !== 1) return "each change needs exactly one of tag, trigger, variable or folder";
	const deleted = changeStatus === "deleted";
	const check = (kind: string, entity: { name?: unknown; type?: unknown }, typed: boolean) =>
		deleted ? undefined : missingFields(entity, typed) && `the ${kind} ${missingFields(entity, typed)}`;
	try {
		if (change.tag) {
			const problem = check("tag", change.tag, true);
			if (problem) return problem;
			const { value, warnings } = deleted ? { value: change.tag, warnings: [] } : normalizeTag(change.tag);
			return { kind: "tag", id: change.tag.tagId, entity: { tag: value }, warnings };
		}
		if (change.trigger) {
			const problem = check("trigger", change.trigger, true);
			if (problem) return problem;
			// Always normalised: a deleted trigger's conditions must be in Google's shape too.
			const { value, warnings } = normalizeTrigger(change.trigger);
			return { kind: "trigger", id: change.trigger.triggerId, entity: { trigger: value }, warnings };
		}
		if (change.variable) {
			const problem = check("variable", change.variable, true);
			if (problem) return problem;
			const { value, warnings } = deleted
				? { value: change.variable, warnings: [] }
				: normalizeVariable(change.variable);
			return { kind: "variable", id: change.variable.variableId, entity: { variable: value }, warnings };
		}
	} catch (error) {
		if (error instanceof GtmInputError) return error.message;
		throw error;
	}
	const folder = change.folder ?? {};
	const problem = check("folder", folder, false);
	if (problem) return problem;
	return { kind: "folder", id: folder.folderId, entity: { folder }, warnings: [] };
}

/** The fingerprint of whatever entity `e` holds. */
function fingerprintOf(e: Entity | undefined): string | undefined {
	if (!e) return undefined;
	return (
		e.tag?.fingerprint ??
		e.trigger?.fingerprint ??
		e.variable?.fingerprint ??
		e.folder?.fingerprint ??
		e.zone?.fingerprint ??
		e.client?.fingerprint ??
		e.transformation?.fingerprint ??
		e.customTemplate?.fingerprint ??
		e.gtagConfig?.fingerprint
	);
}

const NEW_ID = /^new_\d+$/;

export const workspaceAdminTools: ToolGroup = (tools) => {
	tools.add(
		"sync_workspace",
		{
			description:
				"Bring a workspace's unchanged entities up to the latest version; clashing edits become merge conflicts. Without confirm: true, only previews.",
			input: workspaceInput.extend({ confirm: confirmInput("sync") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = workspacePath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const [status, latest] = await Promise.all([
						workspaces.getStatus(gtm, { path }),
						versionHeaders.latest(gtm, { parent: containerPath(ids) }),
					]);
					const { changeCount, conflictCount } = summarizeWorkspaceStatus(status);
					return okPreview(
						{
							latestVersion: { containerVersionId: latest.containerVersionId, name: latest.name },
							pendingChanges: changeCount,
							conflicts: conflictCount,
						},
						"Nothing was synced. Syncing updates the entities this workspace did not change to the latest version; changed ones that the latest version also changed become merge conflicts. Get the user's go-ahead, then call sync_workspace again with confirm: true.",
					);
				},
				apply: async () => {
					const response = await workspaces.sync(gtm, { path });
					if (response?.syncStatus?.syncError) return fail("GTM could not sync the workspace. Retry.");
					const conflicts = (response?.mergeConflict ?? []).map((c) => ({
						...describeEntity(c.entityInWorkspace ?? c.entityInBaseVersion),
						fingerprint: fingerprintOf(c.entityInWorkspace),
					}));
					return okWrite(
						{ synced: true, conflicts },
						{
							note:
								conflicts.length > 0
									? "Synced with merge conflicts: resolve each (resolve_workspace_conflict or the GTM UI) before create_version. Nothing is live."
									: "Synced with no conflicts. Workspace changes are still not live until a version is created and published.",
						},
					);
				},
			});
		},
	);

	tools.add(
		"resolve_workspace_conflict",
		{
			description:
				"Resolve a merge conflict: the whole tag, trigger, variable or folder you send replaces the workspace's. Without confirm: true, only previews.",
			input: workspaceInput.extend({
				...entityFields,
				changeStatus: z.enum(["added", "updated", "deleted"]).optional(),
				fingerprint: z.string().optional().describe("From the preview"),
				confirm: confirmInput("resolve"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ tag, trigger, variable, folder, changeStatus, fingerprint, confirm, ...ids }, { gtm }) => {
			const given = onlyEntity({ tag, trigger, variable, folder }, changeStatus);
			if (typeof given === "string") return fail(`Nothing was resolved: ${given}.`);
			if (!isGtmId(given.id)) return fail(`Nothing was resolved: the ${given.kind} needs its numeric ID.`);
			const path = workspacePath(ids);
			const findConflict = async () => {
				const status = await workspaces.getStatus(gtm, { path });
				return (status?.mergeConflict ?? []).find((c) => {
					const d = describeEntity(c.entityInWorkspace ?? c.entityInBaseVersion);
					return d?.kind === given.kind && "id" in d && d.id === given.id;
				});
			};
			const noConflict = () => fail(`Workspace ${ids.workspaceId} has no merge conflict on ${given.kind} ${given.id}.`);
			return confirmGate({
				confirm,
				preview: async () => {
					const conflict = await findConflict();
					if (!conflict) return noConflict();
					return okPreview(
						{
							conflict: {
								inWorkspace: conflict.entityInWorkspace
									? {
											...describeEntity(conflict.entityInWorkspace),
											changeStatus: conflict.entityInWorkspace.changeStatus,
										}
									: "deleted in this workspace",
								inLatestVersion: conflict.entityInBaseVersion
									? describeEntity(conflict.entityInBaseVersion)
									: "deleted in the latest version",
								fingerprint: fingerprintOf(conflict.entityInWorkspace),
							},
							...(given.warnings.length ? { warnings: given.warnings } : {}),
						},
						"Nothing was resolved. The workspace's version of this entity would be replaced by the one you send. Get the user's go-ahead, then call resolve_workspace_conflict again with confirm: true and this fingerprint.",
					);
				},
				apply: async () => {
					let fp = fingerprint;
					if (fp === undefined) {
						const conflict = await findConflict();
						if (!conflict) return noConflict();
						fp = fingerprintOf(conflict.entityInWorkspace);
					}
					await workspaces.resolveConflict(gtm, { path, fingerprint: fp }, { ...given.entity, changeStatus });
					return okWrite({ resolved: { kind: given.kind, id: given.id } }, { warnings: given.warnings });
				},
			});
		},
	);

	tools.add(
		"bulk_update_workspace",
		{
			description:
				'Add, update or delete several tags, triggers, variables and folders at once. New ones use IDs "new_1", "new_2"… Without confirm: true, only previews.',
			input: workspaceInput.extend({
				changes: z
					.array(z.object({ changeStatus: z.enum(["added", "updated", "deleted"]), ...entityFields }))
					.min(1)
					.max(100)
					.describe("Whole entities as get_* returns them; fields left out may be erased"),
				confirm: confirmInput("apply the changes"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ changes, confirm, ...ids }, { gtm }) => {
			const checked: Entity[] = [];
			const rows: Record<string, unknown>[] = [];
			const warnings: string[] = [];
			for (const [i, change] of changes.entries()) {
				const given = onlyEntity(change, change.changeStatus);
				if (typeof given === "string") return fail(`Nothing was changed: changes[${i}]: ${given}.`);
				const added = change.changeStatus === "added";
				if (added ? !NEW_ID.test(given.id ?? "") : !isGtmId(given.id)) {
					return fail(
						`Nothing was changed: changes[${i}]: ${added ? `an added ${given.kind} needs an ID like "new_1"` : `the ${given.kind} needs its numeric ID`}.`,
					);
				}
				checked.push({ ...given.entity, changeStatus: change.changeStatus });
				rows.push({ changeStatus: change.changeStatus, ...describeEntity(given.entity) });
				warnings.push(...given.warnings.map((w) => `changes[${i}] (${given.kind} ${given.id}): ${w}`));
			}
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{ wouldApply: rows, ...(warnings.length ? { warnings } : {}) },
						"Nothing was changed. Each updated entity replaces the stored one whole. Get the user's go-ahead, then call bulk_update_workspace again with the same changes and confirm: true.",
					),
				apply: async () => {
					const response = await workspaces.bulkUpdate(gtm, { path: workspacePath(ids) }, { changes: checked });
					return okWrite(
						{
							applied: changes.length,
							changed: (response?.changes ?? []).map((e) => ({ ...describeEntity(e), changeStatus: e.changeStatus })),
						},
						{ warnings },
					);
				},
			});
		},
	);
};
