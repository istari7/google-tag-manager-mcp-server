import { z } from "zod";
import { DEFAULT_MAX_PAGES, type GtmClient } from "../gtm/client";
import { GtmApiError } from "../gtm/errors";
import { type Account, accounts, type Container } from "../gtm/generated";
import { updateAccount } from "../gtm/merge";
import { accountPath, containerPath, isGtmId, isPublicContainerId } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok, okEntity, okList } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { accountInput, confirmInput, containerInput, fingerprintInput, NO_INPUT } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

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

/** Account settings are not versioned: an update applies at once, with no workspace or publish step. */
export const ACCOUNT_SETTINGS_NOTE =
	"Account settings take effect immediately; they are not part of any workspace or version.";

function accountSummary(a: Account) {
	return {
		accountId: a.accountId,
		name: a.name,
		shareData: a.shareData,
		features: a.features,
		fingerprint: a.fingerprint,
	};
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
		"get_account",
		{
			description:
				"Get a GTM account's settings: name, data sharing and features, plus its fingerprint for update_account.",
			input: accountInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(accountSummary(await accounts.get(gtm, { path: accountPath(ids) }))),
	);

	tools.add(
		"update_account",
		{
			description: "Rename a GTM account or change its data-sharing setting. Takes effect immediately (not versioned).",
			input: accountInput.extend({
				name: z.string().trim().min(1).max(256).optional().describe("New account name"),
				shareData: z.boolean().optional().describe("Share data anonymously with Google (benchmarking)"),
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ name, shareData, fingerprint, ...ids }, { gtm }) => {
			if (isEmptyPatch({ name, shareData })) return fail("Nothing to change: pass name and/or shareData.");
			const { result } = await updateAccount(
				gtm,
				accountPath(ids),
				{ name, shareData },
				{ expectedFingerprint: fingerprint },
			);
			return okWrite({ account: accountSummary(result) }, { note: ACCOUNT_SETTINGS_NOTE });
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
			return confirmGate({
				confirm,
				preview: () =>
					okPreview(
						{ wouldDelete: { kind: "container", ...containerSummary(container) } },
						`Nothing was deleted. Deleting a container removes its workspaces and versions, and sites that load ${expected ?? "it"} stop getting its tags. Get the user's explicit go-ahead, then call delete_container again with confirm: true and publicId: "${expected ?? ""}".`,
					),
				apply: async () => {
					// The public ID typed back (CLAUDE.md): proof the user means this container.
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
			});
		},
	);
};
