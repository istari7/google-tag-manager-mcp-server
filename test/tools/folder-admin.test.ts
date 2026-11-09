// The folder-admin group: get_folder, update_folder (get-merge-put), get_folder_entities.

import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { folder } from "../fixtures/gtm";
import { byMethod, callTool, describeCall, mockGtm, pages, reply, WORKSPACE, WORKSPACE_ARGS, writes } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const FOLDER = `${WORKSPACE}/folders/9`;
const ARGS = { ...WORKSPACE_ARGS, folderId: "9" };

describe("get_folder", () => {
	it("GETs the folder, fingerprint included", async () => {
		const mock = mockGtm({ [FOLDER]: reply({ ...folder, notes: "Ads" }) });
		const result = await callTool("get_folder", ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: FOLDER, query: {} }]);
		expect(result.json()).toMatchObject({
			folderId: "9",
			name: "Marketing",
			notes: "Ads",
			fingerprint: folder.fingerprint,
		});
	});
});

describe("update_folder", () => {
	it("Q1/Q2: GETs, then PUTs the whole merged folder with ?fingerprint=", async () => {
		const stored = { ...folder, notes: "Ads" };
		const mock = mockGtm({
			[FOLDER]: byMethod({ GET: reply(stored), PUT: reply({ ...stored, name: "Paid media" }) }),
		});
		const result = await callTool("update_folder", { ...ARGS, name: "Paid media", fingerprint: folder.fingerprint });
		const calls = mock.gtm().map(describeCall);
		expect(calls).toMatchObject([
			{ method: "GET", path: FOLDER },
			{ method: "PUT", path: FOLDER, query: { fingerprint: folder.fingerprint } },
		]);
		expect(calls[1]?.body).toEqual({ folderId: "9", name: "Paid media", notes: "Ads", path: FOLDER });
		expect(result.json()).toEqual({
			folder: { folderId: "9", name: "Paid media", notes: "Ads" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm({ [FOLDER]: byMethod({ GET: reply(folder) }) });
		const result = await callTool("update_folder", { ...ARGS, notes: "x", fingerprint: "1" });
		expect(result.isError).toBe(true);
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("update_folder", ARGS);
		expect(result).toMatchObject({ isError: true, text: "Nothing to change: pass name and/or notes." });
		expect(mock.calls).toHaveLength(0);
	});
});

describe("get_folder_entities", () => {
	it("POSTs {folder}:entities across pages (a read) and lists ID, name and type", async () => {
		const mock = mockGtm({
			[`${FOLDER}:entities`]: pages("tag", [
				[{ tagId: "12", name: "GA4", type: "gaawe", parameter: [] }],
				[{ tagId: "13", name: "HTML", type: "html" }],
			]),
		});
		const result = await callTool("get_folder_entities", ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${FOLDER}:entities`, query: {} },
			{ method: "POST", path: `${FOLDER}:entities`, query: { pageToken: "p2" } },
		]);
		expect(result.json()).toEqual({
			tags: [
				{ tagId: "12", name: "GA4", type: "gaawe" },
				{ tagId: "13", name: "HTML", type: "html" },
			],
			triggers: [],
			variables: [],
		});
	});
});
