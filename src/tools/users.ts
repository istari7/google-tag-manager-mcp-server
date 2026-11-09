// User permissions (tagmanager.manage.users): who can access a GTM account and its containers.
// Changes apply immediately (they are not versioned), so the two write tools are confirm-gated:
// without `confirm: true` they show the access before and after, and change nothing.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { accounts, type ContainerAccess, type UserPermission } from "../gtm/generated";
import { accountPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, fail, ok, okList } from "../mcp/result";
import { accountInput, confirmInput, gtmId } from "./inputs";
import { okWrite } from "./write";

const userPermissions = accounts.userPermissions;

export const USER_ACCESS_NOTE =
	"Access changes take effect immediately; they are not part of any workspace or version.";

const ACCOUNT_PERMISSIONS = ["noAccess", "user", "admin"] as const satisfies readonly NonNullable<
	NonNullable<UserPermission["accountAccess"]>["permission"]
>[];
const CONTAINER_PERMISSIONS = [
	"noAccess",
	"read",
	"edit",
	"approve",
	"publish",
] as const satisfies readonly NonNullable<ContainerAccess["permission"]>[];

const emailInput = z.string().trim().toLowerCase().email().describe("The user's Google account email");

/** One row: the email, account role and per-container roles. */
export function permissionRow(p: UserPermission) {
	return compact({
		emailAddress: p.emailAddress,
		accountPermission: p.accountAccess?.permission,
		containerAccess: p.containerAccess?.map((c) => ({ containerId: c.containerId, permission: c.permission })),
	});
}

async function listPermissions(gtm: GtmClient, accountId: string) {
	const parent = accountPath({ accountId });
	return gtm.listAll(
		(pageToken) => userPermissions.list(gtm, { parent, pageToken }),
		(page) => page.userPermission,
	);
}

async function findPermission(gtm: GtmClient, accountId: string, email: string) {
	const { items } = await listPermissions(gtm, accountId);
	return items.find((p) => p.emailAddress?.toLowerCase() === email);
}

/** Given containers replace their stored entry; containers not given keep theirs. */
function mergeContainerAccess(
	current: readonly ContainerAccess[] | undefined,
	changes: readonly ContainerAccess[] | undefined,
): ContainerAccess[] {
	const byId = new Map((current ?? []).map((c) => [c.containerId, c]));
	for (const c of changes ?? []) byId.set(c.containerId, c);
	return [...byId.values()];
}

function selfWarning(email: string, signedIn: string): Record<string, string> {
	return email === signedIn.toLowerCase()
		? { warning: "This is the signed-in user's own access. Lowering or removing it can lock them out." }
		: {};
}

export const userTools: ToolGroup = (tools) => {
	tools.add(
		"list_user_permissions",
		{
			description: "List who can access a GTM account: each user's account role and per-container permissions.",
			input: accountInput,
			annotations: { readOnlyHint: true },
		},
		async ({ accountId }, { gtm }) => okList("users", await listPermissions(gtm, accountId), permissionRow),
	);

	tools.add(
		"set_user_permission",
		{
			description:
				"Add a user to a GTM account or change their access. Containers not listed keep their access. Without confirm: true, only previews.",
			input: accountInput.extend({
				emailAddress: emailInput,
				accountPermission: z
					.enum(ACCOUNT_PERMISSIONS)
					.optional()
					.describe('Account role; a new user defaults to "user"'),
				containerAccess: z
					.array(z.object({ containerId: gtmId("Container ID"), permission: z.enum(CONTAINER_PERMISSIONS) }))
					.optional()
					.describe("Per-container permission changes"),
				confirm: confirmInput("apply the change"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (
			{ accountId, emailAddress, accountPermission, containerAccess, confirm },
			{ gtm, props },
		): Promise<CallToolResult> => {
			if (accountPermission === undefined && containerAccess === undefined) {
				return fail("Nothing to change: pass accountPermission and/or containerAccess.");
			}
			const existing = await findPermission(gtm, accountId, emailAddress);
			const proposed: UserPermission = existing
				? {
						...existing,
						accountAccess: accountPermission ? { permission: accountPermission } : existing.accountAccess,
						containerAccess: mergeContainerAccess(existing.containerAccess, containerAccess),
					}
				: {
						accountId,
						emailAddress,
						accountAccess: { permission: accountPermission ?? "user" },
						containerAccess: containerAccess ?? [],
					};
			if (confirm !== true) {
				return ok({
					preview: true,
					action: existing ? "update" : "add",
					...(existing ? { before: permissionRow(existing) } : {}),
					after: permissionRow(proposed),
					...selfWarning(emailAddress, props.email),
					message: `Nothing was changed. Show the user this change to ${emailAddress}'s access, get their go-ahead, then call set_user_permission again with confirm: true.`,
				});
			}
			const saved =
				existing?.path !== undefined
					? await userPermissions.update(gtm, { path: existing.path }, proposed)
					: await userPermissions.create(gtm, { parent: accountPath({ accountId }) }, proposed);
			return okWrite(
				{ action: existing ? "updated" : "added", userPermission: permissionRow(saved ?? proposed) },
				{ note: USER_ACCESS_NOTE },
			);
		},
	);

	tools.add(
		"delete_user_permission",
		{
			description:
				"Remove a user's access to a GTM account and all its containers. Without confirm: true, only previews.",
			input: accountInput.extend({ emailAddress: emailInput, confirm: confirmInput("remove the user") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ accountId, emailAddress, confirm }, { gtm, props }): Promise<CallToolResult> => {
			const existing = await findPermission(gtm, accountId, emailAddress);
			if (!existing?.path)
				return fail(`${emailAddress} has no access to account ${accountId}, so there is nothing to remove.`);
			if (confirm !== true) {
				return ok({
					preview: true,
					wouldRemove: permissionRow(existing),
					...selfWarning(emailAddress, props.email),
					message: `Nothing was changed. To remove ${emailAddress}, get the user's go-ahead, then call delete_user_permission again with confirm: true.`,
				});
			}
			await userPermissions.delete(gtm, { path: existing.path });
			return okWrite({ removed: { emailAddress } }, { note: USER_ACCESS_NOTE });
		},
	);
};
