// list_accounts, get_account, update_account, list_containers, lookup_container,
// get_container_snippet, delete_container.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../src/gtm/errors";
import type { Container } from "../../src/gtm/generated";
import { ACCOUNT_SETTINGS_NOTE, LOOKUP_MAX_CALLS, maskPublicId } from "../../src/tools/accounts";
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
	json,
	mockGtm,
	modernToolCall,
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

	it("fails (isError) when no accessible container has that ID", async () => {
		mockGtm({
			"accounts/containers:lookup": reply(errors.notFound404, 404),
			accounts: reply({ account: [{ accountId: "1" }] }),
			"accounts/1/containers": reply({}),
		});
		const result = await callTool("lookup_container", { publicId: "GTM-NOPE123" });
		expect(result).toMatchObject({
			isError: true,
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
		expect(result.isError).toBe(true);
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
	it("GETs {container}:snippet and adds the <noscript> body part Google leaves out", async () => {
		const mock = mockGtm({
			[`${CONTAINER}:snippet`]: reply({ snippet: "<script>…GTM-ABC1234…</script>", containerConfig: "" }),
		});
		const result = await callTool("get_container_snippet", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: `${CONTAINER}:snippet`, query: {} }]);
		expect(result.json()).toEqual({
			snippet: "<script>…GTM-ABC1234…</script>",
			containerConfig: "",
			noscript:
				'<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC1234" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>',
			install: "Put snippet high in <head>, and noscript right after the opening <body> tag.",
		});
	});

	it("adds no <noscript> for a server container (no GTM- ID in the snippet)", async () => {
		mockGtm({ [`${CONTAINER}:snippet`]: reply({ containerConfig: "aWQ9R1RNLVNFUlZFUg" }) });
		const result = await callTool("get_container_snippet", CONTAINER_ARGS);
		expect(result.json()).toEqual({ containerConfig: "aWQ9R1RNLVNFUlZFUg" });
	});

	it("maps a 404 to a not-found message", async () => {
		mockGtm({ [`${CONTAINER}:snippet`]: reply(errors.notFound404, 404) });
		const result = await callTool("get_container_snippet", CONTAINER_ARGS);
		expect(result).toMatchObject({
			isError: true,
			text: `Not found: ${CONTAINER}:snippet. Check the container ID, then the account ID.`,
		});
	});
});

