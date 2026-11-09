// revert_workspace_entity: discard a workspace's changes to one entity, of any kind GTM can
// revert (tag, trigger, variable, folder, zone, template, client, transformation, built-in
// variable). One generic tool instead of nine, to save tools/list bytes; it also covers
// Paolo's separate revert_folder. Confirm-gated: the workspace edits are lost.

import { z } from "zod";
import type { GtmClient } from "../gtm/client";
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
import { confirmInput, fingerprintInput, workspaceInput } from "./inputs";
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

export const revertTools: ToolGroup = (tools) => {
	tools.add(
		"revert_workspace_entity",
		{
			description:
				"Discard a workspace's changes to one entity (an added one is removed). Without confirm: true, only previews.",
			input: workspaceInput.extend({
				kind: z.enum(REVERT_KINDS),
				id: z.string().describe("Entity ID; for builtInVariable its type, e.g. clickUrl"),
				fingerprint: fingerprintInput,
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
					return okPreview(
						{
							wouldRevert: {
								...describeEntity(change),
								...(builtInType ? { type: builtInType } : {}),
								changeStatus: change.changeStatus,
							},
							effect: EFFECT[change.changeStatus ?? ""] ?? "Its workspace changes are discarded.",
							...(conflicted ? { mergeConflict: true } : {}),
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
					const after = await revert(gtm, kind, ids, id, fingerprint);
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
