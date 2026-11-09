// gtm://best-practices resources, served from docs/best-practices/*.md.

import { describe, expect, it } from "vitest";
import index from "../docs/best-practices/index.md";
import { BEST_PRACTICES_URI, TOPICS } from "../src/resources/best-practices";
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
		const uris = (result as { resources: Array<{ uri: string; mimeType: string }> }).resources.map((r) => r.uri);
		expect(uris).toEqual([BEST_PRACTICES_URI, ...Object.keys(TOPICS).map((t) => `${BEST_PRACTICES_URI}/${t}`)]);
	});

	it("advertises the {topic} template", async () => {
		const { result } = await rpc("resources/templates/list");
		expect(result).toMatchObject({
			resourceTemplates: [{ uriTemplate: "gtm://best-practices/{topic}", mimeType: "text/markdown" }],
		});
	});

	it("serves the index, which links every topic and only real topics", async () => {
		const { result } = await read(BEST_PRACTICES_URI);
		const [content] = (result as ReadResult).contents;
		expect(content).toMatchObject({ uri: BEST_PRACTICES_URI, mimeType: "text/markdown" });
		const text = content?.text ?? "";
		expect(text.startsWith("# GTM best practices")).toBe(true);
		const linked = [...text.matchAll(/gtm:\/\/best-practices\/([a-z-]+)/g)].map((m) => m[1]);
		expect(new Set(linked)).toEqual(new Set(Object.keys(TOPICS)));
	});

	it.each(Object.keys(TOPICS))("serves %s as concise markdown", async (topic) => {
		const uri = `${BEST_PRACTICES_URI}/${topic}`;
		const { result } = await read(uri);
		const [content] = (result as ReadResult).contents;
		expect(content?.uri).toBe(uri);
		expect(content?.text).toMatch(/^# \S/);
		expect(content?.text).not.toContain("<!--");
		expect(content?.text).not.toContain("THIS SOFTWARE IS PROVIDED");
		// Concise: detail, not essays.
		expect(content?.text.length).toBeLessThan(4000);
	});

	const docs: Array<[string, string]> = [
		["index", index],
		...Object.entries(TOPICS).map(([n, t]): [string, string] => [n, t.text]),
	];

	it.each(docs)("%s never mentions a publish tool", (_name, text) => {
		// No tool publishes; only a person does, in the GTM UI.
		expect(text).not.toMatch(/\bpublish_[a-z_]+|\b[a-z_]+_publish\b|`publish`|:publish\b/i);
	});

	it("the index and the publishing topic say a person publishes in the GTM UI", () => {
		expect(index).toMatch(/person\s+has\s+to\s+publish\s+a\s+version\s+in\s+the\s+GTM\s+UI/);
		expect(TOPICS.publishing?.text).toMatch(/a\s+person\s+publishes\s+in\s+the\s+GTM\s+UI/);
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
});
