// list/get/create/update/delete_template, import_gallery_template.

import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { templateInfo, templateType } from "../../src/tools/templates";
import {
	byMethod,
	CONTAINER_ID,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	pages,
	reply,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const TEMPLATE = `${WORKSPACE}/templates/12`;

/** A trimmed-down .tpl file: the sections GTM exports, CRLF line endings as Windows editors save them. */
const tpl = (type: string, displayName: string) =>
	[
		"___TERMS_OF_SERVICE___",
		"",
		"By creating or modifying this file you agree to the Terms of Service.",
		"",
		"___INFO___",
		"",
		JSON.stringify({ type, id: "cvt_temp_public_id", version: 1, displayName, containerContexts: ["WEB"] }, null, 2),
		"",
		"___TEMPLATE_PARAMETERS___",
		"",
		"[]",
		"",
		"___SANDBOXED_JS_FOR_WEB_TEMPLATE___",
		"",
		"data.gtmOnSuccess();",
	].join("\r\n");

const custom = {
	accountId: "1234567890",
	containerId: CONTAINER_ID,
	workspaceId: "7",
	templateId: "12",
	name: "My Pixel",
	path: TEMPLATE,
	fingerprint: "100",
	tagManagerUrl: "https://tagmanager.google.com/#/x",
	templateData: tpl("TAG", "My Pixel"),
};

const gallery = {
	containerId: CONTAINER_ID,
	templateId: "13",
	name: "Cookie banner",
	path: `${WORKSPACE}/templates/13`,
	fingerprint: "200",
	templateData: tpl("TAG", "Cookie Banner by Example"),
	galleryReference: {
		host: "github.com",
		owner: "example",
		repository: "gtm-cookie-banner",
		version: "abc1234",
		galleryTemplateId: "K7TQD",
		isModified: false,
		signature: "sig",
	},
};

describe("template helpers", () => {
	it("templateInfo reads what the template is for and displayName from ___INFO___ (LF or CRLF), and nothing from junk", () => {
		expect(templateInfo(tpl("MACRO", "Lookup"))).toEqual({ for: "variable", displayName: "Lookup" });
		expect(templateInfo(tpl("CLIENT", "C").replaceAll("\r\n", "\n"))).toEqual({ for: "client", displayName: "C" });
		expect(templateInfo(undefined)).toEqual({});
		expect(templateInfo("no sections at all")).toEqual({});
		expect(templateInfo("___INFO___\n{not json\n___TEMPLATE_PARAMETERS___\n")).toEqual({});
	});

	it("templateType: cvt_<containerId>_<templateId>, or cvt_<galleryTemplateId> for gallery imports", () => {
		expect(templateType(custom)).toBe(`cvt_${CONTAINER_ID}_12`);
		expect(templateType({ templateId: "12", path: TEMPLATE })).toBe(`cvt_${CONTAINER_ID}_12`);
		expect(templateType(gallery)).toBe("cvt_K7TQD");
		expect(templateType({ name: "x" })).toBeUndefined();
	});
});

describe("list_templates", () => {
	it("GETs {workspace}/templates across pages; rows say what each template is for and its type, never the code", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/templates`]: pages("template", [[custom], [gallery]]) });
		const result = await callTool("list_templates", WORKSPACE_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: `${WORKSPACE}/templates`, query: {} },
			{ method: "GET", path: `${WORKSPACE}/templates`, query: { pageToken: "p2" } },
		]);
		expect(result.json()).toEqual({
			templates: [
				{ templateId: "12", name: "My Pixel", for: "tag", type: `cvt_${CONTAINER_ID}_12` },
				{
					templateId: "13",
					name: "Cookie banner",
					displayName: "Cookie Banner by Example",
					for: "tag",
					type: "cvt_K7TQD",
					gallery: { owner: "example", repository: "gtm-cookie-banner", version: "abc1234" },
				},
			],
		});
		expect(result.text).not.toContain("SANDBOXED_JS");
	});
});

describe("get_template", () => {
	it("GETs the template: code, fingerprint, what it is for and type", async () => {
		const mock = mockGtm({ [TEMPLATE]: reply(custom) });
		const result = await callTool("get_template", { ...WORKSPACE_ARGS, templateId: "12" });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: TEMPLATE }]);
		const { tagManagerUrl: _url, ...expected } = custom;
		expect(result.json()).toEqual({ ...expected, for: "tag", type: `cvt_${CONTAINER_ID}_12` });
	});

	it("includeTemplateData: false leaves the code out and gives its length", async () => {
		mockGtm({ [TEMPLATE]: reply(custom) });
		const result = await callTool("get_template", { ...WORKSPACE_ARGS, templateId: "12", includeTemplateData: false });
		const body = result.json();
		expect(body).not.toHaveProperty("templateData");
		expect(body).toMatchObject({
			templateId: "12",
			fingerprint: "100",
			templateDataLength: custom.templateData.length,
		});
	});

	it("refuses a non-numeric templateId before any request", async () => {
		const mock = mockGtm({});
		const result = await callTool("get_template", { ...WORKSPACE_ARGS, templateId: "../tags/1" });
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("create_template", () => {
	it("POSTs {workspace}/templates with exactly name and templateData; the result has no code", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/templates`]: byMethod({ POST: () => json(custom) }) });
		const result = await callTool("create_template", {
			...WORKSPACE_ARGS,
			name: "My Pixel",
			templateData: custom.templateData,
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{
				method: "POST",
				path: `${WORKSPACE}/templates`,
				body: { name: "My Pixel", templateData: custom.templateData },
			},
		]);
		expect(result.json()).toEqual({
			template: { templateId: "12", name: "My Pixel", for: "tag", type: `cvt_${CONTAINER_ID}_12`, fingerprint: "100" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});
});

