// Folder reads and edits beyond the default folder tools: get_folder, update_folder,
// get_folder_entities.

import { z } from "zod";
import { accounts } from "../gtm/generated";
import { updateFolder } from "../gtm/merge";
import { folderPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok } from "../mcp/result";
import { addGetTool, workspaceEntity } from "./entity";
import { folderContents } from "./folders";
import { fingerprintInput, gtmId, notesInput, workspaceInput } from "./inputs";
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

export const folderAdminTools: ToolGroup = (tools) => {
	addGetTool(tools, folder, {
		name: "get_folder",
		description: "Get a folder's name and notes, plus its fingerprint for update_folder.",
	});

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
		"get_folder_entities",
		{
			description: "List the tags, triggers and variables in a folder (ID, name, type).",
			input: folderIds,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => ok(await folderContents(gtm, folderPath(ids))),
	);
};