describe("delete_container", () => {
	it.each([{}, { confirm: false }, { publicId: "GTM-ABC1234" }])(
		"without confirm: true (%o) only GETs and previews, never spelling out the public ID",
		async (extra) => {
			const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
			const result = await callTool("delete_container", { ...CONTAINER_ARGS, ...extra });
			expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONTAINER }]);
			const out = result.json<{ preview: boolean; wouldDelete: Record<string, unknown>; message: string }>();
			expect(out.preview).toBe(true);
			expect(out.wouldDelete).toEqual({
				kind: "container",
				accountId: ACCOUNT_ID,
				containerId: CONTAINER_ID,
				name: "example.com",
				usageContext: ["web"],
				publicIdMasked: "GTM-*****34",
			});
			expect(out.message).toContain("ask them to type its public ID");
			// 2025-era clients can't be asked directly (stateless transport): say where the ID must come from.
			expect(out.message).toContain("must come from the user's own message");
			// CLAUDE.md: the user types the ID back, so the model must not get a copyable one.
			expect(result.text).not.toContain("GTM-ABC1234");
		},
	);

	it("masks the public ID where the container's name, notes or domains repeat it", async () => {
		const named: Container = {
			...container,
			name: "GTM-ABC1234 (main site)",
			notes: "Snippet gtm-abc1234 is on every page",
			domainName: ["gtm-abc1234.example.com"],
		};
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(named) }) });
		const result = await callTool("delete_container", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONTAINER }]);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: {
				name: "GTM-*****34 (main site)",
				notes: "Snippet GTM-*****34 is on every page",
				domainName: ["GTM-*****34.example.com"],
				publicIdMasked: "GTM-*****34",
			},
		});
		expect(result.text.toUpperCase()).not.toContain("GTM-ABC1234");
	});

	it.each([undefined, "GTM-WRONG99", ""])("with confirm: true but publicId %o deletes nothing", async (publicId) => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		const result = await callTool("delete_container", { ...CONTAINER_ARGS, confirm: true, publicId });
		expect(result).toMatchObject({
			isError: true,
			text: `Nothing was deleted: publicId does not match the public ID of container ${CONTAINER_ID}. Ask the user to type it.`,
		});
		expect(result.text).not.toContain("GTM-ABC1234");
		expect(mock.gtm().filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it.each([
		["GTM-ABC1234", "GTM-*****34"],
		["GTM-5GMJXB83", "GTM-******83"],
		[undefined, undefined],
	])("maskPublicId(%o) is %o", (id, masked) => {
		expect(maskPublicId(id)).toBe(masked);
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

describe("delete_container with elicitation (2026-07-28 clients)", () => {
	const ELICIT = { elicitation: { form: {} } };
	const text = (result: Record<string, unknown> | undefined) =>
		((result?.content as Array<{ text: string }> | undefined) ?? []).map((c) => c.text).join("");

	it("without confirm previews and says the client will ask, never spelling out the public ID", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		const { result, error } = await modernToolCall("delete_container", CONTAINER_ARGS, { capabilities: ELICIT });
		expect(error).toBeUndefined();
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONTAINER }]);
		const out = JSON.parse(text(result)) as { preview: boolean; message: string };
		expect(out.preview).toBe(true);
		expect(out.message).toContain("their MCP client will ask them to type the public ID");
		expect(text(result)).not.toContain("GTM-ABC1234");
	});

	it("confirmed, asks the user for the public ID (elicitation/create) and deletes nothing yet", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		// A publicId the model copied from list_containers doesn't count when the client can ask.
		const { result, error } = await modernToolCall(
			"delete_container",
			{ ...CONTAINER_ARGS, confirm: true, publicId: "GTM-ABC1234" },
			{ capabilities: ELICIT },
		);
		expect(error).toBeUndefined();
		expect(result).toMatchObject({
			resultType: "input_required",
			inputRequests: {
				publicId: {
					method: "elicitation/create",
					params: {
						mode: "form",
						message: expect.stringContaining('"example.com" (GTM-*****34)'),
						requestedSchema: { type: "object", properties: { publicId: { type: "string" } } },
					},
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("GTM-ABC1234");
		expect(mock.gtm().filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it("deletes when the user typed the matching public ID (any case)", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container), DELETE: empty }) });
		const { result } = await modernToolCall(
			"delete_container",
			{ ...CONTAINER_ARGS, confirm: true },
			{
				capabilities: ELICIT,
				inputResponses: { publicId: { action: "accept", content: { publicId: " gtm-abc1234 " } } },
			},
		);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: CONTAINER },
			{ method: "DELETE", path: CONTAINER },
		]);
		expect(JSON.parse(text(result))).toMatchObject({ deleted: { kind: "container", publicId: "GTM-ABC1234" } });
	});

	it.each([
		["a wrong ID", { action: "accept", content: { publicId: "GTM-WRONG99" } }, "does not match"],
		["a decline", { action: "decline" }, "the user cancelled"],
		["a cancel", { action: "cancel" }, "the user cancelled"],
		["a malformed answer", { action: "accept", content: { publicId: 42 } }, "does not match"],
	])("deletes nothing after %s, even with the right publicId argument", async (_what, answer, message) => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		const { result } = await modernToolCall(
			"delete_container",
			{ ...CONTAINER_ARGS, confirm: true, publicId: "GTM-ABC1234" },
			{ capabilities: ELICIT, inputResponses: { publicId: answer } },
		);
		expect(text(result)).toContain(message);
		expect(mock.gtm().filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it("without the elicitation capability falls back to the typed-back publicId", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container), DELETE: empty }) });
		const preview = await modernToolCall("delete_container", CONTAINER_ARGS, { capabilities: {} });
		expect(text(preview.result)).toContain("must come from the user's own message");
		const { result } = await modernToolCall(
			"delete_container",
			{ ...CONTAINER_ARGS, confirm: true, publicId: "GTM-ABC1234" },
			{ capabilities: {} },
		);
		expect(result?.resultType).not.toBe("input_required");
		expect(JSON.parse(text(result))).toMatchObject({ deleted: { kind: "container" } });
		expect(mock.gtm().filter((c) => c.method === "DELETE")).toHaveLength(1);
	});
});

