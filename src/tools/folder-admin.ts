// Creating, editing, filling and deleting folders: the optional `folder-admin` group
// (src/tools/groups.ts). Reading them (list_folders, get_folder_entities) is in ./folders.ts.

import { z } from "zod";
import { accounts } from "../gtm/generated";
import { updateFolder } from "../gtm/merge";
import { folderPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, fail } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { addGetTool, workspaceEntity } from "./entity";
import { type FolderContents, folderContents } from "./folders";
import { confirmInput, fingerprintInput, gtmId, idList, nameInput, notesInput, workspaceInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const folders = accounts.containers.workspaces.folders;

const folderIds = workspaceInput.extend({ folderId: gtmId("Folder ID") });

const folder = workspaceEntity({
	kind: "folder",
	ids: folderIds,
	id: (ids) => ids.folderId,
	path: folderPath,
	api: folders,
	items: (page) => page.folder,
	row: (f) => ({ folderId: f.folderId, name: f.name, notes: f.notes || undefined }),
});

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

export const folderAdminTools: ToolGroup = (tools) => {
	addGetTool(tools, folder, {
		name: "get_folder",
		description: "Get a folder's name and notes, plus its fingerprint for update_folder.",
	});

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
		"update_folder",
		{
			description: "Rename a folder or change its notes. Omitted fields are kept.",
			input: folderIds.extend({
				name: z.string().trim().min(1).max(256).optional(),
				notes: notesInput,
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ name, notes, fingerprint, ...ids }, { gtm }) => {
			if (isEmptyPatch({ name, notes })) return fail("Nothing to change: pass name and/or notes.");
			// Q1/Q2/Q12: get-merge-put keeps every field the patch leaves out.
			const { result } = await updateFolder(
				gtm,
				folderPath(ids),
				{ name, notes },
				{ expectedFingerprint: fingerprint },
			);
			return okWrite({ folder: { folderId: result.folderId, name: result.name, notes: result.notes || undefined } });
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
