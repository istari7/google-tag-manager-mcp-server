// create_folder, move_entities_to_folder (Q19), delete_folder.

import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { folder } from "../fixtures/gtm";
import {
	byMethod,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	queryAll,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("create_folder", () => {
	it("POSTs {workspace}/folders with the name and notes", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/folders`]: () => json({ folderId: "11", name: "Consent", notes: "CMP", fingerprint: "1" }),
		});
		const result = await callTool("create_folder", { ...WORKSPACE_ARGS, name: "Consent", notes: "CMP" });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${WORKSPACE}/folders`, query: {}, body: { name: "Consent", notes: "CMP" } },
		]);
		expect(result.json()).toEqual({
			folder: { folderId: "11", name: "Consent", notes: "CMP" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("refuses an empty name before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("create_folder", { ...WORKSPACE_ARGS, name: "  " })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("move_entities_to_folder", () => {
	it("Q19: POSTs {folder}:move_entities_to_folder with repeated ID query keys and an empty Folder body", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/folders/9:move_entities_to_folder`]: empty });
		const result = await callTool("move_entities_to_folder", {
			...WORKSPACE_ARGS,
			folderId: "9",
			tagId: ["12", "13"],
			variableId: ["56"],
		});
		const [call] = mock.gtm();
		expect(mock.gtm()).toHaveLength(1);
		expect(describeCall(call)).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/folders/9:move_entities_to_folder`,
			body: {},
		});
		expect(queryAll(call, "tagId")).toEqual(["12", "13"]);
		expect(queryAll(call, "variableId")).toEqual(["56"]);
		expect(queryAll(call, "triggerId")).toEqual([]);
		expect(result.json()).toEqual({
			folderId: "9",
			moved: { tagId: ["12", "13"], variableId: ["56"] },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it('Q19: folder "0" moves entities out of their folder', async () => {
		const mock = mockGtm({ [`${WORKSPACE}/folders/0:move_entities_to_folder`]: empty });
		await callTool("move_entities_to_folder", { ...WORKSPACE_ARGS, folderId: "0", triggerId: ["34"] });
		expect(describeCall(mock.gtm()[0]).path).toBe(`${WORKSPACE}/folders/0:move_entities_to_folder`);
		expect(queryAll(mock.gtm()[0], "triggerId")).toEqual(["34"]);
	});

	it("refuses an empty move and non-numeric IDs before calling Google", async () => {
		const mock = mockGtm();
		const none = await callTool("move_entities_to_folder", { ...WORKSPACE_ARGS, folderId: "9", tagId: [] });
		expect(none).toMatchObject({
			isError: true,
			text: "Nothing to move: pass at least one tagId, triggerId or variableId.",
		});
		const bad = await callTool("move_entities_to_folder", { ...WORKSPACE_ARGS, folderId: "9", tagId: ["12&x=1"] });
		expect(bad.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("delete_folder", () => {
	const FOLDER = `${WORKSPACE}/folders/9`;
	const ARGS = { ...WORKSPACE_ARGS, folderId: "9" };

	it("without confirm: true reads the folder and its contents, and changes nothing", async () => {
		const mock = mockGtm({
			[FOLDER]: byMethod({ GET: () => json(folder) }),
			[`${FOLDER}:entities`]: byMethod({
				POST: () =>
					json({
						tag: [{ tagId: "12", name: "GA4 - Event - sign_up" }],
						variable: [{ variableId: "56", name: "DLV - user_id" }],
					}),
			}),
		});
		const result = await callTool("delete_folder", ARGS);
		expect(
			mock
				.gtm()
				.map((c) => `${c.method} ${describeCall(c).path}`)
				.sort(),
		).toEqual([`GET ${FOLDER}`, `POST ${FOLDER}:entities`]);
		expect(writes(mock.gtm()).filter((c) => !c.url.includes(":entities"))).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			wouldDelete: {
				kind: "folder",
				folderId: "9",
				name: "Marketing",
				// Objects, like delete_trigger's usedByTags.
				contains: {
					tags: [{ tagId: "12", name: "GA4 - Event - sign_up" }],
					variables: [{ variableId: "56", name: "DLV - user_id" }],
				},
				containsNote: "These are kept, outside any folder.",
			},
			message:
				"Nothing was deleted. To delete this folder, get the user's go-ahead, then call delete_folder again with confirm: true.",
		});
	});

	it("with confirm: true on an empty folder sends one DELETE", async () => {
		const mock = mockGtm({
			[`${FOLDER}:entities`]: byMethod({ POST: () => json({}) }),
			[FOLDER]: byMethod({ DELETE: empty }),
		});
		const result = await callTool("delete_folder", { ...ARGS, confirm: true });
		expect(mock.gtm().map((c) => `${c.method} ${describeCall(c).path}`)).toEqual([
			`POST ${FOLDER}:entities`,
			`DELETE ${FOLDER}`,
		]);
		expect(result.json()).toEqual({ deleted: { kind: "folder", id: "9" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("Q25 with confirm: true moves the contents out (folder 0) before the DELETE", async () => {
		const MOVE = `${WORKSPACE}/folders/0:move_entities_to_folder`;
		const mock = mockGtm({
			[`${FOLDER}:entities`]: byMethod({
				POST: () => json({ tag: [{ tagId: "12", name: "T" }], variable: [{ variableId: "56", name: "V" }] }),
			}),
			[MOVE]: byMethod({ POST: empty }),
			[FOLDER]: byMethod({ DELETE: empty }),
		});
		const result = await callTool("delete_folder", { ...ARGS, confirm: true });
		const calls = mock.gtm();
		expect(calls.map((c) => `${c.method} ${describeCall(c).path}`)).toEqual([
			`POST ${FOLDER}:entities`,
			`POST ${MOVE}`,
			`DELETE ${FOLDER}`,
		]);
		expect(queryAll(calls[1], "tagId")).toEqual(["12"]);
		expect(queryAll(calls[1], "variableId")).toEqual(["56"]);
		expect(queryAll(calls[1], "triggerId")).toEqual([]);
		// The result says what was moved out, in the same object shape as the preview.
		expect(result.json()).toEqual({
			deleted: { kind: "folder", id: "9" },
			movedOutOfFolder: { tags: [{ tagId: "12", name: "T" }], variables: [{ variableId: "56", name: "V" }] },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});
});