describe("get_account / update_account", () => {
	const account = {
		accountId: ACCOUNT_ID,
		name: "Example Co",
		shareData: false,
		fingerprint: "100",
		path: ACCOUNT,
		tagManagerUrl: "https://x",
	};

	it("get_account GETs the account and returns its settings and fingerprint", async () => {
		const mock = mockGtm({ [ACCOUNT]: reply(account) });
		const result = await callTool("get_account", { accountId: ACCOUNT_ID });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: ACCOUNT }]);
		expect(result.json()).toEqual({ accountId: ACCOUNT_ID, name: "Example Co", shareData: false, fingerprint: "100" });
	});

	it("get_account shows shareData: false when Google omits it", async () => {
		const { shareData: _s, ...withoutShareData } = account;
		mockGtm({ [ACCOUNT]: reply(withoutShareData) });
		const result = await callTool("get_account", { accountId: ACCOUNT_ID });
		expect(result.json()).toMatchObject({ shareData: false });
	});

	it.each([{}, { confirm: false }])(
		"update_account without confirm: true (%o) only GETs and previews before/after",
		async (extra) => {
			const mock = mockGtm({ [ACCOUNT]: byMethod({ GET: () => json(account) }) });
			const result = await callTool("update_account", { accountId: ACCOUNT_ID, name: "New Co", ...extra });
			expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: ACCOUNT }]);
			const out = result.json<Record<string, unknown>>();
			expect(out).toMatchObject({
				preview: true,
				before: { name: "Example Co", shareData: false },
				after: { name: "New Co", shareData: false },
				fingerprint: "100",
			});
			expect(out.message).toContain("confirm: true");
		},
	);

	it("update_account preview refuses a change that changes nothing", async () => {
		mockGtm({ [ACCOUNT]: byMethod({ GET: () => json(account) }) });
		const result = await callTool("update_account", { accountId: ACCOUNT_ID, name: "Example Co", shareData: false });
		expect(result).toMatchObject({ isError: true, text: "Nothing to change: the account already has these settings." });
	});

	it("update_account with confirm: true GETs, then PUTs the merged account with ?fingerprint=", async () => {
		const mock = mockGtm({
			[ACCOUNT]: byMethod({
				GET: () => json(account),
				PUT: (call) => json({ ...(JSON.parse(call.body) as object), fingerprint: "101" }),
			}),
		});
		const result = await callTool("update_account", { accountId: ACCOUNT_ID, shareData: true, confirm: true });
		const [, put] = mock.gtm().map(describeCall);
		expect(put).toMatchObject({ method: "PUT", path: ACCOUNT, query: { fingerprint: "100" } });
		const { fingerprint: _f, ...stored } = account;
		expect(put?.body).toEqual({ ...stored, shareData: true });
		expect(result.json()).toEqual({
			account: { accountId: ACCOUNT_ID, name: "Example Co", shareData: true, fingerprint: "101" },
			note: ACCOUNT_SETTINGS_NOTE,
		});
	});

	it("update_account fails on a stale fingerprint without writing, and on an empty change", async () => {
		const mock = mockGtm({ [ACCOUNT]: byMethod({ GET: () => json(account) }) });
		for (const confirm of [undefined, true]) {
			const stale = await callTool("update_account", {
				accountId: ACCOUNT_ID,
				name: "New",
				fingerprint: "99",
				confirm,
			});
			expect(stale).toMatchObject({ isError: true, text: MESSAGES.conflict });
		}
		const nothing = await callTool("update_account", { accountId: ACCOUNT_ID });
		expect(nothing).toMatchObject({ isError: true, text: "Nothing to change: pass name and/or shareData." });
		expect(mock.gtm().filter((c) => c.method !== "GET")).toHaveLength(0);
	});
});
