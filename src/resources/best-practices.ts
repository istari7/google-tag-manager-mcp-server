// gtm://best-practices (index) and gtm://best-practices/{topic}. Every docs/best-practices/*.md
// is a topic: its frontmatter (title, description, order) is read at build time by
// `pnpm gen:skills` into src/skills/generated.ts, and the body is bundled as a Text
// module. Adding a topic is adding a file plus `pnpm gen:skills`; no code changes.

import { type McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { BEST_PRACTICES, BEST_PRACTICES_INDEX } from "../skills/generated";
import type { DocEntry } from "../skills/types";

export const BEST_PRACTICES_URI = "gtm://best-practices";
export const MARKDOWN = "text/markdown";

/** Topics by name, in listing order. */
export const TOPICS: Readonly<Record<string, DocEntry>> = Object.fromEntries(BEST_PRACTICES.map((t) => [t.name, t]));

export const topicUri = (name: string) => `${BEST_PRACTICES_URI}/${name}`;

/** The index body with `{{topics}}` replaced by one line per topic. */
export const BEST_PRACTICES_INDEX_TEXT = BEST_PRACTICES_INDEX.text.replace(
	"{{topics}}",
	BEST_PRACTICES.map((t) => `- **${t.name}** (\`${topicUri(t.name)}\`): ${t.description}`).join("\n"),
);

export function markdown(uri: string, text: string) {
	return { contents: [{ uri, mimeType: MARKDOWN, text }] };
}

export function registerBestPractices(server: McpServer): void {
	server.registerResource(
		"best-practices",
		BEST_PRACTICES_URI,
		{ title: BEST_PRACTICES_INDEX.title, description: BEST_PRACTICES_INDEX.description, mimeType: MARKDOWN },
		(uri) => markdown(uri.href, BEST_PRACTICES_INDEX_TEXT),
	);

	const names = Object.keys(TOPICS);
	server.registerResource(
		"best-practices-topic",
		new ResourceTemplate(`${BEST_PRACTICES_URI}/{topic}`, {
			list: () => ({
				resources: BEST_PRACTICES.map((t) => ({
					uri: topicUri(t.name),
					name: `best-practices-${t.name}`,
					title: t.title,
					description: t.description,
					mimeType: MARKDOWN,
				})),
			}),
			complete: { topic: (value) => names.filter((n) => n.startsWith(value)) },
		}),
		{ title: "GTM best-practice topic", description: `One topic: ${names.join(", ")}.`, mimeType: MARKDOWN },
		(uri, variables) => {
			const name = variables.topic;
			const topic = typeof name === "string" ? TOPICS[name] : undefined;
			if (!topic) throw new ResourceNotFoundError(uri.href, `Unknown topic. Topics: ${names.join(", ")}.`);
			return markdown(uri.href, topic.text);
		},
	);
}
