// get_tag_templates, get_trigger_templates: static guidance. Every example must be accepted by
// the real create_tag / create_trigger tool and reach Google without a quirk warning, so the
// guidance can't drift from the argument formats those tools (and GTM_API_QUIRKS.md) expect.

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTrigger } from "../../src/gtm/quirks";
import { TAG_EXAMPLES, TRIGGER_EXAMPLES } from "../../src/tools/guidance";
import { byMethod, callTool, describeCall, json, mockGtm, reply, WORKSPACE, WORKSPACE_ARGS } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Placeholder IDs such as "<trigger ID>" become real numeric IDs, as a model would fill them in. */
function fillPlaceholders<T>(args: T): T {
	return JSON.parse(JSON.stringify(args).replace(/"<[^>]*ID>"/g, '"11"')) as T;
}

/** POST route that echoes the body back with an ID, as Google does. */
const echo = (idKey: string) => byMethod({ POST: (call) => json({ ...JSON.parse(call.body), [idKey]: "99" }) });

describe("get_tag_templates", () => {
	it("returns usage rules and examples, with no GTM request", async () => {
		const mock = mockGtm({});
		const result = await callTool("get_tag_templates");
		expect(mock.gtm()).toHaveLength(0);
		const body = result.json<{ usage: string[]; examples: Array<{ arguments: { type: string } }> }>();
		expect(body.usage.length).toBeGreaterThan(0);
		expect(body.examples.map((e) => e.arguments.type)).toEqual(expect.arrayContaining(["googtag", "gaawe", "html"]));
	});

	it.each(TAG_EXAMPLES.map((e) => [e.name, e] as const))(
		"example %s is accepted by create_tag and sent unchanged",
		async (_name, example) => {
			// Q23: for GA4 / Ads / Floodlight types create_tag reads the workspace status around the POST.
			const mock = mockGtm({ [`${WORKSPACE}/tags`]: echo("tagId"), [`${WORKSPACE}/status`]: reply({}) });
			const args = fillPlaceholders(example.arguments);
			const result = await callTool("create_tag", { ...WORKSPACE_ARGS, ...args });
			expect(result.isError, result.text).toBe(false);
			expect(result.json()).not.toHaveProperty("warnings");
			const posts = mock.gtm().filter((c) => describeCall(c).method === "POST");
			expect(posts).toHaveLength(1);
			expect(describeCall(posts[0]).body).toEqual(args);
		},
	);
});

describe("get_trigger_templates", () => {
	it("returns usage rules and examples, with no GTM request", async () => {
		const mock = mockGtm({});
		const result = await callTool("get_trigger_templates");
		expect(mock.gtm()).toHaveLength(0);
		const body = result.json<{ usage: string[]; examples: Array<{ arguments: { type: string } }> }>();
		expect(body.usage.length).toBeGreaterThan(0);
		expect(body.examples.map((e) => e.arguments.type)).toEqual(
			expect.arrayContaining(["customEvent", "click", "linkClick", "formSubmission"]),
		);
	});

	it.each(TRIGGER_EXAMPLES.map((e) => [e.name, e] as const))(
		"example %s is accepted by create_trigger without a quirk warning",
		async (_name, example) => {
			const mock = mockGtm({ [`${WORKSPACE}/triggers`]: echo("triggerId") });
			const args = fillPlaceholders(example.arguments);
			const result = await callTool("create_trigger", { ...WORKSPACE_ARGS, ...args });
			expect(result.isError, result.text).toBe(false);
			expect(result.json()).not.toHaveProperty("warnings");
			// Only the Q5 negation shorthands are rewritten; everything else goes out as written.
			expect(describeCall(mock.gtm()[0]).body).toEqual(normalizeTrigger(args).value);
		},
	);

	it("no click, linkClick or formSubmission example relies on autoEventFilter (Q3)", () => {
		const clicky = TRIGGER_EXAMPLES.filter((e) => ["click", "linkClick", "formSubmission"].includes(e.arguments.type));
		expect(clicky.length).toBeGreaterThan(0);
		for (const e of clicky) expect(e.arguments.autoEventFilter, e.name).toBeUndefined();
	});

	it("companions appear only on linkClick and formSubmission examples (Q4)", () => {
		for (const e of TRIGGER_EXAMPLES) {
			if (e.arguments.waitForTags || e.arguments.checkValidation || e.arguments.waitForTagsTimeout) {
				expect(["linkClick", "formSubmission"], e.name).toContain(e.arguments.type);
			}
		}
	});
});
