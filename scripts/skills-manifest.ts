// Pure part of the skills generator: parse and validate frontmatter, render
// src/skills/generated.ts. No file system access, so the tests (in workerd) can run it on
// fixtures; scripts/gen-skills.ts does the reading and writing.
//
// Runs on plain Node 24 (type stripping): erasable TypeScript only, and relative imports name
// the .ts file.

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { bodyOf, frontmatterOf } from "../src/skills/frontmatter.ts";
import type { DocEntry, SkillEntry } from "../src/skills/types.ts";

export const MANIFEST_PATH = "src/skills/generated.ts";
export const BEST_PRACTICES_DIR = "docs/best-practices";
export const SKILLS_DIR = "skills";
/** Placeholder in docs/best-practices/index.md where the server lists the topics. */
export const TOPICS_PLACEHOLDER = "{{topics}}";
/** Prompt arguments added by `live-data`; a skill can't declare them itself. */
export const CONTEXT_ARGUMENTS = ["accountId", "containerId", "workspaceId"] as const;

/** A markdown file, path relative to the repo root with forward slashes. */
export interface SourceFile {
	path: string;
	text: string;
}

export interface ManifestSources {
	bestPractices: readonly SourceFile[];
	skills: readonly SourceFile[];
}

/** Metadata only: the body stays in the markdown file, which the manifest imports. */
type Meta<T> = Omit<T, "text"> & { path: string; order: number };

export interface Manifest {
	index: Meta<DocEntry>;
	bestPractices: Array<Meta<DocEntry>>;
	skills: Array<Meta<SkillEntry>>;
}

export class SkillsManifestError extends Error {
	override readonly name = "SkillsManifestError";
}

/** Agent Skills naming: lowercase letters, digits and single hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
/** Listing position: lower first, then by name. */
const order = z.number().int().min(0).max(1000).default(100);

const docFrontmatter = z.strictObject({
	name: z.string().regex(NAME).optional(),
	title: nonEmpty(100),
	description: nonEmpty(1024),
	order,
});

const skillFrontmatter = z.strictObject({
	name: z.string().regex(NAME, "lowercase letters, digits and hyphens").max(64),
	title: nonEmpty(100).optional(),
	description: nonEmpty(1024),
	arguments: z
		.array(
			z.strictObject({
				name: z.string().regex(/^[a-z][A-Za-z0-9_]*$/, "an identifier such as templateName"),
				description: nonEmpty(300),
				required: z.boolean().default(false),
			}),
		)
		.default([]),
	/** Not `context`: Claude Code skills already use that key (`context: fork`). */
	"live-data": z.enum(["workspace", "container"]).optional(),
	include: z.array(z.string().regex(NAME)).default([]),
	tags: z.array(nonEmpty(40)).default([]),
	order,
	/** Agent Skills field; we use it for the attribution of adapted material (see NOTICE). */
	license: nonEmpty(300).optional(),
});

const stem = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/, "");
const parentDir = (path: string) => path.split("/").slice(-2, -1)[0] ?? "";

