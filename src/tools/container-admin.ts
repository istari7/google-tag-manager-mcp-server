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

/**
 * A Tag Manager container (public ID GTM-…), as opposed to a Google tag container (G-…, GT-…,
 * AW-…). combine_containers and move_tag_id work only on the latter (Q35).
 */
function isGtmContainer(c: Container): boolean {
	return c.publicId?.toUpperCase().startsWith("GTM-") === true;
}

function notForGtmContainers(tool: string, c: Container): string {
	return `Nothing was changed: ${tool} works only on Google tag containers (the ones a Google tag such as G-… or AW-… creates), and container ${c.containerId} is a Tag Manager container (GTM-…). GTM refuses it there. To move tags between GTM containers, export and import them in the GTM UI (Admin > Export / Import Container).`;
}

/** A setting as GTM reports it: an absent list or string is the same as an empty one. */
function settingValue(value: string | string[] | undefined, list: boolean): string {
	return JSON.stringify(value ?? (list ? [] : ""));
}

/**
 * Q39: GTM answers 200 to a containers.update that sets domainName on a web container but does
 * not store it. Warn about every field the caller set that the response doesn't carry back, so
 * the model doesn't report a change that didn't happen.
 */
function notStored(
	patch: Pick<Container, "name" | "domainName" | "notes" | "taggingServerUrls">,
	result: Container,
): string[] {
	const fields = ["name", "domainName", "notes", "taggingServerUrls"] as const;
	const isList = (f: (typeof fields)[number]) => f === "domainName" || f === "taggingServerUrls";
	return fields
		.filter((f) => patch[f] !== undefined && settingValue(patch[f], isList(f)) !== settingValue(result[f], isList(f)))
		.map((f) => {
			const hint = f === "domainName" ? " GTM drops domainName on web containers (Q39)." : "";
			return `GTM accepted the update but did not store ${f}: it now has ${settingValue(result[f], isList(f))}, not ${settingValue(patch[f], isList(f))}.${hint}`;
		});
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
			return okWrite(
				{ container: containerDetail(result) },
				{ warnings: notStored(patch, result), note: CONTAINER_SETTINGS_NOTE },
			);
		},
	);

	tools.add(
		"combine_containers",
		{
			description:
				"Google tag containers only (not GTM-…): merge another container of this account into this one; its tag IDs move here. Hard to undo. Without confirm: true, only previews.",
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
			const [target, source] = await Promise.all([
				containers.get(gtm, { path }),
				containers.get(gtm, { path: containerPath({ ...ids, containerId: sourceContainerId }) }),
			]);
			// Q35: on a GTM container Google fails with HTTP 500 and changes nothing.
			if (isGtmContainer(target)) return fail(notForGtmContainers("combine_containers", target));
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{ into: containerHeadline(target), wouldMerge: containerHeadline(source), keepSettingsOf: settingSource },
						"Nothing was combined. Sites that load the merged container's tag IDs would get this container's tags. Get the user's explicit go-ahead, then call combine_containers again with confirm: true.",
					),
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
				"Google tag containers only (not GTM-…): move a tag ID out of this container into a new one. Without confirm: true, only previews; confirming also needs acceptTerms: true.",
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
			const c = await containers.get(gtm, { path });
			// Q35: Google refuses with "For Google tag only, this operation is not supported by GTM container."
			if (isGtmContainer(c)) return fail(notForGtmContainers("move_tag_id", c));
			return confirmGate({
				confirm,
				preview: () => {
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
					const created = await containers.moveTagId(gtm, {
						path,
						tagId,
						tagName,
						copySettings: copySettings === true,
						copyTermsOfService: true,
						copyUsers: false,
					});
					return ok({
						moved: tagId,
						container: containerHeadline(created),
						note: "The tag ID moved immediately. Check the new container with list_containers.",
					});
				},
			});
		},
	);
};
