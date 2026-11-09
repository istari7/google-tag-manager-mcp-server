// Text built from the skills manifest: the MCP `instructions` sent at initialize, and the public
// GET /llms.txt. Both list the skills and best-practice topics, so a new markdown file shows up
// in them after `pnpm gen:skills` with no code change.

import { BEST_PRACTICES_URI, TOPICS } from "../resources/best-practices";
import { SKILLS_URI } from "../resources/skills";
import { BEST_PRACTICES, SKILLS } from "./generated";
import { promptArguments } from "./prompts";

const skillNames = SKILLS.map((s) => s.name).join(", ");

/** Sent to clients in the initialize result. Keep it short: clients put it in the model's context. */
export const SERVER_INSTRUCTIONS = [
	"Google Tag Manager through the Tag Manager API v2, as the signed-in user.",
	`Before creating or changing anything, read ${BEST_PRACTICES_URI} and the matching ${BEST_PRACTICES_URI}/{topic} (${Object.keys(TOPICS).join(", ")}).`,
	`Workflow guides ("skills") are at ${SKILLS_URI} and ${SKILLS_URI}/{name} (${skillNames}); each is also a prompt of the same name, and prompts given accountId/containerId/workspaceId include live workspace data.`,
	"Workspace edits and saved versions are not live; only publishing is. Publish (publish_version) only on the user's explicit go-ahead. Publish and delete tools preview first and act only with confirm: true.",
].join("\n");

/** Skills tagged "guide" are included in full in llms.txt. */
const GUIDE_TAG = "guide";

/** Plain-text overview for LLMs and crawlers (llmstxt.org). Public: no user data in it. */
export function llmsTxt(origin: string): string {
	const skills = SKILLS.map((s) => {
		const args = promptArguments(s).map((a) => (a.required ? `${a.name} (required)` : a.name));
		return `- ${s.name}: ${s.description}${args.length ? ` Prompt arguments: ${args.join(", ")}.` : ""}`;
	});
	const guides = SKILLS.filter((s) => s.tags.includes(GUIDE_TAG)).map((s) => s.text.trimEnd());
	return [
		"# gtm-mcp",
		"",
		"> A self-hosted MCP server for Google Tag Manager on Cloudflare Workers. Clients sign in with",
		"> OAuth (a Google account on the server's allowlist) and read and edit GTM accounts,",
		"> containers, workspaces, tags, triggers, variables, folders and versions through the Tag",
		"> Manager API v2.",
		"",
		`MCP endpoint: ${origin}/mcp (Streamable HTTP, OAuth 2.1; dynamic client registration and`,
		`client ID metadata documents are supported). Setup status for the server owner: ${origin}/setup.`,
		"",
		"## Safety",
		"",
		"- Every edit happens in a workspace. Workspace edits and saved versions are not live.",
		"- publish_version, the delete tools and other irreversible tools return a preview and act",
		"  only when called again with confirm: true. delete_container also needs the container's",
		"  public ID typed back.",
		"",
		`## Skills (MCP resources ${SKILLS_URI}/{name}, and prompts of the same name)`,
		"",
		...skills,
		"",
		`## Best practices (MCP resources ${BEST_PRACTICES_URI}/{topic})`,
		"",
		...BEST_PRACTICES.map((t) => `- ${t.name}: ${t.description}`),
		...guides.flatMap((text) => ["", "---", "", text]),
		"",
	].join("\n");
}

export function llmsTxtResponse(origin: string): Response {
	return new Response(llmsTxt(origin), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