describe("update_template", () => {
	it("Q1/Q8: GET, then PUT of the whole template with the stored fingerprint as ?fingerprint= and in the body", async () => {
		const mock = mockGtm({
			[TEMPLATE]: byMethod({
				GET: () => json(custom),
				PUT: (call) => json({ ...JSON.parse(call.body), fingerprint: "101" }),
			}),
		});
		const result = await callTool("update_template", { ...WORKSPACE_ARGS, templateId: "12", name: "Renamed" });
		const [get, put] = mock.gtm().map(describeCall);
		expect(get).toMatchObject({ method: "GET", path: TEMPLATE });
		expect(put).toMatchObject({ method: "PUT", path: TEMPLATE, query: { fingerprint: "100" } });
		expect(put?.body).toEqual({ ...custom, name: "Renamed" });
		expect(result.json()).toMatchObject({
			template: { name: "Renamed", fingerprint: "101" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm({ [TEMPLATE]: byMethod({ GET: () => json(custom) }) });
		const result = await callTool("update_template", {
			...WORKSPACE_ARGS,
			templateId: "12",
			templateData: "x",
			fingerprint: "99",
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Changed by someone else");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an update with nothing to change, before any request", async () => {
		const mock = mockGtm({});
		const result = await callTool("update_template", { ...WORKSPACE_ARGS, templateId: "12", fingerprint: "100" });
		expect(result.isError).toBe(true);
		expect(result.text).toBe("Nothing to update: pass name or templateData.");
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("delete_template", () => {
	it("without confirm: true previews, listing the tags and variables of the template's type", async () => {
		const type = `cvt_${CONTAINER_ID}_12`;
		const mock = mockGtm({
			[TEMPLATE]: byMethod({ GET: () => json(custom) }),
			[`${WORKSPACE}/tags`]: pages("tag", [
				[
					{ tagId: "5", name: "Pixel - all pages", type },
					{ tagId: "6", name: "GA4", type: "gaawe" },
				],
			]),
			[`${WORKSPACE}/variables`]: pages("variable", [[{ variableId: "8", name: "Other", type: "cvt_1_1" }]]),
		});
		const result = await callTool("delete_template", { ...WORKSPACE_ARGS, templateId: "12" });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			wouldDelete: {
				kind: "template",
				templateId: "12",
				name: "My Pixel",
				for: "tag",
				type,
				usedBy: ['tag 5 "Pixel - all pages"'],
				usedByNote: "These use the template: delete or change them first.",
			},
			message:
				"Nothing was deleted. To delete this template, get the user's go-ahead, then call delete_template again with confirm: true.",
		});
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [TEMPLATE]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_template", { ...WORKSPACE_ARGS, templateId: "12", confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: TEMPLATE, body: undefined }]);
		expect(result.json()).toEqual({ deleted: { kind: "template", id: "12" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});

describe("import_gallery_template", () => {
	const URL_PATH = `${WORKSPACE}/templates:import_from_gallery`;

	it("POSTs templates:import_from_gallery with owner, repository and acknowledgePermissions=true, no body", async () => {
		const mock = mockGtm({ [URL_PATH]: byMethod({ POST: () => json(gallery) }) });
		const result = await callTool("import_gallery_template", {
			...WORKSPACE_ARGS,
			galleryOwner: "example",
			galleryRepository: "gtm-cookie-banner",
		});
		expect(mock.gtm().map(describeCall)).toEqual([
			{
				method: "POST",
				path: URL_PATH,
				query: { galleryOwner: "example", galleryRepository: "gtm-cookie-banner", acknowledgePermissions: "true" },
				body: undefined,
				auth: expect.any(String),
			},
		]);
		expect(result.json()).toMatchObject({
			template: { templateId: "13", type: "cvt_K7TQD", fingerprint: "200" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("passes gallerySha when given", async () => {
		const mock = mockGtm({ [URL_PATH]: byMethod({ POST: () => json(gallery) }) });
		await callTool("import_gallery_template", {
			...WORKSPACE_ARGS,
			galleryOwner: "example",
			galleryRepository: "gtm-cookie-banner",
			gallerySha: "0123456789abcdef0123456789abcdef01234567",
		});
		expect(describeCall(mock.gtm()[0]).query).toMatchObject({ gallerySha: "0123456789abcdef0123456789abcdef01234567" });
	});

	it.each([
		{ galleryOwner: "a/b", galleryRepository: "r" },
		{ galleryOwner: "o", galleryRepository: "r&x=1" },
		{ galleryOwner: "o", galleryRepository: "r", gallerySha: "main" },
	])("refuses %o before any request", async (args) => {
		const mock = mockGtm({});
		const result = await callTool("import_gallery_template", { ...WORKSPACE_ARGS, ...args });
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});
