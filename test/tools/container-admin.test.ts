// The container-admin group: get_container, create_container, update_container, and the
// confirm-gated combine_containers and move_tag_id.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../../src/gtm/generated";
import {
	ACCOUNT,
	ACCOUNT_ID,
	byMethod,
	CONTAINER,
	CONTAINER_ARGS,
	callTool,
	describeCall,
	mockGtm,
	reply,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const container: Container = {
	accountId: ACCOUNT_ID,
	containerId: "201",
	name: "www.example.com",
	publicId: "GTM-ABC1234",
	usageContext: ["web"],
	domainName: ["example.com"],
	notes: "Main site",
	tagIds: ["GTM-ABC1234", "G-XYZ987"],
	features: { supportTags: true },
	fingerprint: "700",
	path: CONTAINER,
	tagManagerUrl: "https://x",
};

describe("get_container", () => {
	it("GETs the container and returns its settings, features and fingerprint", async () => {
		const mock = mockGtm({ [CONTAINER]: reply(container) });
		const result = await callTool("get_container", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONTAINER, query: {} }]);
		expect(result.json()).toEqual({
			accountId: ACCOUNT_ID,
			containerId: "201",
			name: "www.example.com",
			publicId: "GTM-ABC1234",
			usageContext: ["web"],
			domainName: ["example.com"],
			notes: "Main site",
			tagIds: ["GTM-ABC1234", "G-XYZ987"],
			features: { supportTags: true },
			fingerprint: "700",
		});
	});
});

describe("create_container", () => {
	it("POSTs {account}/containers with exactly the given fields", async () => {
		const mock = mockGtm({ [`${ACCOUNT}/containers`]: byMethod({ POST: reply(container) }) });
		const result = await callTool("create_container", {
			accountId: ACCOUNT_ID,
			name: "www.example.com",
			usageContext: ["web"],
			domainName: ["example.com"],
		});
		expect(mock.gtm().map(describeCall)).toEqual([
			expect.objectContaining({
				method: "POST",
				path: `${ACCOUNT}/containers`,
				query: {},
				body: { name: "www.example.com", usageContext: ["web"], domainName: ["example.com"] },
			}),
		]);
		expect(result.json()).toMatchObject({ container: { containerId: "201", publicId: "GTM-ABC1234" } });
	});

	it("refuses a missing or unknown usage context before calling Google", async () => {
		const mock = mockGtm();
		for (const usageContext of [undefined, [], ["desktop"]]) {
			const result = await callTool("create_container", { accountId: ACCOUNT_ID, name: "x", usageContext });
			expect(result.isError).toBe(true);
		}
		expect(mock.calls).toHaveLength(0);
	});
});

