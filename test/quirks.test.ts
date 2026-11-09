// One describe block per row of GTM_API_QUIRKS.md. Test names start with the quirk number.

import { describe, expect, it } from "vitest";
import { listAll } from "../src/gtm/client";
import { MESSAGES } from "../src/gtm/errors";
import { accounts, type Tag, type Trigger, type Variable } from "../src/gtm/generated";
import {
	createTag,
	createTrigger,
	createVariable,
	getMergePut,
	mergeForUpdate,
	prepareUpdate,
	stripServerFields,
	updateFolder,
	updateTag,
	updateTrigger,
	updateVariable,
} from "../src/gtm/merge";
import {
	AUTO_EVENT_FILTER_WARNING,
	buildConsentSettings,
	CLICK_TRIGGER_COMPANIONS,
	COMPANION_TRIGGER_TYPES,
	createVersionProblem,
	DLV_DEFAULT_VALUE_WARNING,
	isClickLinkFormTrigger,
	normalizeCondition,
	normalizeConditions,
	normalizeTrigger,
	normalizeVariable,
	type TriggerInput,
	takesClickCompanions,
	UNPUBLISHED_CHANGES_NOTE,
} from "../src/gtm/quirks";
import { json, sentBody, testClient } from "./fixtures/fake-fetch";
import {
	customEventTrigger,
	dlvVariable,
	errors,
	FOLDER_PATH,
	folder,
	ga4EventTag,
	linkClickTrigger,
	TAG_PATH,
	TRIGGER_PATH,
	VARIABLE_PATH,
	WORKSPACE,
} from "./fixtures/gtm";

const contains = (arg1: string) => ({
	type: "contains" as const,
	parameter: [
		{ type: "template" as const, key: "arg0", value: "{{Click URL}}" },
		{ type: "template" as const, key: "arg1", value: arg1 },
	],
});

/** Fake client that answers GET with `stored` and echoes the PUT body back. */
function getPutClient<T>(stored: T) {
	return testClient((call) => (call.method === "GET" ? json(200, stored) : json(200, call.body)));
}

describe("Q1 updates are PUT = full replacement", () => {
	it("Q1 merge keeps every field the patch omits", () => {
		const merged = mergeForUpdate(ga4EventTag, { name: "Renamed" });
		expect(merged).toEqual({ ...ga4EventTag, name: "Renamed" });
		expect(merged).not.toBe(ga4EventTag);
	});

	it("Q1 updateTag GETs the tag, then PUTs the whole merged object", async () => {
		const { client, calls } = getPutClient(ga4EventTag);
		await updateTag(client, TAG_PATH, { paused: true });
		expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
		const { fingerprint: _fp, ...expected } = ga4EventTag;
		expect(calls[1]?.body).toEqual({ ...expected, paused: true });
	});

	it("Q1 updateVariable and updateFolder also send the full object", async () => {
		const v = getPutClient(dlvVariable);
		await updateVariable(v.client, VARIABLE_PATH, { name: "DLV - uid" });
		expect(v.calls[1]?.body).toMatchObject({ name: "DLV - uid", type: "v", parameter: dlvVariable.parameter });

		const f = getPutClient(folder);
		await updateFolder(f.client, FOLDER_PATH, { notes: "n" });
		expect(f.calls[1]?.body).toEqual({ folderId: "9", name: "Marketing", notes: "n", path: FOLDER_PATH });
	});

	it("Q1 the merge does not mutate the stored object", () => {
		const before = structuredClone(ga4EventTag);
		mergeForUpdate(ga4EventTag, { parameter: [] });
		expect(ga4EventTag).toEqual(before);
	});
});

