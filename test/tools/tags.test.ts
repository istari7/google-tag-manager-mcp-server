// create_tag, update_tag, delete_tag: the exact requests sent (verb, path, query, body),
// get-merge-put (Q1/Q2/Q7/Q12/Q13), consent settings (Q14) and confirm gating.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../src/gtm/errors";
import type { Tag } from "../../src/gtm/generated";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { AUTO_GOOGLE_TAG_UNCHECKED, tagRow } from "../../src/tools/tags";
import { errors, ga4EventTag } from "../fixtures/gtm";
import {
	byMethod,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	reply,
	rpc,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const TAG = `${WORKSPACE}/tags/12`;
const TAG_ARGS = { ...WORKSPACE_ARGS, tagId: "12" };

/** The stored tag as Google would PUT it back: everything but the fingerprint (Q2). */
const { fingerprint: STORED_FINGERPRINT, ...storedBody } = ga4EventTag;

/** GET returns the stored tag; PUT echoes the body with a new fingerprint. */
function tagRoutes() {
	return {
		[TAG]: byMethod({
			GET: () => json(ga4EventTag),
			PUT: (call) => json({ ...(JSON.parse(call.body) as Tag), fingerprint: "1731100000099" }),
		}),
		// Q23: read before and after a gaawe update that changes parameters; nothing new here.
		[`${WORKSPACE}/status`]: reply({}),
	};
}

describe("create_tag", () => {
	it("POSTs {workspace}/tags with exactly the given fields and Q14 consent settings", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/tags`]: (call) => json({ ...(JSON.parse(call.body) as Tag), tagId: "77", fingerprint: "1" }),
			[`${WORKSPACE}/status`]: reply({}),
		});
		const result = await callTool("create_tag", {
			...WORKSPACE_ARGS,
			name: "GA4 - Event - purchase",
			type: "gaawe",
			parameter: [
				{ type: "template", key: "eventName", value: "purchase" },
				{ type: "list", key: "eventSettingsTable", list: [{ type: "map", map: [{ type: "template", key: "k" }] }] },
			],
			firingTriggerId: ["34"],
			consentStatus: "needed",
			consentTypes: ["ad_storage", " analytics_storage "],
			parentFolderId: "9",
		});
		// Q23: gaawe, so the workspace status is read before and after the POST.
		expect(mock.gtm().map((c) => describeCall(c).path)).toEqual([
			`${WORKSPACE}/status`,
			`${WORKSPACE}/tags`,
			`${WORKSPACE}/status`,
		]);
		expect(describeCall(mock.gtm()[1])).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/tags`,
			query: {},
			body: {
				name: "GA4 - Event - purchase",
				type: "gaawe",
				parameter: [
					{ type: "template", key: "eventName", value: "purchase" },
					{ type: "list", key: "eventSettingsTable", list: [{ type: "map", map: [{ type: "template", key: "k" }] }] },
				],
				firingTriggerId: ["34"],
				parentFolderId: "9",
				consentSettings: {
					consentStatus: "needed",
					consentType: {
						type: "list",
						list: [
							{ type: "template", value: "ad_storage" },
							{ type: "template", value: "analytics_storage" },
						],
					},
				},
			},
		});
		// No IDs from the tool arguments leak into the body.
		expect(describeCall(mock.gtm()[1]).body).not.toHaveProperty("accountId");
		const out = result.json<{ tag: Tag; note: string }>();
		expect(out.tag).toMatchObject({ tagId: "77", name: "GA4 - Event - purchase" });
		expect(out).not.toHaveProperty("warnings");
		expect(out.note).toBe(UNPUBLISHED_CHANGES_NOTE);
	});

	describe("Q23 GTM's own Google tag and gtagConfigs", () => {
		const existing = { changeStatus: "added", tag: { tagId: "5", name: "Mine", type: "html" } };
		/** Status: before the POST only tag 5; after it also tag 77 (ours), Google tag 79 and gtagConfigs 80/81. */
		function statusRoutes() {
			let reads = 0;
			return {
				[`${WORKSPACE}/tags`]: (call: { body: string }) =>
					json({ ...(JSON.parse(call.body) as Tag), tagId: "77", fingerprint: "1" }),
				[`${WORKSPACE}/status`]: () =>
					json({
						workspaceChange:
							reads++ === 0
								? [existing]
								: [
										existing,
										{
											changeStatus: "added",
											tag: { tagId: "77", name: "GA4 - purchase", type: "gaawe", paused: true },
										},
										{ changeStatus: "added", tag: { tagId: "79", name: "Google Analytics G-ABC", type: "googtag" } },
										{ changeStatus: "added", gtagConfig: { gtagConfigId: "80", type: "ogt_auto_events" } },
										{ changeStatus: "added", gtagConfig: { gtagConfigId: "81", type: "ogt_1p_data_v2" } },
									],
					}),
			};
		}

		it("a gaawe create reports what GTM added by itself, with a warning about the unpaused Google tag", async () => {
			mockGtm(statusRoutes());
			const result = await callTool("create_tag", {
				...WORKSPACE_ARGS,
				name: "GA4 - purchase",
				type: "gaawe",
				paused: true,
			});
			const out = result.json<{ alsoChangedByGtm: unknown[]; warnings: string[] }>();
			expect(out.alsoChangedByGtm).toEqual([
				{
					kind: "tag",
					id: "79",
					name: "Google Analytics G-ABC",
					type: "googtag",
					paused: false,
					changeStatus: "added",
				},
				{ kind: "gtagConfig", id: "80", type: "ogt_auto_events", changeStatus: "added" },
				{ kind: "gtagConfig", id: "81", type: "ogt_1p_data_v2", changeStatus: "added" },
			]);
			expect(out.warnings).toEqual([
				"GTM also changed 3 other entities by itself (Q23, see alsoChangedByGtm), including 1 unpaused tag(s). They go live with this workspace when it is published. Tell the user; remove unwanted ones with delete_tag / delete_gtag_config.",
			]);
		});

		it("an html create reads no workspace status", async () => {
			const mock = mockGtm(statusRoutes());
			const result = await callTool("create_tag", { ...WORKSPACE_ARGS, name: "x", type: "html" });
			expect(mock.gtm().map((c) => describeCall(c).path)).toEqual([`${WORKSPACE}/tags`]);
			expect(result.json()).not.toHaveProperty("warnings");
		});

		it("when the status can't be read, the create still succeeds with a check-it-yourself warning", async () => {
			mockGtm({
				[`${WORKSPACE}/tags`]: (call) => json({ ...(JSON.parse(call.body) as Tag), tagId: "77", fingerprint: "1" }),
				[`${WORKSPACE}/status`]: reply(errors.forbidden403, 403),
			});
			const result = await callTool("create_tag", { ...WORKSPACE_ARGS, name: "Ads", type: "awct" });
			expect(result.isError).toBe(false);
			expect(result.json<{ warnings: string[] }>().warnings).toEqual([AUTO_GOOGLE_TAG_UNCHECKED]);
		});

		it("an update that makes a tag gaawe reads the status before and after", async () => {
			let reads = 0;
			const mock = mockGtm({
				[TAG]: byMethod({
					GET: () => json({ ...ga4EventTag, type: "html" }),
					PUT: (call) => json({ ...(JSON.parse(call.body) as Tag), fingerprint: "2" }),
				}),
				[`${WORKSPACE}/status`]: () =>
					json(
						reads++ === 0
							? {}
							: { workspaceChange: [{ changeStatus: "added", gtagConfig: { gtagConfigId: "80", type: "x" } }] },
					),
			});
			const result = await callTool("update_tag", { ...TAG_ARGS, type: "gaawe" });
			expect(mock.gtm().map((c) => `${c.method} ${describeCall(c).path}`)).toEqual([
				`GET ${WORKSPACE}/status`,
				`GET ${TAG}`,
				`PUT ${TAG}`,
				`GET ${WORKSPACE}/status`,
			]);
			expect(result.json()).toMatchObject({
				alsoChangedByGtm: [{ kind: "gtagConfig", id: "80", type: "x", changeStatus: "added" }],
			});
		});
	});

	it("refuses consentTypes without consentStatus, before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("create_tag", {
			...WORKSPACE_ARGS,
			name: "x",
			type: "html",
			consentTypes: ["ad_storage"],
		});
		expect(result).toMatchObject({ isError: true, text: 'consentTypes needs consentStatus: "needed".' });
		expect(mock.calls).toHaveLength(0);
	});

	it("validates parameter types and trigger IDs against the generated shapes", async () => {
		const mock = mockGtm();
		const badType = await callTool("create_tag", {
			...WORKSPACE_ARGS,
			name: "x",
			type: "html",
			parameter: [{ type: "string", key: "html", value: "<script></script>" }],
		});
		expect(badType.isError).toBe(true);
		const badTrigger = await callTool("create_tag", {
			...WORKSPACE_ARGS,
			name: "x",
			type: "html",
			firingTriggerId: ["All Pages"],
		});
		expect(badTrigger.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});

	it("surfaces a duplicate-name 400 from Google", async () => {
		mockGtm({ [`${WORKSPACE}/tags`]: reply(errors.duplicateName400, 400) });
		const result = await callTool("create_tag", { ...WORKSPACE_ARGS, name: "GA4 - Event - sign_up", type: "gaawe" });
		expect(result).toMatchObject({
			isError: true,
			text: "GTM rejected the request: Found entity with duplicate name: GA4 - Event - sign_up",
		});
	});
});

