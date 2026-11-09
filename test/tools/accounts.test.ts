// list_accounts, list_containers, lookup_container, get_container_snippet, delete_container.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../../src/gtm/generated";
import { LOOKUP_MAX_CALLS } from "../../src/tools/accounts";
import { errors } from "../fixtures/gtm";
import {
	ACCOUNT,
	ACCOUNT_ID,
	byMethod,
	CONTAINER,
	CONTAINER_ARGS,
	CONTAINER_ID,
	callTool,
	describeCall,
	empty,
	FAKE_GOOGLE_TOKEN,
	mockGtm,
	pages,
	reply,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const container: Container = {
	accountId: ACCOUNT_ID,
	containerId: CONTAINER_ID,
	name: "example.com",
	publicId: "GTM-ABC1234",
	usageContext: ["web"],
	domainName: [],
	tagIds: ["GTM-ABC1234"],
	fingerprint: "1731100000000",
	path: CONTAINER,
	features: { supportTags: true, supportZones: false },
	tagManagerUrl: "https://tagmanager.google.com/#/container/accounts/1234567890/containers/201",
};

describe("list_accounts", () => {
	it("GETs accounts and returns id + name rows", async () => {
		const mock = mockGtm({
			accounts: reply({
				account: [
					{
						accountId: ACCOUNT_ID,
						name: "Example",
						path: ACCOUNT,
						fingerprint: "1",
						tagManagerUrl: "https://tagmanager.google.com/#/admin/accounts/1234567890",
						features: { supportUserPermissions: true },
					},
				],
			}),
		});
		const result = await callTool("list_accounts");
		expect(result.json()).toEqual({ accounts: [{ accountId: ACCOUNT_ID, name: "Example" }] });
		expect(describeCall(mock.gtm()[0])).toEqual({
			method: "GET",
			path: "accounts",
			query: {},
			auth: `Bearer ${FAKE_GOOGLE_TOKEN}`,
		});
	});

	it("reads every page", async () => {
		const mock = mockGtm({
			accounts: pages("account", [[{ accountId: "1", name: "A" }], [{ accountId: "2", name: "B" }]]),
		});
		const result = await callTool("list_accounts");
		expect(result.json()).toEqual({
			accounts: [
				{ accountId: "1", name: "A" },
				{ accountId: "2", name: "B" },
			],
		});
		expect(mock.gtm().map((c) => describeCall(c).query)).toEqual([{}, { pageToken: "p2" }]);
	});

	it("says so when the user has no accounts", async () => {
		mockGtm({ accounts: reply({}) });
		expect((await callTool("list_accounts")).text).toBe("No GTM accounts found for this Google user.");
	});
});

describe("list_containers", () => {
	it("GETs the account's containers and returns summary rows", async () => {
		const mock = mockGtm({ [`${ACCOUNT}/containers`]: reply({ container: [container] }) });
		const result = await callTool("list_containers", { accountId: ACCOUNT_ID });
		expect(result.json()).toEqual({
			containers: [{ containerId: CONTAINER_ID, name: "example.com", publicId: "GTM-ABC1234", usageContext: ["web"] }],
		});
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${ACCOUNT}/containers`, query: {} });
	});

	it("maps a 403 to a permission message naming the resource", async () => {
		mockGtm({ [`${ACCOUNT}/containers`]: reply(errors.forbidden403, 403) });
		const result = await callTool("list_containers", { accountId: ACCOUNT_ID });
		expect(result).toMatchObject({
			isError: true,
			text: `No permission for ${ACCOUNT}/containers. Check the Google account has access.`,
		});
	});
});

describe("lookup_container", () => {
	it("uses containers:lookup with the public ID, normalised to upper case", async () => {
		const mock = mockGtm({ "accounts/containers:lookup": reply(container) });
		const result = await callTool("lookup_container", { publicId: " gtm-abc1234 " });
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "GET",
			path: "accounts/containers:lookup",
			query: { tagId: "GTM-ABC1234" },
		});
		// Account and container IDs for the next calls; no features, fingerprint, UI link or empty lists.
		expect(result.json()).toEqual({
			accountId: ACCOUNT_ID,
			containerId: CONTAINER_ID,
			name: "example.com",
			publicId: "GTM-ABC1234",
			usageContext: ["web"],
			tagIds: ["GTM-ABC1234"],
		});
	});

	it("falls back to scanning every account's containers when lookup gives 404", async () => {
		const mock = mockGtm({
			"accounts/containers:lookup": reply(errors.notFound404, 404),
			accounts: reply({ account: [{ accountId: "1" }, { accountId: ACCOUNT_ID }] }),
			"accounts/1/containers": reply({ container: [{ containerId: "9", publicId: "GTM-OTHER1" }] }),
			[`${ACCOUNT}/containers`]: pages("container", [[], [container]]),
		});
		const result = await callTool("lookup_container", { publicId: "GTM-ABC1234" });
		expect(result.json()).toMatchObject({ accountId: ACCOUNT_ID, containerId: CONTAINER_ID });
		expect(mock.gtm().map((c) => describeCall(c).path)).toEqual([
			"accounts/containers:lookup",
			"accounts",
			"accounts/1/containers",
			`${ACCOUNT}/containers`,
			`${ACCOUNT}/containers`,
		]);
	});

	it("says when no accessible container has that ID", async () => {
		mockGtm({
			"accounts/containers:lookup": reply(errors.notFound404, 404),
			accounts: reply({ account: [{ accountId: "1" }] }),
			"accounts/1/containers": reply({}),
		});
		const result = await callTool("lookup_container", { publicId: "GTM-NOPE123" });
		expect(result).toMatchObject({
			isError: false,
			text: "No container with public ID GTM-NOPE123 in the accounts this user can access.",
		});
	});

	it(`caps the fallback at ${LOOKUP_MAX_CALLS} GTM calls in all and says how to search instead`, async () => {
		// 40 accounts with one empty container page each would be 1 + 1 + 40 = 42 calls uncapped.
		const many = Array.from({ length: 40 }, (_, i) => ({ accountId: String(100 + i) }));
		const routes: Record<string, ReturnType<typeof reply>> = {
			"accounts/containers:lookup": reply(errors.notFound404, 404),
			accounts: reply({ account: many }),
		};
		for (const a of many) routes[`accounts/${a.accountId}/containers`] = reply({ container: [] });
		const mock = mockGtm(routes);
		const result = await callTool("lookup_container", { publicId: "GTM-NOPE123" });
		expect(mock.gtm()).toHaveLength(LOOKUP_MAX_CALLS);
		expect(result.isError).toBe(false);
		expect(result.text).toContain("GTM-NOPE123");
		expect(result.text).toContain("list_accounts");
		expect(result.text).toContain("list_containers");
		expect(result.text).toContain("accountId");
	});

	it("counts every page of a long container list against the cap", async () => {
		// lookup + accounts + 10 + 10 pages = 22, so account 3 gets only 3 of its 10 pages and
		// account 4 (which has the container) is never listed.
		const tenPages = pages(
			"container",
			Array.from({ length: 10 }, () => [{ containerId: "9", publicId: "GTM-OTHER1" }]),
		);
		const mock = mockGtm({
			"accounts/containers:lookup": reply(errors.notFound404, 404),
			accounts: reply({ account: ["1", "2", "3", "4"].map((accountId) => ({ accountId })) }),
			"accounts/1/containers": tenPages,
			"accounts/2/containers": tenPages,
			"accounts/3/containers": tenPages,
			"accounts/4/containers": reply({ container: [container] }),
		});
		const result = await callTool("lookup_container", { publicId: "GTM-ABC1234" });
		expect(mock.gtm()).toHaveLength(LOOKUP_MAX_CALLS);
		expect(mock.gtm().filter((c) => describeCall(c).path === "accounts/3/containers")).toHaveLength(3);
		expect(result.text).toContain("list_containers");
	});

	it("does not fall back on a permission error", async () => {
		const mock = mockGtm({ "accounts/containers:lookup": reply(errors.forbidden403, 403) });
		const result = await callTool("lookup_container", { publicId: "GTM-ABC1234" });
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(1);
	});

	it("rejects something that is not a public ID", async () => {
		const mock = mockGtm();
		const result = await callTool("lookup_container", { publicId: "201" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain('publicId must look like "GTM-ABC1234"');
		expect(mock.calls).toHaveLength(0);
	});
});

describe("get_container_snippet", () => {
	it("GETs {container}:snippet", async () => {
		const mock = mockGtm({
			[`${CONTAINER}:snippet`]: reply({ snippet: "<script>…GTM-ABC1234…</script>", containerConfig: "" }),
		});
		const result = await callTool("get_container_snippet", CONTAINER_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${CONTAINER}:snippet`, query: {} });
		expect(result.json()).toEqual({ snippet: "<script>…GTM-ABC1234…</script>", containerConfig: "" });
	});

	it("maps a 404 to a not-found message", async () => {
		mockGtm({ [`${CONTAINER}:snippet`]: reply(errors.notFound404, 404) });
		const result = await callTool("get_container_snippet", CONTAINER_ARGS);
		expect(result).toMatchObject({
			isError: true,
			text: `Not found: ${CONTAINER}:snippet. Check the account/container/workspace IDs.`,
		});
	});
});

