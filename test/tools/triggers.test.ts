// create_trigger, update_trigger, delete_trigger: requests sent, and the trigger quirks as
// seen through the tools (Q3/Q4/Q5/Q6/Q10/Q11, GTM_API_QUIRKS.md).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Trigger } from "../../src/gtm/generated";
import { AUTO_EVENT_FILTER_WARNING, UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { customEventTrigger, errors, linkClickTrigger } from "../fixtures/gtm";
import {
	byMethod,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	pages,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const TRIGGER = `${WORKSPACE}/triggers/34`;
const TRIGGER_ARGS = { ...WORKSPACE_ARGS, triggerId: "34" };

const urlContains = (value: string) => ({
	type: "contains",
	parameter: [
		{ type: "template", key: "arg0", value: "{{Click URL}}" },
		{ type: "template", key: "arg1", value },
	],
});

/** POST {workspace}/triggers echoing the body back with an ID. */
function createRoute() {
	return {
		[`${WORKSPACE}/triggers`]: (call: { body: string }) =>
			json({ ...(JSON.parse(call.body) as Trigger), triggerId: "88", fingerprint: "1" }),
	};
}

describe("create_trigger", () => {
	it("Q3/Q4: a click trigger's autoEventFilter lands in filter, without companions (Google drops them on click)", async () => {
		const mock = mockGtm(createRoute());
		const result = await callTool("create_trigger", {
			...WORKSPACE_ARGS,
			name: "Click - CTA",
			type: "click",
			autoEventFilter: [urlContains("/signup")],
		});
		const call = describeCall(mock.gtm()[0]);
		expect(call).toMatchObject({ method: "POST", path: `${WORKSPACE}/triggers`, query: {} });
		expect(call.body).toEqual({
			name: "Click - CTA",
			type: "click",
			filter: [urlContains("/signup")],
		});
		const out = result.json<{ trigger: Trigger; warnings: string[]; note: string }>();
		expect(out.warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
		expect(out.note).toBe(UNPUBLISHED_CHANGES_NOTE);
		expect(out.trigger.triggerId).toBe("88");
	});

	it("Q5: doesNotContain becomes contains + a boolean negate parameter", async () => {
		const mock = mockGtm(createRoute());
		await callTool("create_trigger", {
			...WORKSPACE_ARGS,
			name: "PV - not checkout",
			type: "pageview",
			filter: [
				{
					type: "doesNotContain",
					parameter: [
						{ type: "template", key: "arg0", value: "{{Page Path}}" },
						{ type: "template", key: "arg1", value: "/checkout" },
					],
				},
			],
		});
		expect(describeCall(mock.gtm()[0]).body).toEqual({
			name: "PV - not checkout",
			type: "pageview",
			filter: [
				{
					type: "contains",
					parameter: [
						{ type: "template", key: "arg0", value: "{{Page Path}}" },
						{ type: "template", key: "arg1", value: "/checkout" },
						{ type: "boolean", key: "negate", value: "true" },
					],
				},
			],
		});
	});

	it("Q10: on linkClick, autoEventFilter is appended to an existing filter", async () => {
		const mock = mockGtm(createRoute());
		await callTool("create_trigger", {
			...WORKSPACE_ARGS,
			name: "Link - PDFs",
			type: "linkClick",
			filter: [urlContains(".pdf")],
			autoEventFilter: [urlContains("/docs/")],
			waitForTags: { type: "boolean", value: "true" },
		});
		const body = describeCall(mock.gtm()[0]).body as Trigger;
		expect(body.filter).toEqual([urlContains(".pdf"), urlContains("/docs/")]);
		expect(body).not.toHaveProperty("autoEventFilter");
		// Q4: a companion the caller gave is kept; missing ones get typed defaults.
		expect(body.waitForTags).toEqual({ type: "boolean", value: "true" });
		expect(body.checkValidation).toEqual({ type: "boolean", value: "false" });
		expect(body.waitForTagsTimeout).toEqual({ type: "integer", value: "2000" });
	});

	it("a customEvent trigger keeps customEventFilter and gets no companions", async () => {
		const mock = mockGtm(createRoute());
		const customEventFilter = [
			{
				type: "equals",
				parameter: [
					{ type: "template", key: "arg0", value: "{{_event}}" },
					{ type: "template", key: "arg1", value: "sign_up" },
				],
			},
		];
		const result = await callTool("create_trigger", {
			...WORKSPACE_ARGS,
			name: "CE - sign_up",
			type: "customEvent",
			customEventFilter,
			parentFolderId: "9",
		});
		expect(describeCall(mock.gtm()[0]).body).toEqual({
			name: "CE - sign_up",
			type: "customEvent",
			customEventFilter,
			parentFolderId: "9",
		});
		expect(result.json()).not.toHaveProperty("warnings");
	});

	it("rejects a trigger type Google doesn't have, before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("create_trigger", { ...WORKSPACE_ARGS, name: "x", type: "custom_event" });
		expect(result.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("update_trigger", () => {
	function routes() {
		return {
			[TRIGGER]: byMethod({
				GET: () => json(linkClickTrigger),
				PUT: (call) => json({ ...(JSON.parse(call.body) as Trigger), fingerprint: "1731100000098" }),
			}),
		};
	}
	const { fingerprint: STORED_FINGERPRINT, uniqueTriggerId: _server, ...storedBody } = linkClickTrigger;

	it("Q1/Q2/Q6: GET, then PUT of the merged trigger with ?fingerprint= and no uniqueTriggerId", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_trigger", { ...TRIGGER_ARGS, name: "Link - Outbound v2" });
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", TRIGGER, {}],
			["PUT", TRIGGER, { fingerprint: STORED_FINGERPRINT }],
		]);
		expect(calls[1]?.body).toEqual({ ...storedBody, name: "Link - Outbound v2" });
		expect(result.json()).not.toHaveProperty("warnings");
	});

	it("Q3/Q10/Q11: an autoEventFilter patch on a stored linkClick is appended to its filter; stored companions are kept", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_trigger", {
			...TRIGGER_ARGS,
			autoEventFilter: [urlContains("/careers")],
			fingerprint: STORED_FINGERPRINT,
		});
		const body = describeCall(mock.gtm()[1]).body as Trigger;
		// Q10: the patch has no filter, so the stored filter is kept and the conditions are appended.
		// The stored autoEventFilter is left as it was.
		expect(body.filter).toEqual([...(linkClickTrigger.filter ?? []), urlContains("/careers")]);
		expect(body.autoEventFilter).toEqual(linkClickTrigger.autoEventFilter);
		expect(body.waitForTags).toEqual({ type: "boolean", value: "true" });
		expect(body.waitForTagsTimeout).toEqual({ type: "integer", value: "1500" });
		expect(result.json<{ warnings: string[] }>().warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
	});

	it("Q7: filter: [] clears the conditions; the other filter lists are kept", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/triggers/40`]: byMethod({
				GET: () => json(customEventTrigger),
				PUT: (c) => json(JSON.parse(c.body)),
			}),
		});
		await callTool("update_trigger", { ...WORKSPACE_ARGS, triggerId: "40", filter: [] });
		const body = describeCall(mock.gtm()[1]).body as Trigger;
		expect(body.filter).toEqual([]);
		expect(body.customEventFilter).toEqual(customEventTrigger.customEventFilter);
		expect(body.notes).toBe("keep");
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_trigger", { ...TRIGGER_ARGS, name: "x", fingerprint: "1" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("It changed since it was read") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});
});

describe("delete_trigger", () => {
	/** Tags 12 (fires on 34) and 14 (blocked by 34), trigger group 40 (lists 34); 13 and 41 don't use it. */
	function usageRoutes() {
		return {
			[`${WORKSPACE}/tags`]: pages("tag", [
				[
					{ tagId: "12", name: "GA4 - outbound", firingTriggerId: ["34"] },
					{ tagId: "13", name: "Unrelated", firingTriggerId: ["2"] },
				],
				[{ tagId: "14", name: "Blocked on outbound", firingTriggerId: ["2"], blockingTriggerId: ["34"] }],
			]),
			[`${WORKSPACE}/triggers`]: pages("trigger", [
				[
					linkClickTrigger,
					{
						triggerId: "40",
						name: "Group - outbound + scroll",
						type: "triggerGroup",
						parameter: [
							{
								type: "list",
								key: "triggerIds",
								list: [
									{ type: "triggerReference", value: "34" },
									{ type: "triggerReference", value: "35" },
								],
							},
						],
					},
					{
						triggerId: "41",
						name: "Other group",
						type: "triggerGroup",
						parameter: [{ type: "list", key: "triggerIds", list: [{ type: "triggerReference", value: "340" }] }],
					},
				],
			]),
		};
	}

	it("Q26 without confirm only reads, and lists the tags and trigger groups that use it, saying the delete will fail", async () => {
		const mock = mockGtm({ [TRIGGER]: byMethod({ GET: () => json(linkClickTrigger) }), ...usageRoutes() });
		const result = await callTool("delete_trigger", TRIGGER_ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(
			mock
				.gtm()
				.map((c) => describeCall(c).path)
				.sort(),
		).toEqual([TRIGGER, `${WORKSPACE}/tags`, `${WORKSPACE}/tags`, `${WORKSPACE}/triggers`].sort());
		const out = result.json<{ preview: boolean; wouldDelete: Record<string, unknown> }>();
		expect(out).toMatchObject({
			preview: true,
			wouldDelete: {
				kind: "trigger",
				triggerId: "34",
				name: "Link - Outbound",
				type: "linkClick",
				usedByTags: [
					{ id: "12", name: "GA4 - outbound" },
					{ id: "14", name: "Blocked on outbound" },
				],
				usedByTriggerGroups: [{ id: "40", name: "Group - outbound + scroll" }],
			},
		});
		expect(out.wouldDelete.warning).toContain("GTM will refuse to delete this trigger while these still use it.");
	});

	it("an unused trigger's preview has no references and no warning", async () => {
		mockGtm({
			[TRIGGER]: byMethod({ GET: () => json(linkClickTrigger) }),
			[`${WORKSPACE}/tags`]: pages("tag", [[{ tagId: "13", name: "Unrelated", firingTriggerId: ["2"] }]]),
			[`${WORKSPACE}/triggers`]: pages("trigger", [[linkClickTrigger]]),
		});
		const out = (await callTool("delete_trigger", TRIGGER_ARGS)).json<{ wouldDelete: Record<string, unknown> }>();
		expect(Object.keys(out.wouldDelete).sort()).toEqual(["kind", "name", "parentFolderId", "triggerId", "type"]);
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [TRIGGER]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_trigger", { ...TRIGGER_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: TRIGGER, query: {} }]);
		expect(result.json()).toEqual({ deleted: { kind: "trigger", id: "34" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("Q26 with confirm: true, GTM's bare 400 becomes an error naming what still uses the trigger", async () => {
		const mock = mockGtm({
			[TRIGGER]: byMethod({ DELETE: () => json(errors.stillInUse400, 400) }),
			...usageRoutes(),
		});
		const result = await callTool("delete_trigger", { ...TRIGGER_ARGS, confirm: true });
		expect(writes(mock.gtm()).map(describeCall)).toMatchObject([{ method: "DELETE", path: TRIGGER }]);
		expect(result.isError).toBe(true);
		expect(result.text).toBe(
			'Nothing was deleted: GTM refuses to delete trigger 34 while it is still used by tags 12 "GA4 - outbound", 14 "Blocked on outbound"; trigger groups 40 "Group - outbound + scroll". First remove it from those tags\' firingTriggerId/blockingTriggerId (update_tag) and from those trigger groups, or delete them.',
		);
	});

	it("Q26 a 400 with no reference found still says what usually causes it", async () => {
		mockGtm({
			[TRIGGER]: byMethod({ DELETE: () => json(errors.stillInUse400, 400) }),
			[`${WORKSPACE}/tags`]: pages("tag", [[]]),
			[`${WORKSPACE}/triggers`]: pages("trigger", [[]]),
		});
		const result = await callTool("delete_trigger", { ...TRIGGER_ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Nothing was deleted: GTM refused to delete trigger 34.");
		expect(result.text).toContain("something still uses it (Q26)");
	});
});
