// gtm://best-practices resources, served from docs/best-practices/*.md (discovered by
// `pnpm gen:skills`; the frontmatter is metadata and never served).

import { describe, expect, it } from "vitest";
import { BEST_PRACTICES_INDEX_TEXT, BEST_PRACTICES_URI, TOPICS } from "../src/resources/best-practices";
import { rpc } from "./tools/helpers";

interface ReadResult {
	contents: Array<{ uri: string; mimeType: string; text: string }>;
}

async function read(uri: string) {
	return rpc("resources/read", { uri });
}

describe("best-practices resources", () => {
	it("lists the index and every topic", async () => {
		const { result } = await rpc("resources/list");
		const uris = (result as { resources: Array<{ uri: string; mimeType: string }> }).resources
			.map((r) => r.uri)
			.filter((uri) => uri.startsWith(BEST_PRACTICES_URI));
		expect(uris).toEqual([BEST_PRACTICES_URI, ...Object.keys(TOPICS).map((t) => `${BEST_PRACTICES_URI}/${t}`)]);
		expect(Object.keys(TOPICS)).toEqual([
			"publishing",
			"naming",
			"tags",
			"triggers",
			"variables",
			"data-layer",
			"consent-mode",
		]);
	});

	it("advertises the {topic} template", async () => {
		const { result } = await rpc("resources/templates/list");
		expect((result as { resourceTemplates: unknown[] }).resourceTemplates).toContainEqual(
			expect.objectContaining({ uriTemplate: "gtm://best-practices/{topic}", mimeType: "text/markdown" }),
		);
	});

	it("serves the index, which links every topic and only real topics", async () => {
		const { result } = await read(BEST_PRACTICES_URI);
		const [content] = (result as ReadResult).contents;
		expect(content).toMatchObject({ uri: BEST_PRACTICES_URI, mimeType: "text/markdown" });
		const text = content?.text ?? "";
		expect(text.startsWith("# GTM best practices")).toBe(true);
		const linked = [...text.matchAll(/gtm:\/\/best-practices\/([a-z-]+)/g)].map((m) => m[1]);
		expect(new Set(linked)).toEqual(new Set(Object.keys(TOPICS)));
		expect(text).toBe(BEST_PRACTICES_INDEX_TEXT);
		expect(text).not.toContain("{{topics}}");
		expect(text).toContain(`(\`${BEST_PRACTICES_URI}/naming\`): ${TOPICS.naming?.description}`);
	});

	it.each(Object.keys(TOPICS))("serves %s as concise markdown", async (topic) => {
		const uri = `${BEST_PRACTICES_URI}/${topic}`;
		const { result } = await read(uri);
		const [content] = (result as ReadResult).contents;
		expect(content?.uri).toBe(uri);
		expect(content?.text).toMatch(/^# \S/);
		expect(content?.text).not.toContain("<!--");
		expect(content?.text).not.toMatch(/^---/);
		expect(content?.text).not.toContain("THIS SOFTWARE IS PROVIDED");
		// Concise: detail, not essays.
		expect(content?.text.length).toBeLessThan(4000);
	});

	const docs: Array<[string, string]> = [
		["index", BEST_PRACTICES_INDEX_TEXT],
		...Object.entries(TOPICS).map(([n, t]): [string, string] => [n, t.text]),
	];

	it("the index and the publishing topic only publish on the user's explicit go-ahead", () => {
		expect(BEST_PRACTICES_INDEX_TEXT).toMatch(
			/Publish\s+\(`publish_version`\)\s+only\s+when\s+the\s+user\s+has\s+explicitly\s+asked/,
		);
		expect(TOPICS.publishing?.text).toMatch(/Never\s+publish\s+without\s+the\s+user's\s+explicit\s+go-ahead/);
		expect(TOPICS.publishing?.text).toContain("`confirm: true`");
	});

	it.each(docs)("%s carries no license header, attribution or third-party credit", (_name, text) => {
		expect(text).not.toContain("<!--");
		expect(text).not.toMatch(
			/copyright|licen[cs]e|\bBSD\b|adapt(s|ed)? (material )?from|attribution|upstream|inspired|github\.com/i,
		);
	});

	it("answers an unknown topic with a resource-not-found error listing the topics", async () => {
		const { error } = await read(`${BEST_PRACTICES_URI}/nope`);
		expect(error).toMatchObject({ code: -32602, message: expect.stringContaining("publishing, naming") });
	});

	it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
		"treats the Object.prototype name %o as an unknown topic",
		async (name) => {
			const { error } = await read(`${BEST_PRACTICES_URI}/${name}`);
			expect(error).toMatchObject({ code: -32602, message: expect.stringContaining("Unknown topic") });
		},
	);
});
