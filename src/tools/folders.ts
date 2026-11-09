import { accounts } from "../gtm/generated";
import { folderPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, okList } from "../mcp/result";
import { gtmId, idList, nameInput, notesInput, workspaceInput } from "./inputs";
import { okWrite } from "./write";

const folders = accounts.containers.workspaces.folders;

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
};
