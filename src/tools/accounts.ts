import { z } from "zod";
import { DEFAULT_MAX_PAGES, type GtmClient } from "../gtm/client";
import { GtmApiError } from "../gtm/errors";
import { accounts, type Container } from "../gtm/generated";
import { accountPath, containerPath, isGtmId, isPublicContainerId } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok, okEntity, okList } from "../mcp/result";
import { accountInput, confirmInput, containerInput, NO_INPUT } from "./inputs";

const lookupInput = z.object({
	publicId: z
		.string()
		.transform((s) => s.trim().toUpperCase())
		.refine(isPublicContainerId, { message: 'publicId must look like "GTM-ABC1234"' })
		.describe('Public container ID, e.g. "GTM-ABC1234"'),
});

function listAccounts(gtm: GtmClient) {
	return gtm.listAll(
		(pageToken) => accounts.list(gtm, { pageToken }),
		(page) => page.account,
	);
}

function listContainers(gtm: GtmClient, accountId: string) {
	const parent = accountPath({ accountId });
	return gtm.listAll(
		(pageToken) => accounts.containers.list(gtm, { parent, pageToken }),
		(page) => page.container,
	);
}

/** What a model needs to know about a container; drops `features`, fingerprint and UI links. */
function containerSummary(c: Container) {
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
	};
}

/**
 * Most GTM calls lookup_container makes, the containers:lookup call included. The fallback
 * scan lists every account's containers, which would otherwise grow with the number of
 * accounts and pages and could hit the Workers subrequest cap (50 per request on Free).
 */
export const LOOKUP_MAX_CALLS = 25;

/**
 * Google's containers:lookup finds the container across every account the user can see.
 * If Google can't (404/400), fall back to scanning each account's containers.
 */
async function lookupContainer(gtm: GtmClient, publicId: string): Promise<Container | "incomplete" | undefined> {
	try {
		return await accounts.containers.lookup(gtm, { tagId: publicId });
	} catch (error) {
		if (!(error instanceof GtmApiError) || (error.kind !== "notFound" && error.kind !== "invalid")) throw error;
	}
	// Every page of every list counts against the budget (Q18: listAll pages are separate calls).
	let left = LOOKUP_MAX_CALLS - 1;
	const pagesAllowed = () => ({ maxPages: Math.min(DEFAULT_MAX_PAGES, left) });
	const all = await gtm.listAll(
		(pageToken) => accounts.list(gtm, { pageToken }),
		(page) => page.account,
		pagesAllowed(),
	);
	left -= all.pages;
	let incomplete = all.truncated;
	for (const account of all.items) {
		if (!isGtmId(account.accountId)) continue;
		if (left <= 0) return "incomplete";
		const parent = accountPath({ accountId: account.accountId });
		const containers = await gtm.listAll(
			(pageToken) => accounts.containers.list(gtm, { parent, pageToken }),
			(page) => page.container,
			pagesAllowed(),
		);
		left -= containers.pages;
		const hit = containers.items.find((c) => c.publicId?.toUpperCase() === publicId);
		if (hit) return hit;
		if (containers.truncated) incomplete = true;
	}
	return incomplete ? "incomplete" : undefined;
}

export const accountTools: ToolGroup = (tools) => {
	tools.add(
		"list_accounts",
		{
			description: "List the Google Tag Manager accounts the connected user can access.",
			input: NO_INPUT,
			annotations: { readOnlyHint: true },
		},
		async (_args, { gtm }) => {
			const list = await listAccounts(gtm);
			if (list.items.length === 0) return ok("No GTM accounts found for this Google user.");
			return okList("accounts", list, (a) => ({ accountId: a.accountId, name: a.name }));
		},
	);

	tools.add(
		"list_containers",
		{
			description: "List the containers in a GTM account, with their public IDs (GTM-XXXX) and usage context.",
			input: accountInput,
			annotations: { readOnlyHint: true },
		},
		async ({ accountId }, { gtm }) =>
			okList("containers", await listContainers(gtm, accountId), (c) => ({
				containerId: c.containerId,
				name: c.name,
				publicId: c.publicId,
				usageContext: c.usageContext,
			})),
	);

	tools.add(
		"lookup_container",
		{
			description:
				"Find a container by its public ID (GTM-XXXX) across all accounts, returning its account and container IDs.",
			input: lookupInput,
			annotations: { readOnlyHint: true },
		},
		async ({ publicId }, { gtm }) => {
			const container = await lookupContainer(gtm, publicId);
			if (!container) return ok(`No container with public ID ${publicId} in the accounts this user can access.`);
			if (container === "incomplete") {
				return ok(
					`${publicId} was not found by Google's lookup, and the scan of every account stopped at its limit of ${LOOKUP_MAX_CALLS} API calls before checking them all. Use list_accounts, then list_containers with a specific accountId to find it.`,
				);
			}
			return okEntity(containerSummary(container));
		},
	);

	tools.add(
		"get_container_snippet",
		{
			description: "Get the install snippet of a web container, or the provisioning config of a server container.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(await accounts.containers.snippet(gtm, { path: containerPath(ids) })),
	);

	tools.add(
		"delete_container",
		{
			description:
				"Permanently delete a container. Without confirm: true, only previews. Needs the user's explicit go-ahead and the container's public ID (GTM-XXXX).",
			input: containerInput.extend({
				publicId: z.string().optional().describe("The container's public ID (GTM-XXXX); required with confirm: true"),
				confirm: confirmInput("delete the container"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ publicId, confirm, ...ids }, { gtm }) => {
			const path = containerPath(ids);
			const container = await accounts.containers.get(gtm, { path });
			const expected = container.publicId;
			if (confirm !== true) {
				return ok({
					preview: true,
					wouldDelete: { kind: "container", ...containerSummary(container) },
					message: `Nothing was deleted. Deleting a container removes its workspaces and versions, and sites that load ${expected ?? "it"} stop getting its tags. Get the user's explicit go-ahead, then call delete_container again with confirm: true and publicId: "${expected ?? ""}".`,
				});
			}
			if (!expected || publicId?.trim().toUpperCase() !== expected.toUpperCase()) {
				return fail(
					`Nothing was deleted: publicId must be "${expected ?? "?"}", the public ID of container ${ids.containerId}.`,
				);
			}
			await accounts.containers.delete(gtm, { path });
			return ok({
				deleted: { kind: "container", containerId: ids.containerId, publicId: expected },
				note: "The container is deleted. Remove its snippet from the sites that loaded it.",
			});
		},
	);
};
