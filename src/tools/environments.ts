// Environments: container-level, not workspace edits. They take effect at once (no version or
// publish step). A user environment serves whatever container version or workspace it points
// to, to every page that loads the container with its gtm_auth / gtm_preview, so repointing,
// deleting or reauthorizing one changes what those pages load. Those three are confirm-gated.
// Google (Environment in generated.ts): only `user` environments can be created, deleted or
// renamed; other types only take changes to `url` and `enableDebug`.

import { z } from "zod";
import { accounts, type Environment } from "../gtm/generated";
import { getMergePut } from "../gtm/merge";
import { containerPath, environmentPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, fail, ok, okEntity, okList } from "../mcp/result";
import { confirmGate, deleteWithConfirm, okPreview } from "./confirm";
import { confirmInput, containerInput, fingerprintInput, gtmId, nameInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const environments = accounts.containers.environments;

export const ENVIRONMENT_NOTE =
	"Environment changes take effect immediately; they are not part of any workspace or version.";

/** List row and previews; the authorization code is left to get_environment. */
export function environmentRow(e: Environment) {
	return {
		environmentId: e.environmentId,
		name: e.name,
		type: e.type,
		url: e.url,
		containerVersionId: e.containerVersionId,
		workspaceId: e.workspaceId,
	};
}

const environmentIds = containerInput.extend({ environmentId: gtmId("Environment ID") });

const editable = {
	description: z.string().optional(),
	url: z.string().optional().describe("Default preview URL"),
	enableDebug: z.boolean().optional(),
};

/** Fields Google lets you change only on `user` environments. */
const USER_ONLY_FIELDS = ["name", "description", "containerVersionId", "workspaceId"] as const;

export const environmentTools: ToolGroup = (tools) => {
	tools.add(
		"list_environments",
		{
			description: "List a container's environments (Live, Latest, workspace previews and user environments).",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = containerPath(ids);
			const list = await gtm.listAll(
				(pageToken) => environments.list(gtm, { parent, pageToken }),
				(page) => page.environment,
			);
			return okList("environments", list, environmentRow);
		},
	);

	tools.add(
		"get_environment",
		{
			description: "Get an environment, with its authorization code (gtm_auth) and fingerprint.",
			input: environmentIds,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(await environments.get(gtm, { path: environmentPath(ids) })),
	);

	tools.add(
		"create_environment",
		{
			description:
				"Create a user environment (e.g. staging) in a container. Point it at a version with update_environment.",
			input: containerInput.extend({ name: nameInput("Environment"), ...editable }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ accountId, containerId, ...fields }, { gtm }) => {
			const parent = containerPath({ accountId, containerId });
			const result = await environments.create(gtm, { parent }, { ...fields, type: "user" });
			return okWrite({ environment: result }, { note: ENVIRONMENT_NOTE });
		},
	);

	tools.add(
		"update_environment",
		{
			description:
				"Change an environment; omitted fields are kept. Repointing it (containerVersionId/workspaceId) needs confirm: true.",
			input: environmentIds.extend({
				name: nameInput("Environment").optional(),
				...editable,
				containerVersionId: gtmId("Version to serve").optional(),
				workspaceId: gtmId("Workspace to serve").optional(),
				fingerprint: fingerprintInput,
				confirm: confirmInput("repoint the environment"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ accountId, containerId, environmentId, fingerprint, confirm, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one environment field.");
			if (fields.containerVersionId !== undefined && fields.workspaceId !== undefined) {
				return fail("Nothing was changed: an environment serves a version or a workspace, so pass one of them.");
			}
			const path = environmentPath({ accountId, containerId, environmentId });
			const current = await environments.get(gtm, { path });
			if (current.type !== "user") {
				const refused = USER_ONLY_FIELDS.filter((f) => fields[f] !== undefined);
				if (refused.length > 0) {
					return fail(
						`Nothing was changed: on a "${current.type}" environment Google only allows url and enableDebug to change, not ${refused.join(", ")}.`,
					);
				}
			}
			// Repointing replaces the target: the merged body must not keep the old one too, or the
			// environment would name both a workspace and a version.
			const base: Environment = { ...current };
			if (fields.workspaceId !== undefined) delete base.containerVersionId;
			if (fields.containerVersionId !== undefined) delete base.workspaceId;
			const update = () =>
				getMergePut<Environment, Partial<Environment>>({
					path,
					patch: fields,
					expectedFingerprint: fingerprint,
					get: async () => base,
					put: (body, stored) => environments.update(gtm, { path, fingerprint: stored }, body),
					normalize: (patch) => ({ value: patch, warnings: [] }),
				}).then(({ result }) => okWrite({ environment: result }, { note: ENVIRONMENT_NOTE }));
			const repoints = fields.containerVersionId !== undefined || fields.workspaceId !== undefined;
			if (!repoints) return update();
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{
							environment: compact(environmentRow(current)),
							wouldServe: compact({ containerVersionId: fields.containerVersionId, workspaceId: fields.workspaceId }),
						},
						"Nothing was changed. Every page that loads this environment would get the new version at once. Get the user's go-ahead, then call update_environment again with confirm: true.",
					),
				apply: update,
			});
		},
	);

	tools.add(
		"reauthorize_environment",
		{
			description:
				"Generate a new authorization code (gtm_auth) for an environment; the old one stops working at once. Without confirm: true, only previews.",
			input: environmentIds.extend({ confirm: confirmInput("reauthorize") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = environmentPath(ids);
			return confirmGate({
				confirm,
				preview: async () =>
					okPreview(
						{ environment: compact(environmentRow(await environments.get(gtm, { path }))) },
						"Nothing was changed. Reauthorizing invalidates the current gtm_auth code: every snippet or share link using it stops loading this environment until updated. Get the user's go-ahead, then call reauthorize_environment again with confirm: true.",
					),
				apply: async () => {
					const e = await environments.reauthorize(gtm, { path }, {});
					return ok({
						environment: compact({
							environmentId: e.environmentId,
							name: e.name,
							authorizationCode: e.authorizationCode,
							authorizationTimestamp: e.authorizationTimestamp,
						}),
						note: "The old authorization code no longer works. Update every snippet and share link that used it.",
					});
				},
			});
		},
	);

	tools.add(
		"delete_environment",
		{
			description:
				"Delete a user environment; pages using its snippet stop loading it. Without confirm: true, only previews.",
			input: environmentIds.extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = environmentPath(ids);
			return deleteWithConfirm({
				confirm,
				toolName: "delete_environment",
				kind: "environment",
				id: ids.environmentId,
				get: () => environments.get(gtm, { path }),
				summarize: environmentRow,
				remove: () => environments.delete(gtm, { path }),
				note: ENVIRONMENT_NOTE,
			});
		},
	);
};
