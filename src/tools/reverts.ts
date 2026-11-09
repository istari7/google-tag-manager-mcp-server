// revert_workspace_entity: discard a workspace's changes to one entity, of any kind GTM can
// revert (tag, trigger, variable, folder, zone, template, client, transformation, built-in
// variable). One generic tool instead of nine, to save tools/list bytes; it also covers
// Paolo's separate revert_folder. Confirm-gated: the workspace edits are lost.
// Google ignores `?fingerprint=` on :revert (Q32), so a caller's fingerprint is checked here,
// against a GET of the entity just before the revert.

import { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { GtmApiError, GtmInputError } from "../gtm/errors";
import { accounts, type Entity } from "../gtm/generated";
import {
	clientPath,
	folderPath,
	isGtmId,
	tagPath,
	templatePath,
	transformationPath,
	triggerPath,
	variablePath,
	type WorkspaceIds,
	workspacePath,
	zonePath,
} from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { BUILT_IN_TYPES } from "./builtins";
import { confirmGate, okPreview } from "./confirm";
import { type FolderContents, folderContents } from "./folders";
import { confirmInput, workspaceInput } from "./inputs";
import { describeEntity } from "./summaries";
import { okWrite } from "./write";

const ws = accounts.containers.workspaces;

/** Entity kinds as describeEntity (./summaries.ts) names them. */
const REVERT_KINDS = [
	"tag",
	"trigger",
	"variable",
	"folder",
	"zone",
	"template",
	"client",
	"transformation",
	"builtInVariable",
] as const;
type RevertKind = (typeof REVERT_KINDS)[number];

type BuiltInType = (typeof BUILT_IN_TYPES)[number];
const isBuiltInType = (value: string): value is BuiltInType => (BUILT_IN_TYPES as readonly string[]).includes(value);

/** The ID an Entity from the workspace status has for `kind` (built-ins: their type). */
function statusId(e: Entity, kind: RevertKind): string | undefined {
	if (kind === "builtInVariable") return e.builtInVariable?.type;
	const d = describeEntity(e);
	return d?.kind === kind && "id" in d ? d.id : undefined;
}

const EFFECT: Record<string, string> = {
	added: "It was added in this workspace, so reverting deletes it.",
	updated: "Its edits in this workspace are discarded; it goes back to how it is in the latest version.",
	deleted: "It was deleted in this workspace, so reverting brings it back.",
};

/**
 * POST the kind's :revert. Returns the entity as it is after the revert, wrapped in an Entity
 * so describeEntity can name it; the wrapped field is undefined when the revert removed it.
 */
async function revert(
	gtm: GtmClient,
	kind: Exclude<RevertKind, "builtInVariable">,
	ids: WorkspaceIds,
	id: string,
	fingerprint: string | undefined,
): Promise<Entity> {
	const at = (path: string) => ({ path, fingerprint });
	switch (kind) {
		case "tag":
			return { tag: (await ws.tags.revert(gtm, at(tagPath({ ...ids, tagId: id })))).tag };
		case "trigger":
			return { trigger: (await ws.triggers.revert(gtm, at(triggerPath({ ...ids, triggerId: id })))).trigger };
		case "variable":
			return { variable: (await ws.variables.revert(gtm, at(variablePath({ ...ids, variableId: id })))).variable };
		case "folder":
			return { folder: (await ws.folders.revert(gtm, at(folderPath({ ...ids, folderId: id })))).folder };
		case "zone":
			return { zone: (await ws.zones.revert(gtm, at(zonePath({ ...ids, zoneId: id })))).zone };
		case "template":
			return {
				customTemplate: (await ws.templates.revert(gtm, at(templatePath({ ...ids, templateId: id })))).template,
			};
		case "client":
			return { client: (await ws.clients.revert(gtm, at(clientPath({ ...ids, clientId: id })))).client };
		case "transformation":
			return {
				transformation: (await ws.transformations.revert(gtm, at(transformationPath({ ...ids, transformationId: id }))))
					.transformation,
			};
	}
}

/** The entity's current fingerprint (a GET), for the check Google skips on :revert (Q32). */
async function currentFingerprint(
	gtm: GtmClient,
	kind: Exclude<RevertKind, "builtInVariable">,
	ids: WorkspaceIds,
	id: string,
): Promise<string | undefined> {
	switch (kind) {
		case "tag":
			return (await ws.tags.get(gtm, { path: tagPath({ ...ids, tagId: id }) })).fingerprint;
		case "trigger":
			return (await ws.triggers.get(gtm, { path: triggerPath({ ...ids, triggerId: id }) })).fingerprint;
		case "variable":
			return (await ws.variables.get(gtm, { path: variablePath({ ...ids, variableId: id }) })).fingerprint;
		case "folder":
			return (await ws.folders.get(gtm, { path: folderPath({ ...ids, folderId: id }) })).fingerprint;
		case "zone":
			return (await ws.zones.get(gtm, { path: zonePath({ ...ids, zoneId: id }) })).fingerprint;
		case "template":
			return (await ws.templates.get(gtm, { path: templatePath({ ...ids, templateId: id }) })).fingerprint;
		case "client":
			return (await ws.clients.get(gtm, { path: clientPath({ ...ids, clientId: id }) })).fingerprint;
		case "transformation":
			return (await ws.transformations.get(gtm, { path: transformationPath({ ...ids, transformationId: id }) }))
				.fingerprint;
	}
}

/** Throws a conflict when the entity no longer has the fingerprint the caller read (Q32). */
async function checkFingerprint(
	gtm: GtmClient,
	kind: Exclude<RevertKind, "builtInVariable">,
	ids: WorkspaceIds,
	id: string,
	expected: string,
): Promise<void> {
	let stored: string | undefined;
	try {
		stored = await currentFingerprint(gtm, kind, ids, id);
	} catch (error) {
		if (error instanceof GtmApiError && error.kind === "notFound") {
			throw new GtmInputError(
				`Nothing was reverted: ${kind} ${id} can't be read (it may be deleted in this workspace), so its fingerprint can't be checked. To restore it anyway, call again without fingerprint.`,
			);
		}
		throw error;
	}
	if (stored !== expected) throw GtmApiError.conflict("POST", `${kind} ${id}`);
}

const contentRows = (c: FolderContents) => [
	...c.tags.map((t) => `tag ${t.tagId} "${t.name ?? ""}"`),
	...c.triggers.map((t) => `trigger ${t.triggerId} "${t.name ?? ""}"`),
	...c.variables.map((v) => `variable ${v.variableId} "${v.name ?? ""}"`),
];

/** Q34: GTM won't revert (remove) an added folder that still holds entities. */
const FOLDER_FIX = 'Move them out first (move_entities_to_folder with folderId "0"), or revert them too, then retry.';

export const revertTools: ToolGroup = (tools) => {
	tools.add(
		"revert_workspace_entity",
		{
			description:
				"Discard a workspace's changes to one entity (an added one is removed). Without confirm: true, only previews.",
			input: workspaceInput.extend({
				kind: z.enum(REVERT_KINDS),
				id: z.string().describe("Entity ID; for builtInVariable its type, e.g. clickUrl"),
				fingerprint: z
					.string()
					.optional()
					.describe("From get_*: refused if the entity changed since (not builtInVariable)"),
				confirm: confirmInput("revert"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ kind, id, fingerprint, confirm, ...ids }, { gtm }) => {
			const builtInType = isBuiltInType(id) ? id : undefined;
			if (kind === "builtInVariable" ? !builtInType : !isGtmId(id)) {
				return fail(
					kind === "builtInVariable"
						? `id must be a built-in variable type such as "clickUrl" (got ${JSON.stringify(id)}).`
						: `id must be a numeric ${kind} ID such as "123".`,
				);
			}
			if (kind === "builtInVariable" && fingerprint !== undefined) {
				return fail("Built-in variables have no fingerprint: call again without fingerprint.");
			}
			const workspace = workspacePath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const status = await ws.getStatus(gtm, { path: workspace });
					const change = (status?.workspaceChange ?? []).find((e) => statusId(e, kind) === id);
					if (!change) {
						return fail(`Workspace ${ids.workspaceId} has no change to ${kind} ${id}, so there is nothing to revert.`);
					}
					const conflicted = (status?.mergeConflict ?? []).some((c) => {
						const e = c.entityInWorkspace ?? c.entityInBaseVersion;
						return e !== undefined && statusId(e, kind) === id;
					});
					// Q34: reverting an added folder removes it, which GTM refuses while it holds anything.
					const contents =
						kind === "folder" && change.changeStatus === "added"
							? contentRows(await folderContents(gtm, folderPath({ ...ids, folderId: id })))
							: [];
					return okPreview(
						{
							wouldRevert: {
								...describeEntity(change),
								...(builtInType ? { type: builtInType } : {}),
								changeStatus: change.changeStatus,
							},
							effect: EFFECT[change.changeStatus ?? ""] ?? "Its workspace changes are discarded.",
							...(conflicted ? { mergeConflict: true } : {}),
							...(contents.length > 0
								? {
										contains: contents,
										warning: `GTM will refuse to remove this folder while it holds these. ${FOLDER_FIX}`,
									}
								: {}),
						},
						"Nothing was reverted. The workspace changes to this entity would be lost. Get the user's go-ahead, then call revert_workspace_entity again with confirm: true.",
					);
				},
				apply: async () => {
					if (kind === "builtInVariable") {
						// builtInType is set: checked before confirmGate.
						const r = await ws.builtInVariables.revert(gtm, { path: workspace, type: builtInType });
						return okWrite({ reverted: { kind, id }, enabled: r?.enabled === true });
					}
					if (fingerprint !== undefined) await checkFingerprint(gtm, kind, ids, id, fingerprint);
					let after: Entity;
					try {
						after = await revert(gtm, kind, ids, id, fingerprint);
					} catch (error) {
						if (kind !== "folder" || !(error instanceof GtmApiError) || error.kind !== "invalid") throw error;
						const contents = await folderContents(gtm, folderPath({ ...ids, folderId: id })).then(
							contentRows,
							() => [],
						);
						if (contents.length === 0) throw error;
						throw new GtmInputError(
							`Nothing was reverted: GTM refuses to remove folder ${id} (added in this workspace) while it holds ${contents.join(", ")}. ${FOLDER_FIX}`,
						);
					}
					const exists = Object.values(after).some((v) => v !== undefined);
					return okWrite({
						reverted: { kind, id },
						now: exists ? describeEntity(after) : "gone: it is not in the latest version",
					});
				},
			});
		},
	);
};
