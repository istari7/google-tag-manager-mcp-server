import type { GtmClient } from "../gtm/client";
import { accounts } from "../gtm/generated";
import { folderPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, fail, okList } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { confirmInput, gtmId, idList, nameInput, notesInput, workspaceInput } from "./inputs";
import { okWrite } from "./write";

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

const defined = (list: (string | undefined)[]) => list.filter((id): id is string => id !== undefined);

/** The contents without `type`: what delete_folder lists. compact() drops empty lists. */
function contentsRows(c: FolderContents) {
	return compact({
		tags: c.tags.map(({ tagId, name }) => ({ tagId, name })),
		triggers: c.triggers.map(({ triggerId, name }) => ({ triggerId, name })),
		variables: c.variables.map(({ variableId, name }) => ({ variableId, name })),
	});
}

const isEmpty = (c: FolderContents) => c.tags.length + c.triggers.length + c.variables.length === 0;

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
		"create_folder",
		{
			description:
				"Create a folder in a workspace. Use move_entities_to_folder to put tags, triggers and variables in it.",
			input: workspaceInput.extend({ name: nameInput("Folder"), notes: notesInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ name, notes, ...ids }, { gtm }) => {
			const folder = await folders.create(gtm, { parent: workspacePath(ids) }, { name, notes });
			return okWrite({ folder: { folderId: folder.folderId, name: folder.name, notes: folder.notes || undefined } });
		},
	);

	tools.add(
		"move_entities_to_folder",
		{
			description:
				'Move tags, triggers and variables into a folder. folderId "0" moves them out of their current folder.',
			input: workspaceInput.extend({
				folderId: gtmId('Folder ID, or "0" for no folder'),
				tagId: idList("Tag").optional(),
				triggerId: idList("Trigger").optional(),
				variableId: idList("Variable").optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ tagId = [], triggerId = [], variableId = [], ...ids }, { gtm }) => {
			if (tagId.length + triggerId.length + variableId.length === 0) {
				return fail("Nothing to move: pass at least one tagId, triggerId or variableId.");
			}
			// Q19: IDs are repeated query parameters; the body is an empty Folder.
			await folders.moveEntitiesToFolder(gtm, { path: folderPath(ids), tagId, triggerId, variableId }, {});
			// okWrite's compact() drops the empty lists.
			return okWrite({ folderId: ids.folderId, moved: { tagId, triggerId, variableId } });
		},
	);

	tools.add(
		"delete_folder",
		{
			description:
				"Delete a folder. Its tags, triggers and variables are kept, outside any folder. Without confirm: true, only previews.",
			input: workspaceInput.extend({ folderId: gtmId("Folder ID"), confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = folderPath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const [f, contents] = await Promise.all([folders.get(gtm, { path }), folderContents(gtm, path)]);
					return okPreview(
						{
							wouldDelete: compact({
								kind: "folder",
								folderId: f.folderId,
								name: f.name,
								contains: contentsRows(contents),
								containsNote: isEmpty(contents) ? undefined : "These are kept, outside any folder.",
							}),
						},
						"Nothing was deleted. To delete this folder, get the user's go-ahead, then call delete_folder again with confirm: true.",
					);
				},
				apply: async () => {
					// Q25: GTM refuses to delete a folder that still holds anything, so move its contents
					// out first (folder "0", Q19), then delete it.
					const contents = await folderContents(gtm, path);
					if (!isEmpty(contents)) {
						await folders.moveEntitiesToFolder(
							gtm,
							{
								path: folderPath({ ...ids, folderId: "0" }),
								tagId: defined(contents.tags.map((t) => t.tagId)),
								triggerId: defined(contents.triggers.map((t) => t.triggerId)),
								variableId: defined(contents.variables.map((v) => v.variableId)),
							},
							{},
						);
					}
					await folders.delete(gtm, { path });
					return okWrite({ deleted: { kind: "folder", id: ids.folderId }, movedOutOfFolder: contentsRows(contents) });
				},
			});
		},
	);
};
