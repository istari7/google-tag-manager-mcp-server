// Workspace maintenance: sync_workspace, resolve_workspace_conflict, bulk_update_workspace.
// All three rewrite entities in a workspace in ways that are hard to undo, so all three are
// confirm-gated (./confirm.ts), as in Paolo's server. None of them changes the live site.

import { z } from "zod";
import { accounts, type Entity, type Folder, type Tag, type Trigger, type Variable } from "../gtm/generated";
import { containerPath, isGtmId, workspacePath } from "../gtm/paths";
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
 * One entity, as get_* returns it. Google checks the fields; we only check the ID. Typed
 * as the generated entity so the request body stays a generated `Entity`.
 */
const entityFields = {
	tag: z
		.looseObject({})
		.transform((v): Tag => v)
		.optional(),
	trigger: z
		.looseObject({})
		.transform((v): Trigger => v)
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

type EntityFields = { tag?: Tag; trigger?: Trigger; variable?: Variable; folder?: Folder };

/** The one entity in a change, with its kind and ID; a message when there isn't exactly one. */
function onlyEntity(change: EntityFields): { kind: string; id: string | undefined; entity: Entity } | string {
	const present = [
		change.tag && { kind: "tag", id: change.tag.tagId, entity: { tag: change.tag } },
		change.trigger && { kind: "trigger", id: change.trigger.triggerId, entity: { trigger: change.trigger } },
		change.variable && { kind: "variable", id: change.variable.variableId, entity: { variable: change.variable } },
		change.folder && { kind: "folder", id: change.folder.folderId, entity: { folder: change.folder } },
	].filter((x) => x !== undefined);
	const [first] = present;
	if (present.length !== 1 || !first) return "each change needs exactly one of tag, trigger, variable or folder";
	return first;
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
			const given = onlyEntity({ tag, trigger, variable, folder });
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
					return okWrite({ resolved: { kind: given.kind, id: given.id } });
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
			for (const [i, change] of changes.entries()) {
				const given = onlyEntity(change);
				if (typeof given === "string") return fail(`Nothing was changed: changes[${i}]: ${given}.`);
				const added = change.changeStatus === "added";
				if (added ? !NEW_ID.test(given.id ?? "") : !isGtmId(given.id)) {
					return fail(
						`Nothing was changed: changes[${i}]: ${added ? `an added ${given.kind} needs an ID like "new_1"` : `the ${given.kind} needs its numeric ID`}.`,
					);
				}
				checked.push({ ...given.entity, changeStatus: change.changeStatus });
				rows.push({ changeStatus: change.changeStatus, ...describeEntity(given.entity) });
			}
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{ wouldApply: rows },
						"Nothing was changed. Each updated entity replaces the stored one whole. Get the user's go-ahead, then call bulk_update_workspace again with the same changes and confirm: true.",
					),
				apply: async () => {
					const response = await workspaces.bulkUpdate(gtm, { path: workspacePath(ids) }, { changes: checked });
					return okWrite({
						applied: changes.length,
						changed: (response?.changes ?? []).map((e) => ({ ...describeEntity(e), changeStatus: e.changeStatus })),
					});
				},
			});
		},
	);
};
