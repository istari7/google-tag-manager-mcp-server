// Shapes of the entries in generated.ts (written by scripts/gen-skills.ts).

/** A markdown document served as a resource. `text` is the body, frontmatter removed. */
export interface DocEntry {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly text: string;
}

/** A prompt argument declared in a skill's frontmatter. MCP prompt arguments are strings. */
export interface SkillArgument {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
}

/**
 * Live GTM data a skill's prompt can inline. The ID arguments are added automatically:
 * - "workspace": accountId, containerId, workspaceId → tags, triggers, variables, folders.
 * - "container": accountId, containerId → the container and its workspaces.
 */
export type SkillLiveData = "workspace" | "container";

export interface SkillEntry extends DocEntry {
	readonly tags: readonly string[];
	readonly arguments: readonly SkillArgument[];
	readonly liveData?: SkillLiveData;
	/** Best-practice topics (docs/best-practices/<name>.md) inlined into the prompt. */
	readonly include: readonly string[];
}
