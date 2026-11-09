import type { GtmClient } from "../gtm/client";
import { accounts } from "../gtm/generated";
import { folderPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { ok, okList } from "../mcp/result";
import { gtmId, workspaceInput } from "./inputs";

const folders = accounts.containers.workspaces.folders;

/**
 * Everything in a folder, one `{ tagId, name, type }`-style row per entity (the shape delete
 * previews use for related entities, like delete_trigger's usedByTags). folders.entities is
 * a POST but only reads (Discovery: "List all entities in a GTM Folder").
 */
export async function folderContents(gtm: GtmClient, path: string) {
	const pages = await gtm.listAll(
		(pageToken) => folders.entities(gtm, { path, pageToken }),
		(page) => [page],
	);
	const all = pages.items;
	return {
		tags: all.flatMap((p) => p.tag ?? []).map((t) => ({ tagId: t.tagId, name: t.name, type: t.type })),
		triggers: all.flatMap((p) => p.trigger ?? []).map((t) => ({ triggerId: t.triggerId, name: t.name, type: t.type })),
		variables: all
			.flatMap((p) => p.variable ?? [])
			.map((v) => ({ variableId: v.variableId, name: v.name, type: v.type })),
	};
}

export type FolderContents = Awaited<ReturnType<typeof folderContents>>;

/** Reading folders: the default `folders` group. */
export const folderTools: ToolGroup = (tools) => {
	tools.add(
		"list_folders",
		{
			description:
				"List the folders in a GTM workspace. Tags, triggers and variables point to theirs via parentFolderId.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = workspacePath(ids);
			const list = await gtm.listAll(
				(pageToken) => folders.list(gtm, { parent, pageToken }),
				(page) => page.folder,
			);
			return okList("folders", list, (f) => ({ folderId: f.folderId, name: f.name, notes: f.notes || undefined }));
		},
	);

	tools.add(
		"get_folder_entities",
		{
			description: "List the tags, triggers and variables in a folder (ID, name, type).",
			input: workspaceInput.extend({ folderId: gtmId("Folder ID") }),
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => ok(await folderContents(gtm, folderPath(ids))),
	);
};
