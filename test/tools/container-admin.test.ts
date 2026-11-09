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

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("update_container", CONTAINER_ARGS)).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("combine_containers", () => {
	const OTHER = `${ACCOUNT}/containers/202`;
	const ARGS = { ...CONTAINER_ARGS, sourceContainerId: "202", settingSource: "current" };

	it.each([{}, { confirm: false }])("without confirm: true (%o) reads both containers and previews", async (extra) => {
		const mock = mockGtm({
			[CONTAINER]: reply(container),
			[OTHER]: reply({ containerId: "202", name: "Old site", publicId: "GTM-OLD1234", tagIds: ["GTM-OLD1234"] }),
		});
		const result = await callTool("combine_containers", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			into: { containerId: "201", publicId: "GTM-ABC1234" },
			wouldMerge: { containerId: "202", publicId: "GTM-OLD1234" },
			keepSettingsOf: "current",
		});
	});

	it("with confirm: true POSTs {container}:combine with containerId and settingSource only", async () => {
		const mock = mockGtm({ [`${CONTAINER}:combine`]: byMethod({ POST: reply(container) }) });
		const result = await callTool("combine_containers", { ...ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{
				method: "POST",
				path: `${CONTAINER}:combine`,
				query: { containerId: "202", settingSource: "current" },
				body: undefined,
			},
		]);
		expect(result.json()).toMatchObject({ combined: { containerId: "201" } });
	});

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
		const mock = mockGtm({ [CONTAINER]: reply(container) });
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

	it("refuses a tag ID the container doesn't have", async () => {
		mockGtm({ [CONTAINER]: reply(container) });
		const result = await callTool("move_tag_id", { ...ARGS, tagId: "G-OTHER1" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("is not one of container 201's tag IDs");
	});

	it("with confirm: true but no acceptTerms, moves nothing", async () => {
		const mock = mockGtm();
		const result = await callTool("move_tag_id", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("acceptTerms must be true");
		expect(mock.calls).toHaveLength(0);
	});

	it("with confirm and acceptTerms POSTs {container}:move_tag_id, never copying users", async () => {
		const mock = mockGtm({ [`${CONTAINER}:move_tag_id`]: byMethod({ POST: reply(container) }) });
		await callTool("move_tag_id", { ...ARGS, copySettings: true, acceptTerms: true, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{
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
			},
		]);
		expect(describeCall(mock.gtm()[0]).query).not.toHaveProperty("allowUserPermissionFeatureUpdate");
	});

	it("refuses a malformed tag ID before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("move_tag_id", { ...ARGS, tagId: "G-1&x=y" })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});