describe("Q2 fingerprint is a query parameter", () => {
	it("Q2 prepareUpdate returns the stored fingerprint separately and strips it from the body", () => {
		const prepared = prepareUpdate(ga4EventTag, { name: "x" });
		expect(prepared.fingerprint).toBe(ga4EventTag.fingerprint);
		expect(prepared.body).not.toHaveProperty("fingerprint");
	});

	it("Q2 the PUT carries ?fingerprint=<stored> and no body fingerprint, even if the patch sends one", async () => {
		const { client, calls } = getPutClient(ga4EventTag);
		await updateTag(client, TAG_PATH, { name: "x", fingerprint: "attacker-chosen" });
		expect(calls[1]?.url.searchParams.get("fingerprint")).toBe(ga4EventTag.fingerprint);
		expect(calls[1]?.body).not.toHaveProperty("fingerprint");
	});

	it("Q2 a stale expectedFingerprint fails with a conflict before any write", async () => {
		const { client, calls } = getPutClient(ga4EventTag);
		await expect(updateTag(client, TAG_PATH, { name: "x" }, { expectedFingerprint: "old" })).rejects.toMatchObject({
			status: 409,
			kind: "conflict",
		});
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("Q2 a matching expectedFingerprint goes ahead", async () => {
		const { client, calls } = getPutClient(ga4EventTag);
		await updateTag(client, TAG_PATH, { name: "x" }, { expectedFingerprint: ga4EventTag.fingerprint });
		expect(calls).toHaveLength(2);
	});

	it("Q2 a 409 from Google during the PUT surfaces as a conflict and is not retried", async () => {
		const { client, calls } = testClient((call) =>
			call.method === "GET" ? json(200, ga4EventTag) : json(409, errors.fingerprint409),
		);
		await expect(updateTag(client, TAG_PATH, { name: "x" })).rejects.toThrow(MESSAGES.conflict);
		expect(calls).toHaveLength(2);
	});
});

describe("Q3 autoEventFilter is ignored on click / linkClick / formSubmission", () => {
	it("Q3 only those three trigger types are affected", () => {
		expect(["click", "linkClick", "formSubmission"].every(isClickLinkFormTrigger)).toBe(true);
		expect(["pageview", "customEvent", "timer", undefined].some(isClickLinkFormTrigger)).toBe(false);
	});

	for (const type of ["click", "linkClick", "formSubmission"] as const) {
		it(`Q3 create ${type}: autoEventFilter is moved to filter`, () => {
			const { value, warnings } = normalizeTrigger({ name: "t", type, autoEventFilter: [contains("example.com")] });
			expect(value.filter).toEqual([contains("example.com")]);
			expect(value).not.toHaveProperty("autoEventFilter");
			expect(warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
		});
	}

	it("Q3 other trigger types keep autoEventFilter untouched", () => {
		const { value, warnings } = normalizeTrigger({ name: "t", type: "timer", autoEventFilter: [contains("x")] });
		expect(value.autoEventFilter).toEqual([contains("x")]);
		expect(value).not.toHaveProperty("filter");
		expect(warnings).toEqual([]);
	});

	it("Q3 an empty autoEventFilter is not remapped (it is a clear, Q7)", () => {
		const { value } = normalizeTrigger({ type: "linkClick", autoEventFilter: [] });
		expect(value.autoEventFilter).toEqual([]);
		expect(value).not.toHaveProperty("filter");
	});

	it("Q3 update uses the stored type when the patch has none", async () => {
		const { client, calls } = getPutClient(linkClickTrigger);
		const { warnings } = await updateTrigger(client, TRIGGER_PATH, { autoEventFilter: [contains("new")] });
		const body = sentBody<Trigger>(calls, 1);
		// Q10: the patch has no filter, so the remapped conditions are appended to the stored one.
		expect(body.filter).toEqual([...(linkClickTrigger.filter ?? []), contains("new")]);
		// The stored autoEventFilter is preserved, not replaced.
		expect(body.autoEventFilter).toEqual(linkClickTrigger.autoEventFilter);
		expect(warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
	});

	it("Q3 createTrigger sends the remapped body", async () => {
		const { client, calls } = testClient((call) => json(200, call.body));
		await createTrigger(client, WORKSPACE, { name: "t", type: "formSubmission", autoEventFilter: [contains("x")] });
		const body = sentBody<Trigger>(calls, 0);
		expect(calls[0]?.url.pathname).toBe(`/tagmanager/v2/${WORKSPACE}/triggers`);
		expect(body.filter).toEqual([contains("x")]);
		expect(body.autoEventFilter).toBeUndefined();
	});
});

describe("Q4 companion fields for linkClick / formSubmission (not click)", () => {
	it("Q4 only linkClick and formSubmission take companions; Google drops them on click", () => {
		expect(COMPANION_TRIGGER_TYPES).toEqual(["linkClick", "formSubmission"]);
		expect(["linkClick", "formSubmission"].every(takesClickCompanions)).toBe(true);
		expect(["click", "pageview", "customEvent", undefined].some(takesClickCompanions)).toBe(false);
	});

	it("Q4 the defaults have the exact parameter types Google expects", () => {
		expect(CLICK_TRIGGER_COMPANIONS).toEqual({
			waitForTags: { type: "boolean", value: "false" },
			checkValidation: { type: "boolean", value: "false" },
			waitForTagsTimeout: { type: "integer", value: "2000" },
		});
	});

	it("Q4 create: companions are set when autoEventFilter is remapped", () => {
		const { value } = normalizeTrigger({ name: "t", type: "linkClick", autoEventFilter: [contains("x")] });
		expect(value.waitForTags).toEqual({ type: "boolean", value: "false" });
		expect(value.checkValidation).toEqual({ type: "boolean", value: "false" });
		expect(value.waitForTagsTimeout).toEqual({ type: "integer", value: "2000" });
	});

	it("Q4 create formSubmission: companions are set when autoEventFilter is remapped", () => {
		const { value } = normalizeTrigger({ name: "t", type: "formSubmission", autoEventFilter: [contains("x")] });
		expect(value.waitForTags).toEqual({ type: "boolean", value: "false" });
		expect(value.checkValidation).toEqual({ type: "boolean", value: "false" });
		expect(value.waitForTagsTimeout).toEqual({ type: "integer", value: "2000" });
	});

	it("Q4 create click: autoEventFilter is remapped but no companions are added", () => {
		const { value, warnings } = normalizeTrigger({ name: "t", type: "click", autoEventFilter: [contains("x")] });
		expect(value.filter).toEqual([contains("x")]);
		expect(value).not.toHaveProperty("waitForTags");
		expect(value).not.toHaveProperty("checkValidation");
		expect(value).not.toHaveProperty("waitForTagsTimeout");
		expect(warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
	});

	it("Q4 click: companions the caller sends are passed through unrepaired", () => {
		const { value } = normalizeTrigger({
			type: "click",
			autoEventFilter: [contains("x")],
			waitForTags: { type: "template", value: "true" },
		});
		expect(value.waitForTags).toEqual({ type: "template", value: "true" });
		expect(value).not.toHaveProperty("checkValidation");
	});

	it("Q4 create: no companions when nothing was remapped", () => {
		const { value } = normalizeTrigger({ name: "t", type: "linkClick", filter: [contains("x")] });
		expect(value).not.toHaveProperty("waitForTags");
	});

	it("Q4 companions given by the caller are kept", () => {
		const { value } = normalizeTrigger({
			type: "linkClick",
			autoEventFilter: [contains("x")],
			waitForTags: { type: "boolean", value: "true" },
		});
		expect(value.waitForTags).toEqual({ type: "boolean", value: "true" });
	});

	it("Q4 a wrongly typed companion is coerced when its value fits, else reset", () => {
		const { value } = normalizeTrigger({
			type: "formSubmission",
			autoEventFilter: [contains("x")],
			waitForTags: { type: "template", value: "true" },
			waitForTagsTimeout: { type: "template", value: "{{oops}}" },
		});
		expect(value.waitForTags).toEqual({ type: "boolean", value: "true" });
		expect(value.waitForTagsTimeout).toEqual({ type: "integer", value: "2000" });
	});
});

describe("Q5 doesNotContain is not a valid condition type", () => {
	it("Q5 doesNotContain becomes contains + a boolean negate parameter", () => {
		const out = normalizeCondition({ ...contains("x"), type: "doesNotContain" });
		expect(out.type).toBe("contains");
		expect(out.parameter).toEqual([...contains("x").parameter, { type: "boolean", key: "negate", value: "true" }]);
	});

	it("Q5 negate: true is turned into the parameter without duplicating an existing one", () => {
		const out = normalizeCondition({
			type: "equals",
			negate: true,
			parameter: [{ type: "boolean", key: "negate", value: "false" }],
		});
		expect(out).toEqual({ type: "equals", parameter: [{ type: "boolean", key: "negate", value: "true" }] });
	});

	it("Q5 plain conditions pass through unchanged", () => {
		expect(normalizeCondition(contains("x"))).toEqual(contains("x"));
	});

	it("Q5 is applied to filter, autoEventFilter and customEventFilter", () => {
		const dnc = { ...contains("x"), type: "doesNotContain" as const };
		const { value } = normalizeTrigger({
			type: "customEvent",
			filter: [dnc],
			autoEventFilter: [dnc],
			customEventFilter: [dnc],
		});
		for (const list of [value.filter, value.autoEventFilter, value.customEventFilter]) {
			expect(list?.[0]?.type).toBe("contains");
			expect(list?.[0]?.parameter?.at(-1)).toEqual({ type: "boolean", key: "negate", value: "true" });
		}
	});

	it("Q5 + Q3: a doesNotContain autoEventFilter on a linkClick lands in filter as contains + negate", () => {
		const { value } = normalizeTrigger({
			type: "linkClick",
			autoEventFilter: [{ ...contains("x"), type: "doesNotContain" }],
		});
		expect(value.filter?.[0]?.type).toBe("contains");
		expect(value.filter?.[0]?.parameter).toContainEqual({ type: "boolean", key: "negate", value: "true" });
	});
});

describe("Q6 uniqueTriggerId is server-generated", () => {
	it("Q6 it is stripped from trigger update bodies", async () => {
		const { client, calls } = getPutClient(linkClickTrigger);
		await updateTrigger(client, TRIGGER_PATH, { name: "x" });
		expect(calls[1]?.body).not.toHaveProperty("uniqueTriggerId");
	});

	it("Q6 it is stripped from create bodies and from patches", () => {
		expect(normalizeTrigger({ name: "t", uniqueTriggerId: { type: "template" } }).value).not.toHaveProperty(
			"uniqueTriggerId",
		);
		expect(stripServerFields(linkClickTrigger)).not.toHaveProperty("uniqueTriggerId");
	});
});

describe("Q7 omitted list vs empty list", () => {
	it("Q7 normalizeConditions keeps undefined apart from []", () => {
		expect(normalizeConditions(undefined)).toBeUndefined();
		expect(normalizeConditions([])).toEqual([]);
	});

	// Matrix of condition presence on update: omitted, empty, and provided filters.
	const fields = ["filter", "autoEventFilter", "customEventFilter", "parameter"] as const;
	for (const field of fields) {
		for (const mode of ["omitted", "clear", "replace"] as const) {
			it(`Q7 updateTrigger ${field}/${mode}`, async () => {
				const { client, calls } = getPutClient(customEventTrigger);
				const patch: TriggerInput = { name: "test" };
				if (mode !== "omitted") {
					if (field === "parameter")
						patch.parameter = mode === "clear" ? [] : [{ type: "template", key: "new", value: "new" }];
					else patch[field] = mode === "clear" ? [] : [{ type: "contains" }];
				}
				await updateTrigger(client, TRIGGER_PATH, patch);
				expect(calls[1]?.url.searchParams.get("fingerprint")).toBe(customEventTrigger.fingerprint);
				const sent = sentBody<Record<string, unknown>>(calls, 1);
				for (const key of fields) {
					const stored = customEventTrigger[key];
					if (key !== field || mode === "omitted") expect(sent[key], key).toEqual(stored);
					else if (mode === "clear") expect(sent[key], key).toEqual([]);
					else expect(sent[key], key).toEqual(patch[field]);
				}
			});
		}
	}

	it("Q7 tag lists: [] clears firing triggers, setup and teardown; omitted keeps them", () => {
		const cleared = mergeForUpdate<Tag>(ga4EventTag, { firingTriggerId: [], setupTag: [], teardownTag: [] });
		expect(cleared.firingTriggerId).toEqual([]);
		expect(cleared.setupTag).toEqual([]);
		expect(mergeForUpdate<Tag>(ga4EventTag, {}).blockingTriggerId).toEqual(["35"]);
	});

	it("Q7 variable parameter: [] clears, omitted keeps", () => {
		expect(mergeForUpdate<Variable>(dlvVariable, { parameter: [] }).parameter).toEqual([]);
		expect(mergeForUpdate<Variable>(dlvVariable, {}).parameter).toEqual(dlvVariable.parameter);
	});
});

describe("Q8 template update fingerprint (unverified)", () => {
	it("Q8 our generic update path never puts the fingerprint in the body", () => {
		expect(prepareUpdate({ templateId: "1", fingerprint: "f" }, {}).body).toEqual({ templateId: "1" });
	});
	it.todo("Q8 verify against the sandbox whether templates.update needs the fingerprint in the body");
});

describe("Q9 workspace edits are not live until published", () => {
	it("Q9 the note tells the model how to make a change live", () => {
		expect(UNPUBLISHED_CHANGES_NOTE).toMatch(/not live/);
		expect(UNPUBLISHED_CHANGES_NOTE).toContain("create_version");
		expect(UNPUBLISHED_CHANGES_NOTE).toContain("GTM UI");
		expect(UNPUBLISHED_CHANGES_NOTE).toContain("publish_version, only with the user's go-ahead");
	});
});

describe("Q10 filter and autoEventFilter both given", () => {
	it("Q10 autoEventFilter is appended to filter, not dropped", () => {
		const { value } = normalizeTrigger({
			type: "linkClick",
			filter: [contains("a")],
			autoEventFilter: [contains("b")],
		});
		expect(value.filter).toEqual([contains("a"), contains("b")]);
		expect(value).not.toHaveProperty("autoEventFilter");
	});

	it("Q10 update without filter: autoEventFilter is appended to the stored filter, not replacing it", async () => {
		const stored: Trigger = { ...linkClickTrigger, type: "click", filter: [contains("/blog")] };
		const { client, calls } = getPutClient(stored);
		const { warnings } = await updateTrigger(client, TRIGGER_PATH, { autoEventFilter: [contains(".pdf")] });
		expect(sentBody<Trigger>(calls, 1).filter).toEqual([contains("/blog"), contains(".pdf")]);
		expect(warnings).toEqual([AUTO_EVENT_FILTER_WARNING]);
		expect(AUTO_EVENT_FILTER_WARNING).toMatch(/appended to the existing filter/);
	});

	it("Q10 update with filter: autoEventFilter is appended to the patch's filter ([] replaces the stored one)", async () => {
		const stored: Trigger = { ...linkClickTrigger, filter: [contains("/blog")] };
		const { client, calls } = getPutClient(stored);
		await updateTrigger(client, TRIGGER_PATH, { filter: [], autoEventFilter: [contains(".pdf")] });
		expect(sentBody<Trigger>(calls, 1).filter).toEqual([contains(".pdf")]);
	});
});

describe("Q11 companions on update", () => {
	it("Q11 stored companion values are kept when the remap happens on update", async () => {
		const { client, calls } = getPutClient(linkClickTrigger);
		await updateTrigger(client, TRIGGER_PATH, { autoEventFilter: [contains("x")] });
		const body = sentBody<Trigger>(calls, 1);
		expect(body.waitForTags).toEqual({ type: "boolean", value: "true" });
		expect(body.waitForTagsTimeout).toEqual({ type: "integer", value: "1500" });
	});

	it("Q11 a stored click trigger gets no companions on update", async () => {
		const { waitForTags: _a, checkValidation: _b, waitForTagsTimeout: _c, ...bare } = linkClickTrigger;
		const { client, calls } = getPutClient({ ...bare, type: "click" });
		await updateTrigger(client, TRIGGER_PATH, { autoEventFilter: [contains("x")] });
		const body = sentBody<Trigger>(calls, 1);
		expect(body.filter).toEqual([...(linkClickTrigger.filter ?? []), contains("x")]);
		expect(body).not.toHaveProperty("waitForTags");
		expect(body).not.toHaveProperty("checkValidation");
		expect(body).not.toHaveProperty("waitForTagsTimeout");
	});

	it("Q11 missing companions are filled in on update", async () => {
		const { waitForTags: _a, checkValidation: _b, waitForTagsTimeout: _c, ...bare } = linkClickTrigger;
		const { client, calls } = getPutClient(bare);
		await updateTrigger(client, TRIGGER_PATH, { autoEventFilter: [contains("x")] });
		const body = sentBody<Trigger>(calls, 1);
		expect(body.waitForTags).toEqual({ type: "boolean", value: "false" });
		expect(body.checkValidation).toEqual({ type: "boolean", value: "false" });
		expect(body.waitForTagsTimeout).toEqual({ type: "integer", value: "2000" });
	});
});

describe("Q12 notes: empty string clears, omitted keeps", () => {
	for (const [name, update, path, stored] of [
		["tag", updateTag, TAG_PATH, ga4EventTag],
		["trigger", updateTrigger, TRIGGER_PATH, linkClickTrigger],
		["variable", updateVariable, VARIABLE_PATH, dlvVariable],
	] as const) {
		it(`Q12 ${name}: omitted notes are preserved`, async () => {
			const { client, calls } = getPutClient(stored);
			await update(client, path, { name: "New" });
			expect(sentBody<{ notes?: string }>(calls, 1).notes).toBe(stored.notes);
		});
		it(`Q12 ${name}: "" is sent explicitly and clears the notes`, async () => {
			const { client, calls } = getPutClient(stored);
			await update(client, path, { notes: "" });
			expect(calls[1]?.body).toHaveProperty("notes", "");
		});
	}
});

describe("Q13 parentFolderId survives updates", () => {
	for (const [name, update, path, stored] of [
		["tag", updateTag, TAG_PATH, ga4EventTag],
		["trigger", updateTrigger, TRIGGER_PATH, linkClickTrigger],
		["variable", updateVariable, VARIABLE_PATH, dlvVariable],
	] as const) {
		it(`Q13 ${name}: an update that doesn't mention the folder keeps it`, async () => {
			const { client, calls } = getPutClient(stored);
			await update(client, path, { name: "New" });
			expect(calls[1]?.body).toHaveProperty("parentFolderId", "9");
		});
	}
});

describe("Q14 consent settings shape", () => {
	it("Q14 needed + types → list of template parameters", () => {
		expect(buildConsentSettings("needed", ["ad_storage", " analytics_storage ", ""])).toEqual({
			consentStatus: "needed",
			consentType: {
				type: "list",
				list: [
					{ type: "template", value: "ad_storage" },
					{ type: "template", value: "analytics_storage" },
				],
			},
		});
	});

	it("Q14 notSet / notNeeded carry no consent types", () => {
		expect(buildConsentSettings("notNeeded", ["ad_storage"])).toEqual({ consentStatus: "notNeeded" });
		expect(buildConsentSettings("notSet")).toEqual({ consentStatus: "notSet" });
	});

	const neededTag: Tag = {
		...ga4EventTag,
		consentSettings: buildConsentSettings("needed", ["ad_storage", "analytics_storage"]),
	};

	it('Q14 update: consentStatus "needed" without consentTypes keeps the stored types', async () => {
		const { client, calls } = getPutClient(neededTag);
		await updateTag(client, TAG_PATH, { consentStatus: "needed" });
		expect(sentBody<Tag>(calls, 1).consentSettings).toEqual(neededTag.consentSettings);
	});

	it('Q14 update: consentTypes alone replace the types when the stored status is "needed"', async () => {
		const { client, calls } = getPutClient(neededTag);
		await updateTag(client, TAG_PATH, { consentTypes: ["ad_user_data"] });
		expect(sentBody<Tag>(calls, 1).consentSettings).toEqual(buildConsentSettings("needed", ["ad_user_data"]));
	});

	it('Q14 update: consentTypes alone on a tag not stored as "needed" is refused before the PUT', async () => {
		const { client, calls } = getPutClient(ga4EventTag);
		await expect(updateTag(client, TAG_PATH, { consentTypes: ["ad_storage"] })).rejects.toThrow(
			'consentTypes needs consentStatus: "needed" (the stored consent status is "notNeeded").',
		);
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("Q14 update: a status other than needed drops the stored types", async () => {
		const { client, calls } = getPutClient(neededTag);
		await updateTag(client, TAG_PATH, { consentStatus: "notNeeded" });
		expect(sentBody<Tag>(calls, 1).consentSettings).toEqual({ consentStatus: "notNeeded" });
	});

	it("Q14 create: consentTypes without consentStatus is refused before the POST", async () => {
		const { client, calls } = testClient((call) => json(200, call.body));
		await expect(
			createTag(client, WORKSPACE, { name: "t", type: "html", consentTypes: ["ad_storage"] }),
		).rejects.toThrow('consentTypes needs consentStatus: "needed".');
		expect(calls).toHaveLength(0);
	});
});

describe("Q15 Data Layer Variable defaultValue", () => {
	const emptyIntDefault = { type: "integer" as const, key: "defaultValue", value: "" };

	it("Q15 an empty integer defaultValue on a DLV is sent as an empty template", () => {
		const { value, warnings } = normalizeVariable({ name: "DLV", type: "v", parameter: [emptyIntDefault] });
		expect(value.parameter).toEqual([{ type: "template", key: "defaultValue", value: "" }]);
		expect(warnings).toEqual([DLV_DEFAULT_VALUE_WARNING]);
	});

	it("Q15 non-DLV variables and non-empty integers are left alone", () => {
		expect(normalizeVariable({ type: "c", parameter: [emptyIntDefault] }).value.parameter).toEqual([emptyIntDefault]);
		const intDefault = { ...emptyIntDefault, value: "0" };
		expect(normalizeVariable({ type: "v", parameter: [intDefault] }).value.parameter).toEqual([intDefault]);
	});

	it("Q15 update uses the stored type, and createVariable applies the fix", async () => {
		const u = getPutClient(dlvVariable);
		await updateVariable(u.client, VARIABLE_PATH, { parameter: [emptyIntDefault] });
		expect(sentBody<Variable>(u.calls, 1).parameter?.[0]?.type).toBe("template");

		const c = testClient((call) => json(200, call.body));
		const { warnings } = await createVariable(c.client, WORKSPACE, {
			name: "DLV",
			type: "v",
			parameter: [emptyIntDefault],
		});
		expect(sentBody<Variable>(c.calls, 0).parameter?.[0]?.type).toBe("template");
		expect(warnings).toEqual([DLV_DEFAULT_VALUE_WARNING]);
	});
});

describe("Q16 retry policy", () => {
	it("Q16 a plain permission 403 is not retried; a rate-limit 403 is", async () => {
		const plain = testClient([json(403, errors.forbidden403), json(200, {})]);
		await expect(plain.client.request("GET", "accounts")).rejects.toMatchObject({ kind: "permission" });
		expect(plain.calls).toHaveLength(1);

		const limited = testClient([json(403, errors.rateLimit403), json(200, {})]);
		await expect(limited.client.request("GET", "accounts")).resolves.toEqual({});
		expect(limited.calls).toHaveLength(2);
	});
});

describe("Q17 error detail is trimmed", () => {
	it("Q17 Google's duplicate errors[] message is shown once, generic messages not at all", async () => {
		const dup = testClient([json(400, errors.duplicateName400)]);
		const e = await dup.client.request("GET", "accounts").catch((x: Error) => x);
		expect(String(e)).toContain("duplicate name");
		expect(String(e).match(/duplicate name/g)).toHaveLength(1);

		const generic = testClient([json(404, errors.notFound404)]);
		const g = await generic.client.request("GET", TAG_PATH).catch((x: Error) => x);
		expect(String(g)).not.toContain("Google says");
	});
});

describe("Q18 list endpoints paginate", () => {
	it("Q18 tags are read from every page, not just the first", async () => {
		const { client } = testClient([
			json(200, { tag: [{ tagId: "1" }], nextPageToken: "n" }),
			json(200, { tag: [{ tagId: "2" }] }),
		]);
		const ws = accounts.containers.workspaces;
		const { items } = await listAll(
			(pageToken) => ws.tags.list(client, { parent: WORKSPACE, pageToken }),
			(p) => p.tag,
		);
		expect(items.map((t) => t.tagId)).toEqual(["1", "2"]);
	});
});

describe("Q20 create_version can succeed without a version", () => {
	it("Q20 each failure shape has its own message", () => {
		expect(createVersionProblem({})).toMatch(/no changes/);
		expect(createVersionProblem(undefined)).toMatch(/no changes/);
		expect(createVersionProblem({ compilerError: true })).toMatch(/compile/);
		expect(createVersionProblem({ syncStatus: { mergeConflict: true } })).toMatch(/merge conflicts/);
		expect(createVersionProblem({ syncStatus: { syncError: true } })).toMatch(/sync/);
	});

	it("Q20 a created version is not a problem", () => {
		expect(createVersionProblem({ containerVersion: { containerVersionId: "12" } })).toBeUndefined();
	});
});

describe("generic get-merge-put", () => {
	it("passes the stored entity to normalize and returns its warnings", async () => {
		const seen: unknown[] = [];
		const { result, warnings } = await getMergePut<Tag, Partial<Tag>>({
			path: TAG_PATH,
			patch: { name: "b" },
			get: async () => ({ name: "a", fingerprint: "f", notes: "keep" }),
			put: async (body, fingerprint) => ({ ...body, fingerprint: `${fingerprint}+1` }),
			normalize: (patch, current) => {
				seen.push(current);
				return { value: patch, warnings: ["w"] };
			},
		});
		expect(seen).toEqual([{ name: "a", fingerprint: "f", notes: "keep" }]);
		expect(result).toEqual({ name: "b", notes: "keep", fingerprint: "f+1" });
		expect(warnings).toEqual(["w"]);
	});

	it("createTag strips server-only fields from the body", async () => {
		const { client, calls } = testClient((call) => json(200, call.body));
		await createTag(client, WORKSPACE, { name: "t", type: "html", fingerprint: "x" });
		expect(calls[0]?.body).toEqual({ name: "t", type: "html" });
	});
});