describe("update_container", () => {
	it("Q1/Q2: GETs, then PUTs the whole merged container with ?fingerprint=", async () => {
		const mock = mockGtm({
			[CONTAINER]: byMethod({ GET: reply(container), PUT: reply({ ...container, notes: "" }) }),
		});
		const result = await callTool("update_container", { ...CONTAINER_ARGS, notes: "", fingerprint: "700" });
		const calls = mock.gtm().map(describeCall);
		expect(calls).toMatchObject([
			{ method: "GET", path: CONTAINER },
			{ method: "PUT", path: CONTAINER, query: { fingerprint: "700" } },
		]);
		const { fingerprint: _fp, ...rest } = container;
		expect(calls[1]?.body).toEqual({ ...rest, notes: "" });
		expect(result.json<{ note: string }>().note).toContain("take effect immediately");
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm({ [CONTAINER]: byMethod({ GET: reply(container) }) });
		const result = await callTool("update_container", { ...CONTAINER_ARGS, name: "x", fingerprint: "1" });
		expect(result.isError).toBe(true);
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it.each([
		["omitted keeps the stored domains", {}, ["example.com"]],
		["[] clears them", { domainName: [] }, []],
		["a list replaces them", { domainName: ["a.example", "b.example"] }, ["a.example", "b.example"]],
	])("Q1/Q7 domainName: %s; the other settings are kept", async (_label, patch, sent) => {
		const mock = mockGtm({
			[CONTAINER]: byMethod({ GET: reply(container), PUT: reply({ ...container, name: "Renamed", domainName: sent }) }),
		});
		const result = await callTool("update_container", { ...CONTAINER_ARGS, name: "Renamed", ...patch });
		const { fingerprint: _fp, ...rest } = container;
		expect(mock.gtm().map(describeCall)[1]?.body).toEqual({ ...rest, name: "Renamed", domainName: sent });
		expect(result.json()).not.toHaveProperty("warnings");
	});

	it("Q39 warns when GTM answers 200 but drops the domainName it was sent", async () => {
		const stored = { ...container, domainName: undefined };
		mockGtm({
			[CONTAINER]: byMethod({ GET: reply(stored), PUT: reply({ ...stored, notes: "probe" }) }),
		});
		const result = await callTool("update_container", {
			...CONTAINER_ARGS,
			domainName: ["tmp.example.com"],
			notes: "probe",
		});
		expect(result.isError).toBeFalsy();
		expect(result.json<{ warnings: string[] }>().warnings).toEqual([
			'GTM accepted the update but did not store domainName: it now has [], not ["tmp.example.com"]. GTM drops domainName on web containers (Q39).',
		]);
	});

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("update_container", CONTAINER_ARGS)).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

/** Q35: combine_containers and move_tag_id work only on Google tag containers. */
const googleTag: Container = {
	...container,
	name: "GA4 tag",
	publicId: "GT-ABC1234",
	tagIds: ["GT-ABC1234", "G-XYZ987"],
};

describe("combine_containers", () => {
	const OTHER = `${ACCOUNT}/containers/202`;
	const ARGS = { ...CONTAINER_ARGS, sourceContainerId: "202", settingSource: "current" };
	const other = { containerId: "202", name: "Old tag", publicId: "GT-OLD1234", tagIds: ["G-OLD1234"] };

	it.each([{}, { confirm: false }])("without confirm: true (%o) reads both containers and previews", async (extra) => {
		const mock = mockGtm({ [CONTAINER]: reply(googleTag), [OTHER]: reply(other) });
		const result = await callTool("combine_containers", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			into: { containerId: "201", publicId: "GT-ABC1234" },
			wouldMerge: { containerId: "202", publicId: "GT-OLD1234" },
			keepSettingsOf: "current",
		});
	});

	it("with confirm: true reads both containers, then POSTs {container}:combine with containerId and settingSource only", async () => {
		const mock = mockGtm({
			[CONTAINER]: byMethod({ GET: reply(googleTag) }),
			[OTHER]: reply(other),
			[`${CONTAINER}:combine`]: byMethod({ POST: reply(googleTag) }),
		});
		const result = await callTool("combine_containers", { ...ARGS, confirm: true });
		expect(writes(mock.gtm()).map(describeCall)).toMatchObject([
			{
				method: "POST",
				path: `${CONTAINER}:combine`,
				query: { containerId: "202", settingSource: "current" },
				body: undefined,
			},
		]);
		expect(result.json()).toMatchObject({ combined: { containerId: "201" } });
	});

	it.each([{}, { confirm: true }])(
		"Q35 refuses a GTM-… container with a clear message, writing nothing (%o)",
		async (extra) => {
			const mock = mockGtm({ [CONTAINER]: reply(container), [OTHER]: reply(other) });
			const result = await callTool("combine_containers", { ...ARGS, ...extra });
			expect(result).toMatchObject({
				isError: true,
				text: expect.stringContaining("combine_containers works only on Google tag containers"),
			});
			expect(writes(mock.gtm())).toHaveLength(0);
		},
	);

	it("refuses combining a container with itself, and a bad settingSource, before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("combine_containers", { ...ARGS, sourceContainerId: "201", confirm: true })).isError).toBe(
			true,
		);
		expect((await callTool("combine_containers", { ...ARGS, settingSource: "both", confirm: true })).isError).toBe(
			true,
		);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("move_tag_id", () => {
	const ARGS = { ...CONTAINER_ARGS, tagId: "g-xyz987", tagName: "GA4 property" };

	it("without confirm: true checks the tag ID belongs to the container and previews", async () => {
		const mock = mockGtm({ [CONTAINER]: reply(googleTag) });
		const result = await callTool("move_tag_id", ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldMove: "G-XYZ987",
			newContainerName: "GA4 property",
			copySettings: false,
		});
		expect(result.json<{ message: string }>().message).toContain("acceptTerms: true");
	});

	it.each([{}, { confirm: true, acceptTerms: true }])(
		"Q35 refuses a GTM-… container before anything is moved (%o)",
		async (extra) => {
			const mock = mockGtm({ [CONTAINER]: reply(container) });
			const result = await callTool("move_tag_id", { ...ARGS, ...extra });
			expect(result).toMatchObject({
				isError: true,
				text: expect.stringContaining("move_tag_id works only on Google tag containers"),
			});
			expect(writes(mock.gtm())).toHaveLength(0);
		},
	);

	it("refuses a tag ID the container doesn't have", async () => {
		mockGtm({ [CONTAINER]: reply(googleTag) });
		const result = await callTool("move_tag_id", { ...ARGS, tagId: "G-OTHER1" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("is not one of container 201's tag IDs");
	});

	it("with confirm: true but no acceptTerms, moves nothing", async () => {
		const mock = mockGtm({ [CONTAINER]: reply(googleTag) });
		const result = await callTool("move_tag_id", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("acceptTerms must be true");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("with confirm and acceptTerms POSTs {container}:move_tag_id, never copying users", async () => {
		const mock = mockGtm({
			[CONTAINER]: byMethod({ GET: reply(googleTag) }),
			[`${CONTAINER}:move_tag_id`]: byMethod({ POST: reply(googleTag) }),
		});
		await callTool("move_tag_id", { ...ARGS, copySettings: true, acceptTerms: true, confirm: true });
		const [post] = writes(mock.gtm());
		expect(describeCall(post)).toMatchObject({
			method: "POST",
			path: `${CONTAINER}:move_tag_id`,
			query: {
				tagId: "G-XYZ987",
				tagName: "GA4 property",
				copySettings: "true",
				copyTermsOfService: "true",
				copyUsers: "false",
			},
			body: undefined,
		});
		expect(describeCall(post).query).not.toHaveProperty("allowUserPermissionFeatureUpdate");
	});

	it("refuses a malformed tag ID before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("move_tag_id", { ...ARGS, tagId: "G-1&x=y" })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});
