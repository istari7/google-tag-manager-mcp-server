import type { GtmClient } from "../gtm/client";
import { accounts } from "../gtm/generated";
import { folderPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, okList } from "../mcp/result";
import { deleteWithConfirm } from "./confirm";
import { confirmInput, gtmId, idList, nameInput, notesInput, workspaceInput } from "./inputs";
import { okWrite } from "./write";

const folders = accounts.containers.workspaces.folders;

/** Everything in a folder. folders.entities is a POST but only reads (Discovery: "List all entities in a GTM Folder"). */
async function folderContents(gtm: GtmClient, path: string) {
	const pages = await gtm.listAll(
		(pageToken) => folders.entities(gtm, { path, pageToken }),
		(page) => [page],
	);
	const tags = pages.items.flatMap((p) => p.tag ?? []);
	const triggers = pages.items.flatMap((p) => p.trigger ?? []);
	const variables = pages.items.flatMap((p) => p.variable ?? []);
	const defined = (list: (string | undefined)[]) => list.filter((id): id is string => id !== undefined);
	return {
		tagId: defined(tags.map((t) => t.tagId)),
		triggerId: defined(triggers.map((t) => t.triggerId)),
		variableId: defined(variables.map((v) => v.variableId)),
		labels: [
			...tags.map((t) => `tag ${t.tagId} "${t.name}"`),
			...triggers.map((t) => `trigger ${t.triggerId} "${t.name}"`),
			...variables.map((v) => `variable ${v.variableId} "${v.name}"`),
		],
	};
}

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
};

/** Creating, filling and deleting folders: the optional `folder-admin` group (src/tools/groups.ts). */
export const folderAdminTools: ToolGroup = (tools) => {
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
			return deleteWithConfirm({
				confirm,
				toolName: "delete_folder",
				kind: "folder",
				id: ids.folderId,
				get: () => folders.get(gtm, { path }),
				summarize: (f) => ({ folderId: f.folderId, name: f.name }),
				related: async () => {
					const { labels } = await folderContents(gtm, path);
					return { contains: labels, containsNote: labels.length ? "These are kept, outside any folder." : undefined };
				},
				// Q25: GTM refuses to delete a folder that still holds anything, so move its contents
				// out first (folder "0", Q19), then delete it.
				remove: async () => {
					const { tagId, triggerId, variableId } = await folderContents(gtm, path);
					if (tagId.length + triggerId.length + variableId.length > 0) {
						await folders.moveEntitiesToFolder(
							gtm,
							{ path: folderPath({ ...ids, folderId: "0" }), tagId, triggerId, variableId },
							{},
						);
					}
					await folders.delete(gtm, { path });
				},
			});
		},
	);
};
