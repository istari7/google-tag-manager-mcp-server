// gtm://best-practices (index) and gtm://best-practices/{topic}. The text
// comes from docs/best-practices/*.md, bundled as Text modules (`rules` in wrangler.jsonc).

import { type McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import consentMode from "../../docs/best-practices/consent-mode.md";
import dataLayer from "../../docs/best-practices/data-layer.md";
import index from "../../docs/best-practices/index.md";
import naming from "../../docs/best-practices/naming.md";
import publishing from "../../docs/best-practices/publishing.md";
import tags from "../../docs/best-practices/tags.md";
import triggers from "../../docs/best-practices/triggers.md";
import variables from "../../docs/best-practices/variables.md";

export const BEST_PRACTICES_URI = "gtm://best-practices";
const MIME = "text/markdown";

export interface Topic {
	title: string;
	description: string;
	text: string;
}

export const TOPICS: Readonly<Record<string, Topic>> = {
	publishing: {
		title: "Publishing workflow and safety",
		description: "Workspace → review → version; a person publishes in the GTM UI. Rollback.",
		text: publishing,
	},
	naming: {
		title: "Naming and organisation",
		description: "Naming pattern for tags, triggers and variables; folders; orphan cleanup.",
		text: naming,
	},
	tags: { title: "Tags", description: "GA4 tag structure, firing options, custom HTML, duplicates.", text: tags },
	triggers: {
		title: "Triggers",
		description: "Choosing trigger types and writing conditions (filter vs autoEventFilter, negate).",
		text: triggers,
	},
	variables: {
		title: "Variables",
		description: "Which variable type to use; data layer, constants, lookup tables, custom JavaScript.",
		text: variables,
	},
	"data-layer": {
		title: "Data layer",
		description: "dataLayer.push conventions, ecommerce, what to ask the site developer for.",
		text: dataLayer,
	},
	"consent-mode": {
		title: "Consent Mode v2",
		description: "CMP on Consent Initialization, defaults, per-tag consent settings, audit rules.",
		text: consentMode,
	},
};

function markdown(uri: string, text: string) {
	return { contents: [{ uri, mimeType: MIME, text }] };
}

export function registerBestPractices(server: McpServer): void {
	server.registerResource(
		"best-practices",
		BEST_PRACTICES_URI,
		{
			title: "GTM best practices (index)",
			description: "Start here: which best-practice topic to read before creating or editing anything.",
			mimeType: MIME,
		},
		(uri) => markdown(uri.href, index),
	);

	const names = Object.keys(TOPICS);
	server.registerResource(
		"best-practices-topic",
		new ResourceTemplate(`${BEST_PRACTICES_URI}/{topic}`, {
			list: () => ({
				resources: Object.entries(TOPICS).map(([name, t]) => ({
					uri: `${BEST_PRACTICES_URI}/${name}`,
					name: `best-practices-${name}`,
					title: t.title,
					description: t.description,
					mimeType: MIME,
				})),
			}),
			complete: { topic: (value) => names.filter((n) => n.startsWith(value)) },
		}),
		{ title: "GTM best-practice topic", description: `One topic: ${names.join(", ")}.`, mimeType: MIME },
		(uri, variables) => {
			const name = variables.topic;
			const topic = typeof name === "string" ? TOPICS[name] : undefined;
			if (!topic) throw new ResourceNotFoundError(uri.href, `Unknown topic. Topics: ${names.join(", ")}.`);
			return markdown(uri.href, topic.text);
		},
	);
}
