// Version reads and lifecycle: get_version, get_latest_version_header, update_version,
// delete_version, undelete_version, set_latest_version. Delete, undelete and set-latest are
// confirm-gated (./confirm.ts), like Paolo's server. None of them changes the live site.

import { z } from "zod";
import { GtmApiError } from "../gtm/errors";
import { accounts, type ContainerVersion } from "../gtm/generated";
import { containerPath, versionPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, fail, ok, okEntity } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { confirmInput, containerInput, fingerprintInput, gtmId } from "./inputs";
import { summarizeVersion, versionHeadline } from "./summaries";
import { liveVersion, versionRow } from "./versions";
import { isEmptyPatch, okWrite } from "./write";

const versions = accounts.containers.versions;
const versionHeaders = accounts.containers.versionHeaders;

const versionInput = containerInput.extend({ containerVersionId: gtmId("Container version ID (from list_versions)") });

const NOT_LIVE_NOTE = "The live site is unchanged.";

function headline(v: ContainerVersion) {
	return compact({ ...versionHeadline(v), fingerprint: v.fingerprint });
}

/** Cheap version reads: in the default `workspaces` group (src/tools/index.ts). */
export const versionReadTools: ToolGroup = (tools) => {
	tools.add(
		"get_version",
		{
			description:
				"Summarise a saved version: counts and each tag, trigger and variable (name, type). full: true returns all of it.",
			input: versionInput.extend({
				full: z.boolean().optional().describe("Parameters included (large)"),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ containerVersionId, full, ...ids }, { gtm }) => {
			const v = await versions.get(gtm, { path: versionPath({ ...ids, versionId: containerVersionId }) });
			return full ? okEntity(v) : okEntity({ ...summarizeVersion(v), fingerprint: v.fingerprint });
		},
	);

	tools.add(
		"get_latest_version_header",
		{
			description:
				"Get the latest version's header: the base new workspaces start from. May differ from the live version.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(versionRow(await versionHeaders.latest(gtm, { parent: containerPath(ids) }))),
	);
};

/** Version lifecycle: the optional `version-admin` group. */
export const versionAdminTools: ToolGroup = (tools) => {
	tools.add(
		"update_version",
		{
			description: "Rename a saved version or change its description (notes).",
			input: versionInput.extend({
				name: z.string().trim().min(1).max(256).optional(),
				description: z.string().optional().describe('"" clears it'),
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ containerVersionId, name, description, fingerprint, ...ids }, { gtm }) => {
			if (isEmptyPatch({ name, description })) return fail("Nothing to change: pass name and/or description.");
			const path = versionPath({ ...ids, versionId: containerVersionId });
			const current = await versions.get(gtm, { path });
			// Q2: a stale fingerprint from the caller's read fails like every other update.
			if (fingerprint !== undefined && fingerprint !== current.fingerprint) throw GtmApiError.conflict("PUT", path);
			// Only the metadata goes in the body, as Paolo's server does: a version's contents are
			// fixed. The stored fingerprint guards the gap between this GET and the PUT (Q2).
			const result = await versions.update(
				gtm,
				{ path, fingerprint: current.fingerprint },
				{ name: name ?? current.name, description: description ?? current.description },
			);
			return okWrite({ version: headline(result) }, { note: NOT_LIVE_NOTE });
		},
	);

	tools.add(
		"delete_version",
		{
			description:
				"Delete (archive) a saved version, not the live one; undelete_version restores it. Without confirm: true, only previews.",
			input: versionInput.extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ containerVersionId, confirm, ...ids }, { gtm }) => {
			const path = versionPath({ ...ids, versionId: containerVersionId });
			const live = await liveVersion(gtm, containerPath(ids));
			if (live?.containerVersionId === containerVersionId) {
				return fail(
					`Version ${containerVersionId} is the live version, so it can't be deleted. Publish another version first.`,
				);
			}
			return confirmGate({
				confirm,
				preview: async () => {
					const v = await versions.get(gtm, { path });
					if (v.deleted) return fail(`Version ${containerVersionId} is already deleted.`);
					return okPreview(
						{ wouldDelete: { kind: "version", ...versionHeadline(v) } },
						"Nothing was deleted. Get the user's go-ahead, then call delete_version again with confirm: true. undelete_version can restore it.",
					);
				},
				apply: async () => {
					await versions.delete(gtm, { path });
					return ok({
						deleted: { kind: "version", id: containerVersionId },
						note: `Version ${containerVersionId} is deleted (archived); undelete_version restores it. ${NOT_LIVE_NOTE}`,
					});
				},
			});
		},
	);

	tools.add(
		"undelete_version",
		{
			description: "Restore a deleted container version. Without confirm: true, only previews.",
			input: versionInput.extend({ confirm: confirmInput("restore it") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ containerVersionId, confirm, ...ids }, { gtm }) => {
			const path = versionPath({ ...ids, versionId: containerVersionId });
			return confirmGate({
				confirm,
				preview: async () => {
					const v = await versions.get(gtm, { path });
					if (!v.deleted) return fail(`Version ${containerVersionId} is not deleted, so there is nothing to restore.`);
					return okPreview(
						{ wouldRestore: versionHeadline(v) },
						"Nothing was restored. Get the user's go-ahead, then call undelete_version again with confirm: true.",
					);
				},
				apply: async () => {
					const v = await versions.undelete(gtm, { path });
					return ok({ restored: versionHeadline(v), note: `The version is back in list_versions. ${NOT_LIVE_NOTE}` });
				},
			});
		},
	);

	tools.add(
		"set_latest_version",
		{
			description:
				"Make a saved version the latest: new workspaces and syncs start from it. Does not publish. Without confirm: true, only previews.",
			input: versionInput.extend({ confirm: confirmInput("set it as latest") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ containerVersionId, confirm, ...ids }, { gtm }) => {
			const path = versionPath({ ...ids, versionId: containerVersionId });
			return confirmGate({
				confirm,
				preview: async () => {
					const [v, latest] = await Promise.all([
						versions.get(gtm, { path }),
						versionHeaders.latest(gtm, { parent: containerPath(ids) }),
					]);
					if (v.deleted) return fail(`Version ${containerVersionId} is deleted; undelete_version it first.`);
					return okPreview(
						{
							wouldSetLatest: versionHeadline(v),
							currentLatest: { containerVersionId: latest.containerVersionId, name: latest.name },
							...(latest.containerVersionId === containerVersionId ? { alreadyLatest: true } : {}),
						},
						"Nothing was changed. New workspaces and workspace syncs would start from this version; the live site would not change. Get the user's go-ahead, then call set_latest_version again with confirm: true.",
					);
				},
				apply: async () => {
					const v = await versions.setLatest(gtm, { path });
					return ok({
						latest: versionHeadline(v),
						note: `New workspaces and syncs now start from version ${containerVersionId}. ${NOT_LIVE_NOTE}`,
					});
				},
			});
		},
	);
};