function frontmatter<T extends z.ZodType>(file: SourceFile, schema: T, errors: string[]): z.output<T> | undefined {
	const yaml = frontmatterOf(file.text);
	if (yaml === undefined) {
		errors.push(`${file.path}: missing YAML frontmatter (--- ... --- at the top of the file)`);
		return undefined;
	}
	let data: unknown;
	try {
		data = parseYaml(yaml);
	} catch (error) {
		errors.push(`${file.path}: invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
		return undefined;
	}
	const result = schema.safeParse(data ?? {});
	if (!result.success) {
		for (const issue of result.error.issues) {
			errors.push(`${file.path}: ${issue.path.join(".") || "frontmatter"}: ${issue.message}`);
		}
		return undefined;
	}
	const body = bodyOf(file.text);
	if (!/^# \S/.test(body)) errors.push(`${file.path}: the body must start with a "# Title" heading`);
	return result.data;
}

function defaultTitle(name: string): string {
	const words = name.replace(/-/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const byOrder = <T extends { name: string; order: number }>(a: T, b: T) =>
	a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Parse and validate every source. Throws one SkillsManifestError listing every problem. */
export function parseSources(sources: ManifestSources): Manifest {
	const errors: string[] = [];
	let index: Manifest["index"] | undefined;
	const bestPractices: Manifest["bestPractices"] = [];

	for (const file of sources.bestPractices) {
		const name = stem(file.path);
		const data = frontmatter(file, docFrontmatter, errors);
		if (!data) continue;
		if (data.name !== undefined && data.name !== name) {
			errors.push(`${file.path}: name "${data.name}" must match the file name "${name}" (or be left out)`);
		}
		if (!NAME.test(name)) errors.push(`${file.path}: file name must be lowercase letters, digits and hyphens`);
		const entry = { name, title: data.title, description: data.description, path: file.path, order: data.order };
		if (name === "index") {
			if (file.text.split(TOPICS_PLACEHOLDER).length !== 2) {
				errors.push(`${file.path}: must contain ${TOPICS_PLACEHOLDER} exactly once (where the topic list goes)`);
			}
			index = entry;
		} else {
			bestPractices.push(entry);
		}
	}
	if (!index && sources.bestPractices.length > 0) errors.push(`${BEST_PRACTICES_DIR}/index.md is missing`);
	const topics = new Set(bestPractices.map((t) => t.name));

	const skills: Manifest["skills"] = [];
	for (const file of sources.skills) {
		const dir = parentDir(file.path);
		const data = frontmatter(file, skillFrontmatter, errors);
		if (!data) continue;
		if (data.name !== dir) errors.push(`${file.path}: name "${data.name}" must match its directory "${dir}"`);
		const seen = new Set<string>();
		for (const arg of data.arguments) {
			if ((CONTEXT_ARGUMENTS as readonly string[]).includes(arg.name)) {
				errors.push(`${file.path}: argument "${arg.name}" is reserved; set "live-data" instead`);
			}
			if (seen.has(arg.name)) errors.push(`${file.path}: argument "${arg.name}" is declared twice`);
			seen.add(arg.name);
		}
		for (const topic of data.include) {
			if (!topics.has(topic)) {
				errors.push(`${file.path}: include "${topic}" is not a best-practice topic (${[...topics].join(", ")})`);
			}
		}
		skills.push({
			name: data.name,
			title: data.title ?? defaultTitle(data.name),
			description: data.description,
			tags: data.tags,
			arguments: data.arguments,
			...(data["live-data"] ? { liveData: data["live-data"] } : {}),
			include: data.include,
			path: file.path,
			order: data.order,
		});
	}

	if (errors.length > 0)
		throw new SkillsManifestError(`Invalid skills or best-practice docs:\n- ${errors.join("\n- ")}`);
	if (!index) throw new SkillsManifestError(`${BEST_PRACTICES_DIR}/index.md is missing`);
	return { index, bestPractices: bestPractices.sort(byOrder), skills: skills.sort(byOrder) };
}

const ident = (prefix: string, name: string) => `${prefix}_${name.replace(/-/g, "_")}`;
const str = (value: string) => JSON.stringify(value);

function renderDoc(entry: Manifest["index"], id: string, indent: string): string {
	return [
		"{",
		`${indent}\tname: ${str(entry.name)},`,
		`${indent}\ttitle: ${str(entry.title)},`,
		`${indent}\tdescription: ${str(entry.description)},`,
		`${indent}\ttext: bodyOf(${id}),`,
		`${indent}}`,
	].join("\n");
}

function renderSkill(entry: Manifest["skills"][number], id: string): string {
	const args = entry.arguments.map(
		(a) => `{ name: ${str(a.name)}, description: ${str(a.description)}, required: ${a.required} }`,
	);
	return [
		"{",
		`\t\tname: ${str(entry.name)},`,
		`\t\ttitle: ${str(entry.title)},`,
		`\t\tdescription: ${str(entry.description)},`,
		`\t\ttags: [${entry.tags.map(str).join(", ")}],`,
		args.length ? `\t\targuments: [\n\t\t\t${args.join(",\n\t\t\t")},\n\t\t],` : "\t\targuments: [],",
		...(entry.liveData ? [`\t\tliveData: ${str(entry.liveData)},`] : []),
		`\t\tinclude: [${entry.include.map(str).join(", ")}],`,
		`\t\ttext: bodyOf(${id}),`,
		"\t}",
	].join("\n");
}

/** The TypeScript source of src/skills/generated.ts. Deterministic. */
export function renderManifest(manifest: Manifest): string {
	const from = (path: string) => str(`../../${path}`);
	const indexId = ident("bp", "index");
	const lines = [
		"// Generated by scripts/gen-skills.ts from docs/best-practices/*.md and skills/*/SKILL.md.",
		"// Do not edit: change the markdown's frontmatter and run `pnpm gen:skills`. `pnpm test` and",
		"// `pnpm gen:skills --check` fail when this file is stale. The markdown itself is bundled as",
		"// Text modules (`rules` in wrangler.jsonc), so editing a body needs no regeneration.",
		"",
		'import { bodyOf } from "./frontmatter";',
		'import type { DocEntry, SkillEntry } from "./types";',
		`import ${indexId} from ${from(manifest.index.path)};`,
		...manifest.bestPractices.map((t) => `import ${ident("bp", t.name)} from ${from(t.path)};`),
		...manifest.skills.map((s) => `import ${ident("skill", s.name)} from ${from(s.path)};`),
		"",
		"/** docs/best-practices/index.md, served as gtm://best-practices. */",
		`export const BEST_PRACTICES_INDEX: DocEntry = ${renderDoc(manifest.index, indexId, "")};`,
		"",
		"/** docs/best-practices/<name>.md, served as gtm://best-practices/<name>. */",
		"export const BEST_PRACTICES: readonly DocEntry[] = [",
		...manifest.bestPractices.map((t) => `\t${renderDoc(t, ident("bp", t.name), "\t")},`),
		"];",
		"",
		"/** skills/<name>/SKILL.md, served as gtm://skills/<name> and as the prompt <name>. */",
		"export const SKILLS: readonly SkillEntry[] = [",
		...manifest.skills.map((s) => `\t${renderSkill(s, ident("skill", s.name))},`),
		"];",
		"",
	];
	return lines.join("\n");
}

export function buildSkillsManifest(sources: ManifestSources): string {
	return renderManifest(parseSources(sources));
}
