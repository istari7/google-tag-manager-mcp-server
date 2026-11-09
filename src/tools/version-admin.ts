// Version reads and lifecycle: get_version, get_latest_version_header, update_version,
// delete_version, undelete_version, set_latest_version. Delete, undelete and set-latest are
// confirm-gated (./confirm.ts), like Paolo's server. None of them changes the live site.

import { z } from "zod";
import { GtmApiError, GtmInputError } from "../gtm/errors";
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

/** Q34: the other version GTM won't delete, which no API call reveals. */
const BASE_VERSION_NOTE =
	"GTM also refuses to delete a version that a workspace is still based on (one not synced since this version was the latest).";

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
				"Delete (archive) a saved version, not the live or latest one; undelete_version restores it. Without confirm: true, only previews.",
			input: versionInput.extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ containerVersionId, confirm, ...ids }, { gtm }) => {
			const path = versionPath({ ...ids, versionId: containerVersionId });
			const parent = containerPath(ids);
			const [live, latest] = await Promise.all([liveVersion(gtm, parent), versionHeaders.latest(gtm, { parent })]);
			if (live?.containerVersionId === containerVersionId) {
				return fail(
					`Version ${containerVersionId} is the live version, so it can't be deleted. Publish another version first.`,
				);
			}
			// Q34: GTM refuses (bare 400) to delete the latest version.
			if (latest.containerVersionId === containerVersionId) {
				return fail(
					`Version ${containerVersionId} is the latest version, and GTM refuses to delete the latest one. Save a newer version first (create_version, or set_latest_version on another version, which saves a copy of it as a new latest version), then retry.`,
				);
			}
			return confirmGate({
				confirm,
				preview: async () => {
					const v = await versions.get(gtm, { path });
					if (v.deleted) return fail(`Version ${containerVersionId} is already deleted.`);
					return okPreview(
						{ wouldDelete: { kind: "version", ...versionHeadline(v) } },
						`Nothing was deleted. ${BASE_VERSION_NOTE} Get the user's go-ahead, then call delete_version again with confirm: true. undelete_version can restore it.`,
					);
				},
				apply: async () => {
					try {
						await versions.delete(gtm, { path });
					} catch (error) {
						// Q34: the other bare 400 seen live: a workspace is still based on this version.
						if (error instanceof GtmApiError && error.kind === "invalid") {
							throw new GtmInputError(
								`Nothing was deleted: GTM refused to delete version ${containerVersionId}. ${BASE_VERSION_NOTE} Sync those workspaces (sync_workspace) to the latest version, then retry.`,
							);
						}
						throw error;
					}
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
					// Q30: Google hides a deleted version from versions.get (404), so read its header
					// from the list that includes deleted versions.
					const parent = containerPath(ids);
					const list = await gtm.listAll(
						(pageToken) => versionHeaders.list(gtm, { parent, pageToken, includeDeleted: true }),
						(page) => page.containerVersionHeader,
					);
					const header = list.items.find((h) => h.containerVersionId === containerVersionId);
					if (!header) {
						return fail(
							`Container ${ids.containerId} has no version ${containerVersionId}, deleted or not${list.truncated ? " among the versions read (the list was too long to read in full)" : ""}. Check the ID with list_versions (includeDeleted: true).`,
						);
					}
					if (!header.deleted) {
						return fail(`Version ${containerVersionId} is not deleted, so there is nothing to restore.`);
					}
					return okPreview(
						{ wouldRestore: compact(versionRow(header)) },
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
				"Make a saved version the latest: GTM saves a copy of it as a new version, which new workspaces and syncs start from. Does not publish. Without confirm: true, only previews.",
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
						"Nothing was changed. GTM would save a copy of this version as a new version (named like Restored_<id>), and new workspaces and workspace syncs would start from that copy; the live site would not change. Get the user's go-ahead, then call set_latest_version again with confirm: true.",
					);
				},
				apply: async () => {
					// Q37: Google doesn't re-point "latest"; it saves a copy as a new version and returns it.
					const v = await versions.setLatest(gtm, { path });
					const copy = v.containerVersionId !== undefined && v.containerVersionId !== containerVersionId;
					return ok({
						latest: versionHeadline(v),
						note: copy
							? `GTM saved a copy of version ${containerVersionId} as new version ${v.containerVersionId}${v.name ? ` "${v.name}"` : ""}, which is now the latest: new workspaces and syncs start from it. Version ${containerVersionId} itself is unchanged. ${NOT_LIVE_NOTE}`
							: `New workspaces and syncs now start from version ${containerVersionId}. ${NOT_LIVE_NOTE}`,
					});
				},
			});
		},
	);
};
