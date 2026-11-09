import { z } from "zod";
import { accounts, type Variable } from "../gtm/generated";
import { createVariable, updateVariable } from "../gtm/merge";
import { variablePath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import { fingerprintInput, gtmId, nameInput, notesInput, parametersInput, workspaceInput } from "./inputs";
import { referencePreview, rejectedDeleteMessage, variableReferences } from "./references";
import { isEmptyPatch, okWrite } from "./write";

const variables = accounts.containers.workspaces.variables;

const VARIABLE_FIX = "First replace or remove its {{name}} in those tags, triggers and variables, or delete them.";

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

const variable = workspaceEntity({
	kind: "variable",
	ids: workspaceInput.extend(variableIdInput),
	id: (ids) => ids.variableId,
	path: variablePath,
	api: variables,
	items: (page) => page.variable,
	row: variableRow,
});

export const variableTools: ToolGroup = (tools) => {
	addListTool(tools, variable, {
		name: "list_variables",
		key: "variables",
		description:
			"List a workspace's user-defined variables: ID, name, type, folder. Built-ins: list_built_in_variables.",
	});

	addGetTool(tools, variable, {
		name: "get_variable",
		description: "Get one user-defined variable with all its parameters and fingerprint.",
	});

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
				"Change some fields of a variable; omitted fields are kept. Pass get_variable's fingerprint to avoid overwriting newer edits.",
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

	addDeleteTool(tools, variable, {
		name: "delete_variable",
		description: "Delete a variable. Without confirm: true, only previews it and what uses it.",
		// Q26: GTM refuses to delete a variable that is still referenced as {{name}}.
		related: async (ids, { gtm }, found) =>
			referencePreview("variable", await variableReferences(gtm, ids, found), VARIABLE_FIX),
		rejected: async (ids, { gtm }) => {
			const found = await variables.get(gtm, { path: variablePath(ids) });
			return rejectedDeleteMessage("variable", ids.variableId, await variableReferences(gtm, ids, found), VARIABLE_FIX);
		},
	});
};
