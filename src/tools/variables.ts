import { z } from "zod";
import { accounts, type Variable } from "../gtm/generated";
import { createVariable, updateVariable } from "../gtm/merge";
import { variablePath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, okEntity, okList } from "../mcp/result";
import {
	confirmInput,
	fingerprintInput,
	gtmId,
	nameInput,
	notesInput,
	parametersInput,
	workspaceInput,
} from "./inputs";
import { deleteWithConfirm, isEmptyPatch, okWrite } from "./write";

const variables = accounts.containers.workspaces.variables;

/** One list_variables row; also the delete_variable preview. */
export function variableRow(v: Variable) {
	return { variableId: v.variableId, name: v.name, type: v.type, parentFolderId: v.parentFolderId };
}

/** Variable fields a caller may set (Google's names). Q15 is applied by normalizeVariable. */
const variableFields = z.object({
	name: nameInput("Variable"),
	type: z
		.string()
		.trim()
		.min(1)
		.describe('Variable type, e.g. "v" (Data Layer), "c" (Constant), "k" (Cookie), "jsm" (Custom JS), "u" (URL)'),
	parameter: parametersInput.optional(),
	notes: notesInput,
});

const variableIdInput = { variableId: gtmId("Variable ID") };

export const variableTools: ToolGroup = (tools) => {
	tools.add(
		"list_variables",
		{
			description:
				"List the user-defined variables in a GTM workspace: ID, name, type and folder. Built-ins: list_built_in_variables.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = workspacePath(ids);
			const list = await gtm.listAll(
				(pageToken) => variables.list(gtm, { parent, pageToken }),
				(page) => page.variable,
			);
			return okList("variables", list, variableRow);
		},
	);

	tools.add(
		"get_variable",
		{
			description: "Get one user-defined variable with all its parameters and fingerprint.",
			input: workspaceInput.extend(variableIdInput),
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(await variables.get(gtm, { path: variablePath(ids) })),
	);

	tools.add(
		"create_variable",
		{
			description:
				"Create a user-defined variable in a workspace (for built-ins use enable_built_in_variables). Not live until a version is published.",
			input: workspaceInput.extend(variableFields.shape).extend({ parentFolderId: gtmId("Folder ID").optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const { result, warnings } = await createVariable(gtm, parent, fields);
			return okWrite({ variable: result }, { warnings });
		},
	);

	tools.add(
		"update_variable",
		{
			description:
				"Change some fields of a variable; omitted fields are kept. Pass the fingerprint from get_variable to avoid overwriting newer edits.",
			input: workspaceInput
				.extend(variableIdInput)
				.extend(variableFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, variableId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one variable field.");
			const path = variablePath({ accountId, containerId, workspaceId, variableId });
			const { result, warnings } = await updateVariable(gtm, path, fields, { expectedFingerprint: fingerprint });
			return okWrite({ variable: result }, { warnings });
		},
	);

	tools.add(
		"delete_variable",
		{
			description: "Delete a variable from a workspace. Without confirm: true, only shows what would be deleted.",
			input: workspaceInput.extend(variableIdInput).extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = variablePath(ids);
			return deleteWithConfirm({
				confirm,
				kind: "variable",
				id: ids.variableId,
				get: () => variables.get(gtm, { path }),
				summarize: variableRow,
				remove: () => variables.delete(gtm, { path }),
			});
		},
	);
};
