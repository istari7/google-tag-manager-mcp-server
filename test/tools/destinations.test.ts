// list_destinations, get_destination, link_destination (confirm-gated; never sends
// allowUserPermissionFeatureUpdate).

import { afterEach, describe, expect, it, vi } from "vitest";
import { DESTINATION_NOTE } from "../../src/tools/destinations";
import { byMethod, CONTAINER, CONTAINER_ARGS, callTool, describeCall, json, mockGtm, writes } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const ga4 = {
	destinationLinkId: "3",
	destinationId: "G-ABC123",
	name: "Main site",
	fingerprint: "1",
	path: `${CONTAINER}/destinations/3`,
};
const container = { containerId: "201", name: "Site", publicId: "GTM-ABC1234" };

describe("list_destinations / get_destination", () => {
	it("list_destinations GETs {container}/destinations once (no pagination)", async () => {
		const mock = mockGtm({ [`${CONTAINER}/destinations`]: () => json({ destination: [ga4] }) });
		const result = await callTool("list_destinations", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: `${CONTAINER}/destinations`, query: {} },
		]);
		expect(result.json()).toEqual({
			destinations: [{ destinationLinkId: "3", destinationId: "G-ABC123", name: "Main site" }],
		});
	});

	it("list_destinations says truncated when Google returns a nextPageToken (the API takes no pageToken)", async () => {
		mockGtm({ [`${CONTAINER}/destinations`]: () => json({ destination: [ga4], nextPageToken: "abc" }) });
		const result = await callTool("list_destinations", CONTAINER_ARGS);
		expect(result.json()).toEqual({
			destinations: [{ destinationLinkId: "3", destinationId: "G-ABC123", name: "Main site" }],
			truncated: true,
			note: "Only the first page was read; there are more destinations than shown.",
		});
	});

	it("get_destination GETs {container}/destinations/{linkId}", async () => {
		const mock = mockGtm({ [`${CONTAINER}/destinations/3`]: () => json(ga4) });
		const result = await callTool("get_destination", { ...CONTAINER_ARGS, destinationLinkId: "3" });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: `${CONTAINER}/destinations/3` }]);
		expect(result.json()).toEqual(ga4);
	});

	it("get_destination refuses a link ID that could reshape the path", async () => {
		const mock = mockGtm({});
		const result = await callTool("get_destination", { ...CONTAINER_ARGS, destinationLinkId: "../3" });
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("link_destination", () => {
	const routes = (linked: unknown[] = []) => ({
		[CONTAINER]: byMethod({ GET: () => json(container) }),
		[`${CONTAINER}/destinations`]: byMethod({ GET: () => json({ destination: linked }) }),
		[`${CONTAINER}/destinations:link`]: byMethod({ POST: () => json(ga4) }),
	});

	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm(routes());
		const result = await callTool("link_destination", { ...CONTAINER_ARGS, destinationId: "G-ABC123", ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldLink: { destinationId: "G-ABC123", to: container },
		});
	});

	it("says so, and changes nothing, when the destination is already linked here", async () => {
		const mock = mockGtm(routes([ga4]));
		const result = await callTool("link_destination", { ...CONTAINER_ARGS, destinationId: "G-ABC123" });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			alreadyLinked: { destinationLinkId: "3", destinationId: "G-ABC123", name: "Main site" },
		});
	});

	it("with confirm: true POSTs {container}/destinations:link?destinationId=, without allowUserPermissionFeatureUpdate", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("link_destination", {
			...CONTAINER_ARGS,
			destinationId: " G-ABC123 ",
			confirm: true,
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{
				method: "POST",
				path: `${CONTAINER}/destinations:link`,
				query: { destinationId: "G-ABC123" },
				body: undefined,
			},
		]);
		expect(result.json()).toEqual({
			linked: { destinationLinkId: "3", destinationId: "G-ABC123", name: "Main site" },
			note: DESTINATION_NOTE,
		});
	});
});
