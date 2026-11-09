// Container administration: get_container, create_container, update_container,
// combine_containers, move_tag_id. Container settings are not versioned: changes apply at
// once. Combining containers and moving a tag ID change what sites load, so both are
// confirm-gated (./confirm.ts); move_tag_id also needs acceptTerms, as in Paolo's server.

import { z } from "zod";
import { accounts, type Container } from "../gtm/generated";
import { getMergePut } from "../gtm/merge";
import { accountPath, containerPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok, okEntity } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { accountInput, confirmInput, containerInput, fingerprintInput, gtmId, nameInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const containers = accounts.containers;

const CONTAINER_SETTINGS_NOTE =
	"Container settings take effect immediately; they are not part of any workspace or version.";

const USAGE_CONTEXTS = ["web", "android", "ios", "amp", "server"] as const satisfies readonly NonNullable<
	Container["usageContext"]
>[number][];

/** A Google tag ID in a container's tagIds, e.g. "GTM-ABC1234" or "G-ABC123". Query parameter only. */
const TAG_ID = /^[A-Z]{1,4}-[A-Z0-9]{3,20}$/;

/** Everything about a container except UI links; features and fingerprint included. */
function containerDetail(c: Container) {
	return {
		accountId: c.accountId,
		containerId: c.containerId,
		name: c.name,
		publicId: c.publicId,
		usageContext: c.usageContext,
		domainName: c.domainName,
		notes: c.notes,
		tagIds: c.tagIds,
		taggingServerUrls: c.taggingServerUrls,
		features: c.features,
		fingerprint: c.fingerprint,
	};
}

/** The short form for previews and results. */
function containerHeadline(c: Container) {
	return { containerId: c.containerId, name: c.name, publicId: c.publicId, tagIds: c.tagIds };
}

const settingsFields = {
	domainName: z.array(z.string()).optional(),
	notes: z.string().optional(),
	taggingServerUrls: z.array(z.string()).optional().describe("Server containers only"),
};

export const containerAdminTools: ToolGroup = (tools) => {
	tools.add(
		"get_container",
		{
			description:
				"Get a container's settings (name, public ID, type, domains, tag IDs, features) and its fingerprint for update_container.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(containerDetail(await containers.get(gtm, { path: containerPath(ids) }))),
	);

	tools.add(
		"create_container",
		{
			description: "Create a container in a GTM account. usageContext sets its type.",
			input: accountInput.extend({
				name: nameInput("Container"),
				usageContext: z.array(z.enum(USAGE_CONTEXTS)).min(1).describe('e.g. ["web"]'),
				...settingsFields,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ name, usageContext, domainName, notes, taggingServerUrls, ...ids }, { gtm }) => {
			const c = await containers.create(
				gtm,
				{ parent: accountPath(ids) },
				{ name, usageContext, domainName, notes, taggingServerUrls },
			);
			return okWrite(
				{ container: containerDetail(c) },
				{ note: "The container is created and empty. Install its snippet (get_container_snippet) on the site." },
			);
		},
	);

	tools.add(
		"update_container",
		{
			description:
				'Change a container\'s name, domains, notes or server URLs. Omitted fields are kept; [] or "" clears. Takes effect at once (not versioned).',
			input: containerInput.extend({
				name: z.string().trim().min(1).max(256).optional(),
				...settingsFields,
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ name, domainName, notes, taggingServerUrls, fingerprint, ...ids }, { gtm }) => {
			const patch = { name, domainName, notes, taggingServerUrls };
			if (isEmptyPatch(patch)) return fail("Nothing to change: pass name, domainName, notes or taggingServerUrls.");
			const path = containerPath(ids);
			// Q1/Q2/Q7: containers.update is a PUT; get-merge-put keeps every field the patch omits.
			const { result } = await getMergePut<Container, Partial<Container>>({
				path,
				patch,
				expectedFingerprint: fingerprint,
				get: () => containers.get(gtm, { path }),
				put: (body, fp) => containers.update(gtm, { path, fingerprint: fp }, body),
				normalize: (p) => ({ value: p, warnings: [] }),
			});
			return okWrite({ container: containerDetail(result) }, { note: CONTAINER_SETTINGS_NOTE });
		},
	);

	tools.add(
		"combine_containers",
		{
			description:
				"Merge another container of this account into this one; its tag IDs move here. Hard to undo. Without confirm: true, only previews.",
			input: containerInput.extend({
				sourceContainerId: gtmId("Container to merge in"),
				settingSource: z.enum(["current", "other"]).describe("Whose settings to keep"),
				confirm: confirmInput("combine"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ sourceContainerId, settingSource, confirm, ...ids }, { gtm }) => {
			if (sourceContainerId === ids.containerId) return fail("sourceContainerId must be a different container.");
			const path = containerPath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const [target, source] = await Promise.all([
						containers.get(gtm, { path }),
						containers.get(gtm, { path: containerPath({ ...ids, containerId: sourceContainerId }) }),
					]);
					return okPreview(
						{ into: containerHeadline(target), wouldMerge: containerHeadline(source), keepSettingsOf: settingSource },
						"Nothing was combined. Sites that load the merged container's tag IDs would get this container's tags. Get the user's explicit go-ahead, then call combine_containers again with confirm: true.",
					);
				},
				apply: async () => {
					// allowUserPermissionFeatureUpdate is never set: user permissions stay as they are.
					const c = await containers.combine(gtm, { path, containerId: sourceContainerId, settingSource });
					return ok({
						combined: containerHeadline(c),
						note: `Container ${sourceContainerId} was merged into ${ids.containerId}. This took effect immediately.`,
					});
				},
			});
		},
	);

	tools.add(
		"move_tag_id",
		{
			description:
				"Move a tag ID out of this container into a new one. Without confirm: true, only previews; confirming also needs acceptTerms: true.",
			input: containerInput.extend({
				tagId: z.string().trim().toUpperCase().regex(TAG_ID).describe("From get_container's tagIds"),
				tagName: nameInput("New container"),
				copySettings: z.boolean().optional(),
				acceptTerms: z.boolean().optional().describe("The user accepts the copied terms of service"),
				confirm: confirmInput("move it"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ tagId, tagName, copySettings, acceptTerms, confirm, ...ids }, { gtm }) => {
			const path = containerPath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const c = await containers.get(gtm, { path });
					if (!c.tagIds?.includes(tagId)) {
						return fail(
							`${tagId} is not one of container ${ids.containerId}'s tag IDs (${(c.tagIds ?? []).join(", ") || "none"}).`,
						);
					}
					return okPreview(
						{
							from: containerHeadline(c),
							wouldMove: tagId,
							newContainerName: tagName,
							copySettings: copySettings === true,
						},
						"Nothing was moved. Sites using this tag ID would stop getting this container's tags. Users are not copied. Get the user's explicit go-ahead and their acceptance of the copied terms of service, then call move_tag_id again with confirm: true and acceptTerms: true.",
					);
				},
				apply: async () => {
					if (acceptTerms !== true) {
						return fail("Nothing was moved: acceptTerms must be true (the user accepts the copied terms of service).");
					}
					const c = await containers.moveTagId(gtm, {
						path,
						tagId,
						tagName,
						copySettings: copySettings === true,
						copyTermsOfService: true,
						copyUsers: false,
					});
					return ok({
						moved: tagId,
						container: containerHeadline(c),
						note: "The tag ID moved immediately. Check the new container with list_containers.",
					});
				},
			});
		},
	);
};
