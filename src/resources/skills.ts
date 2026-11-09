// gtm://skills (index) and gtm://skills/{name}: the workflow guides in skills/<name>/SKILL.md,
// discovered at build time by `pnpm gen:skills` (src/skills/generated.ts). Each skill is
// also a prompt of the same name (src/skills/prompts.ts).

import { type McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { SKILLS } from "../skills/generated";
import { promptArguments } from "../skills/prompts";
import type { SkillEntry } from "../skills/types";
import { MARKDOWN, markdown } from "./best-practices";

export const SKILLS_URI = "gtm://skills";

export const skillUri = (name: string) => `${SKILLS_URI}/${name}`;

const BY_NAME: ReadonlyMap<string, SkillEntry> = new Map(SKILLS.map((s) => [s.name, s]));

export function findSkill(name: unknown): SkillEntry | undefined {
	return typeof name === "string" ? BY_NAME.get(name) : undefined;
}

/** "goals (required), accountId, …" or "none". */
function argumentList(skill: SkillEntry): string {
	const args = promptArguments(skill).map((a) => (a.required ? `${a.name} (required)` : a.name));
	return args.length ? args.join(", ") : "none";
}

export const SKILLS_INDEX_TEXT = [
	"# GTM skills",
	"",
	"Step-by-step guides for common Google Tag Manager jobs. Read one at",
	"`gtm://skills/{name}`. Each one is also an MCP prompt with the same name. When a",
	"prompt that takes accountId, containerId and workspaceId gets them, it fetches that",
	"workspace or container and includes the data. Every prompt also includes the",
	"best-practice guides the skill relies on.",
	"",
	...SKILLS.map(
		(s) => `- **${s.name}** (\`${skillUri(s.name)}\`): ${s.description} Prompt arguments: ${argumentList(s)}.`,
	),
	"",
	"Best practices for individual topics are at `gtm://best-practices`.",
	"",
].join("\n");

export function registerSkillResources(server: McpServer): void {
	server.registerResource(
		"skills",
		SKILLS_URI,
		{
			title: "GTM skills (index)",
			description: "Workflow guides (audit, review, safe-edit plan, tracking plan, GA4 setup, templates).",
			mimeType: MARKDOWN,
		},
		(uri) => markdown(uri.href, SKILLS_INDEX_TEXT),
	);

	const names = SKILLS.map((s) => s.name);
	server.registerResource(
		"skill",
		new ResourceTemplate(`${SKILLS_URI}/{name}`, {
			list: () => ({
				resources: SKILLS.map((s) => ({
					uri: skillUri(s.name),
					name: `skill-${s.name}`,
					title: s.title,
					description: s.description,
					mimeType: MARKDOWN,
				})),
			}),
			complete: { name: (value) => names.filter((n) => n.startsWith(value)) },
		}),
		{ title: "GTM skill", description: `One skill: ${names.join(", ")}.`, mimeType: MARKDOWN },
		(uri, variables) => {
			const skill = findSkill(variables.name);
			if (!skill) throw new ResourceNotFoundError(uri.href, `Unknown skill. Skills: ${names.join(", ")}.`);
			return markdown(uri.href, skill.text);
		},
	);
}
