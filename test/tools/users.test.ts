// list_user_permissions, set_user_permission (add / update, confirm gating, container merge),
// delete_user_permission (confirm gating, self-warning).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserPermission } from "../../src/gtm/generated";
import { USER_ACCESS_NOTE } from "../../src/tools/users";
import { fakeProps } from "../helpers/props";
import { ACCOUNT, ACCOUNT_ID, byMethod, callTool, describeCall, empty, json, mockGtm, pages, writes } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const LIST = `${ACCOUNT}/user_permissions`;
const ANA_PATH = `${ACCOUNT}/user_permissions/501`;
const ana: UserPermission = {
	accountId: ACCOUNT_ID,
	emailAddress: "ana@example.com",
	path: ANA_PATH,
	accountAccess: { permission: "user" },
	containerAccess: [
		{ containerId: "201", permission: "read" },
		{ containerId: "202", permission: "edit" },
	],
};
const owner: UserPermission = {
	accountId: ACCOUNT_ID,
	emailAddress: fakeProps().email,
	path: `${ACCOUNT}/user_permissions/502`,
	accountAccess: { permission: "admin" },
};

describe("list_user_permissions", () => {
	it("GETs {account}/user_permissions across pages and summarises each user", async () => {
		const mock = mockGtm({ [LIST]: pages("userPermission", [[ana], [owner]]) });
		const result = await callTool("list_user_permissions", { accountId: ACCOUNT_ID });
		expect(mock.gtm().map((c) => describeCall(c).query)).toEqual([{}, { pageToken: "p2" }]);
		expect(result.json()).toEqual({
			users: [
				{
					emailAddress: "ana@example.com",
					accountPermission: "user",
					containerAccess: [
						{ containerId: "201", permission: "read" },
						{ containerId: "202", permission: "edit" },
					],
				},
				{ emailAddress: "owner@example.com", accountPermission: "admin" },
			],
		});
	});
});

describe("set_user_permission", () => {
	const listRoute = () => ({ [LIST]: byMethod({ GET: () => json({ userPermission: [ana, owner] }) }) });

	it("without confirm: true previews an update: given containers change, others are kept", async () => {
		const mock = mockGtm(listRoute());
		const result = await callTool("set_user_permission", {
			accountId: ACCOUNT_ID,
			emailAddress: " Ana@Example.com ",
			containerAccess: [{ containerId: "201", permission: "publish" }],
		});
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			action: "update",
			before: {
				emailAddress: "ana@example.com",
				accountPermission: "user",
				containerAccess: [
					{ containerId: "201", permission: "read" },
					{ containerId: "202", permission: "edit" },
				],
			},
			after: {
				emailAddress: "ana@example.com",
				accountPermission: "user",
				containerAccess: [
					{ containerId: "201", permission: "publish" },
					{ containerId: "202", permission: "edit" },
				],
			},
			message:
				"Nothing was changed. Show the user this change to ana@example.com's access, get their go-ahead, then call set_user_permission again with confirm: true.",
		});
	});

	it("with confirm: true PUTs the merged permission to the user's own path", async () => {
		const mock = mockGtm({
			...listRoute(),
			[ANA_PATH]: byMethod({ PUT: (call) => json(JSON.parse(call.body) as UserPermission) }),
		});
		const result = await callTool("set_user_permission", {
			accountId: ACCOUNT_ID,
			emailAddress: "ana@example.com",
			accountPermission: "admin",
			confirm: true,
		});
		const put = describeCall(writes(mock.gtm())[0]);
		expect(put).toMatchObject({ method: "PUT", path: ANA_PATH, query: {} });
		expect(put.body).toEqual({ ...ana, accountAccess: { permission: "admin" } });
		expect(result.json()).toMatchObject({
			action: "updated",
			userPermission: { emailAddress: "ana@example.com", accountPermission: "admin" },
			note: USER_ACCESS_NOTE,
		});
	});

	it("adds a new user with the default account role when confirmed", async () => {
		const mock = mockGtm({
			[LIST]: byMethod({
				GET: () => json({ userPermission: [owner] }),
				POST: (call) => json({ ...(JSON.parse(call.body) as UserPermission), path: `${ACCOUNT}/user_permissions/503` }),
			}),
		});
		const args = {
			accountId: ACCOUNT_ID,
			emailAddress: "new@example.com",
			containerAccess: [{ containerId: "201", permission: "read" }],
		};
		expect((await callTool("set_user_permission", args)).json()).toMatchObject({ preview: true, action: "add" });
		expect(writes(mock.gtm())).toHaveLength(0);

		const result = await callTool("set_user_permission", { ...args, confirm: true });
		expect(describeCall(writes(mock.gtm())[0])).toMatchObject({
			method: "POST",
			path: LIST,
			body: {
				accountId: ACCOUNT_ID,
				emailAddress: "new@example.com",
				accountAccess: { permission: "user" },
				containerAccess: [{ containerId: "201", permission: "read" }],
			},
		});
		expect(result.json()).toMatchObject({ action: "added" });
	});

	it("warns when the change is to the signed-in user's own access", async () => {
		mockGtm(listRoute());
		const out = (
			await callTool("set_user_permission", {
				accountId: ACCOUNT_ID,
				emailAddress: "owner@example.com",
				accountPermission: "user",
			})
		).json();
		expect(out.warning).toContain("signed-in user's own access");
	});

	it("refuses an empty change and a bad email without calling Google", async () => {
		const mock = mockGtm();
		const nothing = await callTool("set_user_permission", { accountId: ACCOUNT_ID, emailAddress: "ana@example.com" });
		expect(nothing).toMatchObject({
			isError: true,
			text: "Nothing to change: pass accountPermission and/or containerAccess.",
		});
		const bad = await callTool("set_user_permission", {
			accountId: ACCOUNT_ID,
			emailAddress: "not-an-email",
			accountPermission: "user",
		});
		expect(bad.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("delete_user_permission", () => {
	it("without confirm: true only lists and previews", async () => {
		const mock = mockGtm({ [LIST]: () => json({ userPermission: [ana, owner] }) });
		const result = await callTool("delete_user_permission", { accountId: ACCOUNT_ID, emailAddress: "ana@example.com" });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldRemove: { emailAddress: "ana@example.com", accountPermission: "user" },
		});
		expect(result.json().warning).toBeUndefined();
	});

	it("with confirm: true DELETEs the user's permission path", async () => {
		const mock = mockGtm({
			[LIST]: () => json({ userPermission: [ana] }),
			[ANA_PATH]: byMethod({ DELETE: empty }),
		});
		const result = await callTool("delete_user_permission", {
			accountId: ACCOUNT_ID,
			emailAddress: "ana@example.com",
			confirm: true,
		});
		expect(writes(mock.gtm()).map(describeCall)).toMatchObject([{ method: "DELETE", path: ANA_PATH, body: undefined }]);
		expect(result.json()).toEqual({ removed: { emailAddress: "ana@example.com" }, note: USER_ACCESS_NOTE });
	});

	it("fails for a user with no access, and warns before removing yourself", async () => {
		mockGtm({ [LIST]: () => json({ userPermission: [owner] }) });
		const missing = await callTool("delete_user_permission", {
			accountId: ACCOUNT_ID,
			emailAddress: "ana@example.com",
		});
		expect(missing).toMatchObject({
			isError: true,
			text: `ana@example.com has no access to account ${ACCOUNT_ID}, so there is nothing to remove.`,
		});
		const self = await callTool("delete_user_permission", { accountId: ACCOUNT_ID, emailAddress: "owner@example.com" });
		expect(self.json().warning).toContain("signed-in user's own access");
	});
});
