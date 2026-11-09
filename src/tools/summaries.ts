// Compact summaries of workspace status and container versions, shared by the workspace and
// version tools (get_workspace_status, create_version, quick_preview_workspace, get_live_version).

import type { ContainerVersion, Entity, GetWorkspaceStatusResponse } from "../gtm/generated";
import { compact } from "../mcp/result";

/** Q9 (GTM_API_QUIRKS.md): the model must not tell the user that workspace changes are live. */
export const WORKSPACE_NOT_LIVE_NOTE =
	"Workspace changes are not live. They reach the site only after a version is created from this workspace (create_version) and published (publish_version, only with the user's go-ahead, or in the GTM UI).";

/** The entity inside a status Entity: its kind, ID and name. */
export function describeEntity(entity: Entity | undefined) {
	if (!entity) return undefined;
	if (entity.tag) return { kind: "tag", id: entity.tag.tagId, name: entity.tag.name };
	if (entity.trigger) return { kind: "trigger", id: entity.trigger.triggerId, name: entity.trigger.name };
	if (entity.variable) return { kind: "variable", id: entity.variable.variableId, name: entity.variable.name };
	if (entity.folder) return { kind: "folder", id: entity.folder.folderId, name: entity.folder.name };
	if (entity.builtInVariable) return { kind: "builtInVariable", name: entity.builtInVariable.name };
	if (entity.client) return { kind: "client", id: entity.client.clientId, name: entity.client.name };
	if (entity.customTemplate) {
		return { kind: "template", id: entity.customTemplate.templateId, name: entity.customTemplate.name };
	}
	if (entity.transformation) {
		return { kind: "transformation", id: entity.transformation.transformationId, name: entity.transformation.name };
	}
	if (entity.zone) return { kind: "zone", id: entity.zone.zoneId, name: entity.zone.name };
	if (entity.gtagConfig) return { kind: "gtagConfig", id: entity.gtagConfig.gtagConfigId };
	return { kind: "unknown" };
}

export function summarizeWorkspaceStatus(status: GetWorkspaceStatusResponse | undefined) {
	const changes = (status?.workspaceChange ?? []).map((e) => ({ ...describeEntity(e), changeStatus: e.changeStatus }));
	const conflicts = (status?.mergeConflict ?? []).map((c) =>
		describeEntity(c.entityInWorkspace ?? c.entityInBaseVersion),
	);
	return {
		changeCount: changes.length,
		conflictCount: conflicts.length,
		...compact({ changes, conflicts }),
		note:
			conflicts.length > 0
				? `Resolve the merge conflicts in the GTM UI before creating a version. ${WORKSPACE_NOT_LIVE_NOTE}`
				: changes.length > 0
					? WORKSPACE_NOT_LIVE_NOTE
					: "No pending changes in this workspace.",
	};
}

const count = (list: readonly unknown[] | undefined) => list?.length ?? 0;

/** Tag/trigger/variable counts, plus any other entity kind the version has. */
export function versionCounts(v: ContainerVersion) {
	const optional = {
		folders: count(v.folder),
		builtInVariables: count(v.builtInVariable),
		customTemplates: count(v.customTemplate),
		clients: count(v.client),
		transformations: count(v.transformation),
		zones: count(v.zone),
		gtagConfigs: count(v.gtagConfig),
	};
	return {
		tags: count(v.tag),
		triggers: count(v.trigger),
		variables: count(v.variable),
		...Object.fromEntries(Object.entries(optional).filter(([, n]) => n > 0)),
	};
}

/** ID, name, description and counts: the headline of a version. */
export function versionHeadline(v: ContainerVersion) {
	return compact({
		containerVersionId: v.containerVersionId,
		name: v.name,
		description: v.description,
		deleted: v.deleted || undefined,
		counts: versionCounts(v),
	});
}

/** The headline plus a name/type row per tag, trigger and variable. Parameters are left out. */
export function summarizeVersion(v: ContainerVersion) {
	return compact({
		...versionHeadline(v),
		tags: v.tag?.map((t) => ({ tagId: t.tagId, name: t.name, type: t.type, paused: t.paused || undefined })),
		triggers: v.trigger?.map((t) => ({ triggerId: t.triggerId, name: t.name, type: t.type })),
		variables: v.variable?.map((x) => ({ variableId: x.variableId, name: x.name, type: x.type })),
	});
}