describe("delete_container", () => {
	it.each([{}, { confirm: false }, { publicId: "GTM-ABC1234" }])(
		"without confirm: true (%o) only GETs and previews",
		async (extra) => {
			const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
			const result = await callTool("delete_container", { ...CONTAINER_ARGS, ...extra });
			expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONTAINER }]);
			const out = result.json<{ preview: boolean; wouldDelete: Record<string, unknown>; message: string }>();
			expect(out.preview).toBe(true);
			expect(out.wouldDelete).toMatchObject({ kind: "container", containerId: CONTAINER_ID, publicId: "GTM-ABC1234" });
			expect(out.message).toContain('confirm: true and publicId: "GTM-ABC1234"');
		},
	);

	it.each([undefined, "GTM-WRONG99", ""])("with confirm: true but publicId %o deletes nothing", async (publicId) => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		const result = await callTool("delete_container", { ...CONTAINER_ARGS, confirm: true, publicId });
		expect(result).toMatchObject({
			isError: true,
			text: `Nothing was deleted: publicId must be "GTM-ABC1234", the public ID of container ${CONTAINER_ID}.`,
		});
		expect(mock.gtm().filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it("with confirm: true and the matching publicId (any case) GETs, then sends one DELETE", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container), DELETE: empty }) });
		const result = await callTool("delete_container", { ...CONTAINER_ARGS, confirm: true, publicId: " gtm-abc1234 " });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: CONTAINER },
			{ method: "DELETE", path: CONTAINER, query: {}, body: undefined },
		]);
		expect(result.json()).toEqual({
			deleted: { kind: "container", containerId: CONTAINER_ID, publicId: "GTM-ABC1234" },
			note: "The container is deleted. Remove its snippet from the sites that loaded it.",
		});
	});
});
