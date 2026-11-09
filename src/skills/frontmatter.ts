// Splits a markdown file into its YAML frontmatter and its body. Shared by the Worker (which
// serves only the body) and scripts/gen-skills.ts (which parses the YAML at build time), so it
// has no imports: plain Node runs it with type stripping.

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The YAML between the leading `---` lines, or undefined when the file has none. */
export function frontmatterOf(text: string): string | undefined {
	return FRONTMATTER.exec(text)?.[1];
}

/** The markdown after the frontmatter, without leading blank lines. */
export function bodyOf(text: string): string {
	const match = FRONTMATTER.exec(text);
	const body = match ? text.slice(match[0].length) : text;
	return body.replace(/^(?:[ \t]*\r?\n)+/, "");
}