describe("update_tag", () => {
	it("Q1/Q2: GETs the tag, then PUTs the whole merged object with ?fingerprint=", async () => {
		const mock = mockGtm(tagRoutes());
		const parameter = [{ type: "template", key: "eventName", value: "sign_up_v2" }];
		const result = await callTool("update_tag", { ...TAG_ARGS, parameter, fingerprint: STORED_FINGERPRINT });
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", `${WORKSPACE}/status`, {}],
			["GET", TAG, {}],
			["PUT", TAG, { fingerprint: STORED_FINGERPRINT }],
			["GET", `${WORKSPACE}/status`, {}],
		]);
		// Everything the patch didn't mention is sent back unchanged; no body fingerprint.
		expect(calls[2]?.body).toEqual({ ...storedBody, parameter });
		const out = result.json<{ tag: Tag; note: string }>();
		expect(out.tag.fingerprint).toBe("1731100000099");
		expect(out.tag).not.toHaveProperty("tagManagerUrl");
		expect(out.note).toBe(UNPUBLISHED_CHANGES_NOTE);
	});

	it("Q1: changing one field keeps parameters, triggers, setup tags, consent, notes and folder", async () => {
		const mock = mockGtm(tagRoutes());
		await callTool("update_tag", { ...TAG_ARGS, paused: true });
		const put = describeCall(mock.gtm()[1]);
		expect(put.body).toEqual({ ...storedBody, paused: true });
	});

	it('Q7/Q12: [] clears firing triggers and "" clears notes; omitted lists are kept', async () => {
		const mock = mockGtm(tagRoutes());
		await callTool("update_tag", { ...TAG_ARGS, firingTriggerId: [], notes: "" });
		const body = describeCall(mock.gtm()[1]).body as Tag;
		expect(body.firingTriggerId).toEqual([]);
		expect(body.notes).toBe("");
		expect(body.blockingTriggerId).toEqual(["35"]);
		expect(body.parentFolderId).toBe("9");
	});

	it("Q14: consentStatus replaces the consent settings", async () => {
		const mock = mockGtm(tagRoutes());
		await callTool("update_tag", { ...TAG_ARGS, consentStatus: "notSet" });
		expect((describeCall(mock.gtm()[1]).body as Tag).consentSettings).toEqual({ consentStatus: "notSet" });
	});

	describe('Q14: a tag stored with consent "needed"', () => {
		const consentSettings = {
			consentStatus: "needed" as const,
			consentType: {
				type: "list" as const,
				list: [
					{ type: "template" as const, value: "ad_storage" },
					{ type: "template" as const, value: "analytics_storage" },
				],
			},
		};
		const routes = () => ({
			[TAG]: byMethod({
				GET: () => json({ ...ga4EventTag, consentSettings }),
				PUT: (call) => json(JSON.parse(call.body)),
			}),
		});

		it('consentStatus "needed" without consentTypes keeps the stored consent types', async () => {
			const mock = mockGtm(routes());
			await callTool("update_tag", { ...TAG_ARGS, consentStatus: "needed" });
			expect((describeCall(mock.gtm()[1]).body as Tag).consentSettings).toEqual(consentSettings);
		});

		it("consentTypes alone replace the stored types and keep the status", async () => {
			const mock = mockGtm(routes());
			const result = await callTool("update_tag", { ...TAG_ARGS, consentTypes: ["ad_user_data"] });
			expect(result.isError).toBeFalsy();
			expect((describeCall(mock.gtm()[1]).body as Tag).consentSettings).toEqual({
				consentStatus: "needed",
				consentType: { type: "list", list: [{ type: "template", value: "ad_user_data" }] },
			});
		});
	});

	it('Q14: consentTypes alone on a tag not stored as "needed" is refused, with no PUT', async () => {
		const mock = mockGtm(tagRoutes());
		const result = await callTool("update_tag", { ...TAG_ARGS, consentTypes: ["ad_storage"] });
		expect(result).toMatchObject({
			isError: true,
			text: 'consentTypes needs consentStatus: "needed" (the stored consent status is "notNeeded").',
		});
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(tagRoutes());
		const result = await callTool("update_tag", { ...TAG_ARGS, name: "Renamed", fingerprint: "1700000000000" });
		expect(result).toMatchObject({
			isError: true,
			text: MESSAGES.conflict,
		});
		expect(mock.gtm().map((c) => c.method)).toEqual(["GET"]);
	});

	it("Q2: a 409 from Google on the PUT is a conflict, not retried", async () => {
		const mock = mockGtm({
			[TAG]: byMethod({ GET: () => json(ga4EventTag), PUT: () => json(errors.fingerprint409, 409) }),
		});
		const result = await callTool("update_tag", { ...TAG_ARGS, name: "Renamed" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("It changed since it was read");
		expect(mock.gtm().map((c) => c.method)).toEqual(["GET", "PUT"]);
	});

	it("refuses an update with no fields, before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("update_tag", { ...TAG_ARGS, fingerprint: STORED_FINGERPRINT });
		expect(result).toMatchObject({ isError: true, text: "Nothing to update: pass at least one tag field." });
		expect(mock.calls).toHaveLength(0);
	});
});

