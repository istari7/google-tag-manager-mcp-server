import { z } from "zod";
import { accounts, type QuickPreviewResponse, type Workspace } from "../gtm/generated";
import { getMergePut } from "../gtm/merge";
import { containerPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok, okEntity, okList } from "../mcp/result";
import { deleteWithConfirm } from "./confirm";
import { confirmInput, containerInput, fingerprintInput, nameInput, workspaceInput } from "./inputs";
import { summarizeWorkspaceStatus, versionCounts, WORKSPACE_NOT_LIVE_NOTE } from "./summaries";
import { isEmptyPatch, okWrite } from "./write";

const workspaces = accounts.containers.workspaces;

/** Q27: a new workspace copies the latest saved version, which need not be the live one. */
export const NEW_WORKSPACE_NOTE =
	"It starts as a copy of the latest saved version, which may not be the live one (get_live_version); entities already in it are not your changes.";

function workspaceSummary(w: Workspace) {
	return { workspaceId: w.workspaceId, name: w.name, description: w.description, fingerprint: w.fingerprint };
}

/** Why a quick preview did not compile, or undefined when it did (the Q20 shapes). */
export function quickPreviewProblem(response: QuickPreviewResponse | undefined): string | undefined {
	if (response?.compilerError) return "The workspace does not compile. Fix the errors shown in GTM, then retry.";
	if (response?.syncStatus?.mergeConflict) {
		return "The workspace has merge conflicts with the latest version. Resolve them in GTM, then retry.";
	}
	if (response?.syncStatus?.syncError) return "GTM could not sync the workspace with the latest version. Retry.";
	if (!response?.containerVersion) return "GTM returned no preview for this workspace.";
	return undefined;
}

export const workspaceTools: ToolGroup = (tools) => {
	tools.add(
		"list_workspaces",
		{
			description: "List a container's workspaces. Edits happen in a workspace, not on the live container.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = containerPath(ids);
			const list = await gtm.listAll(
				(pageToken) => workspaces.list(gtm, { parent, pageToken }),
				(page) => page.workspace,
			);
			return okList("workspaces", list, (w) => ({
				workspaceId: w.workspaceId,
				name: w.name,
				description: w.description,
			}));
		},
	);

	tools.add(
		"get_workspace",
		{
			description: "Get a workspace's name and description, plus its fingerprint for update_workspace.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(workspaceSummary(await workspaces.get(gtm, { path: workspacePath(ids) }))),
	);

	tools.add(
		"update_workspace",
		{
			description: "Rename a workspace or change its description. Omitted fields are kept.",
			input: workspaceInput.extend({
				name: z.string().trim().min(1).max(256).optional(),
				description: z.string().optional().describe('"" clears it'),
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ name, description, fingerprint, ...ids }, { gtm }) => {
			if (isEmptyPatch({ name, description })) return fail("Nothing to change: pass name and/or description.");
			const path = workspacePath(ids);
			// Q1/Q2: workspaces.update is a PUT, so get-merge-put keeps the fields left out.
			const { result } = await getMergePut<Workspace, Partial<Workspace>>({
				path,
				patch: { name, description },
				expectedFingerprint: fingerprint,
				get: () => workspaces.get(gtm, { path }),
				put: (body, fp) => workspaces.update(gtm, { path, fingerprint: fp }, body),
				normalize: (patch) => ({ value: patch, warnings: [] }),
			});
			return okWrite(
				{ workspace: workspaceSummary(result) },
				{ note: "Only the workspace's name or description changed; nothing on the site changed." },
			);
		},
	);

	tools.add(
		"get_workspace_status",
		{
			description:
				"List a workspace's pending changes and merge conflicts. Nothing is live until create_version, then publish_version.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => ok(summarizeWorkspaceStatus(await workspaces.getStatus(gtm, { path: workspacePath(ids) }))),
	);

	tools.add(
		"create_workspace",
		{
			description:
				"Create a workspace in a container, e.g. one per change. Containers allow few workspaces (3 on standard accounts).",
			input: containerInput.extend({
				name: nameInput("Workspace"),
				description: z.string().optional().describe("What the change is for"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ name, description, ...ids }, { gtm }) => {
			const w = await workspaces.create(gtm, { parent: containerPath(ids) }, { name, description });
			return okWrite(
				{ workspace: { workspaceId: w.workspaceId, name: w.name, description: w.description } },
				{ note: `${NEW_WORKSPACE_NOTE} ${WORKSPACE_NOT_LIVE_NOTE}` },
			);
		},
	);

	tools.add(
		"quick_preview_workspace",
		{
			description:
				"Check that a workspace compiles by building a throwaway preview version. Saves and publishes nothing.",
			input: workspaceInput,
			// A POST that builds a preview on Google's side: not a read, though nothing is saved.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (ids, { gtm }) => {
			const response = await workspaces.quickPreview(gtm, { path: workspacePath(ids) });
			const problem = quickPreviewProblem(response);
			if (problem) return fail(problem);
			return ok({
				compiles: true,
				...(response.containerVersion ? { counts: versionCounts(response.containerVersion) } : {}),
				note: "Preview only: nothing was saved or published.",
			});
		},
	);

	tools.add(
		"delete_workspace",
		{
			description:
				"Delete a workspace and discard its unversioned changes. Without confirm: true, only previews what would be lost. Saved versions are kept.",
			input: workspaceInput.extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = workspacePath(ids);
			return deleteWithConfirm({
				confirm,
				toolName: "delete_workspace",
				kind: "workspace",
				id: ids.workspaceId,
				get: () => workspaces.get(gtm, { path }),
				summarize: (w) => ({ workspaceId: w.workspaceId, name: w.name, description: w.description }),
				related: async () => {
					const status = await workspaces.getStatus(gtm, { path });
					return { unversionedChanges: (status?.workspaceChange ?? []).length };
				},
				remove: () => workspaces.delete(gtm, { path }),
				note: "The workspace and its unversioned changes are gone. Saved versions and the live container are unchanged.",
			});
		},
	);
};