describe("delete_tag", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only GETs and previews", async (extra) => {
		const mock = mockGtm(tagRoutes());
		const result = await callTool("delete_tag", { ...TAG_ARGS, ...extra });
		expect(result.isError).toBe(false);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: TAG }]);
		expect(result.json()).toEqual({
			preview: true,
			wouldDelete: {
				kind: "tag",
				tagId: "12",
				name: "GA4 - Event - sign_up",
				type: "gaawe",
				parentFolderId: "9",
				firingTriggerId: ["34"],
				blockingTriggerId: ["35"],
			},
			message:
				"Nothing was deleted. To delete this tag, get the user's go-ahead, then call delete_tag again with confirm: true.",
		});
	});

	it("with confirm: true sends one DELETE and says it is not live yet", async () => {
		const mock = mockGtm({ [TAG]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_tag", { ...TAG_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: TAG, query: {}, body: undefined }]);
		expect(result.json()).toEqual({ deleted: { kind: "tag", id: "12" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("a preview of a missing tag is a not-found error", async () => {
		mockGtm({ [`${WORKSPACE}/tags/99`]: reply(errors.notFound404, 404) });
		const result = await callTool("delete_tag", { ...WORKSPACE_ARGS, tagId: "99" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Not found") });
	});
});

describe("list_tags paused state", () => {
	it("rows carry paused: true only for paused tags; active tags omit it", () => {
		expect(tagRow({ tagId: "1", paused: true })).toMatchObject({ paused: true });
		expect(tagRow({ tagId: "2", paused: false }).paused).toBeUndefined();
		expect(tagRow({ tagId: "3" }).paused).toBeUndefined();
	});

	it("the description says so, so a missing paused is not read as unknown", async () => {
		const { result } = await rpc("tools/list");
		const tools = (result as { tools: Array<{ name: string; description: string }> }).tools;
		const description = tools.find((t) => t.name === "list_tags")?.description ?? "";
		expect(description).toContain("paused: true");
		expect(description).toContain("absent = active");
	});
});
