// Generate src/skills/generated.ts from the markdown the server serves:
//
//   docs/best-practices/<topic>.md   → gtm://best-practices/<topic> (index.md → gtm://best-practices)
//   skills/<name>/SKILL.md           → gtm://skills/<name> and the MCP prompt <name>
//
//   node scripts/gen-skills.ts           write the manifest      (= pnpm gen:skills)
//   node scripts/gen-skills.ts --check   exit 1 if it is stale   (= pnpm gen:skills --check)
//
// Workers have no file system at runtime and wrangler's bundler has no glob imports, so the
// files are discovered here, at build time. Frontmatter is parsed and validated here too
// (scripts/skills-manifest.ts); the manifest holds the metadata plus one static Text-module
// import per file. `pnpm test` runs the check (test/global-setup.ts).
//
// Runs on plain Node 24 (native type stripping): erasable TypeScript only.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BEST_PRACTICES_DIR,
	buildSkillsManifest,
	MANIFEST_PATH,
	type ManifestSources,
	SKILLS_DIR,
	type SourceFile,
} from "./skills-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const lf = (text: string) => text.replace(/\r\n/g, "\n");

async function readSource(root: string, path: string): Promise<SourceFile> {
	return { path, text: lf(await readFile(join(root, path), "utf8")) };
}

/** Every docs/best-practices/*.md and skills/<name>/SKILL.md, sorted by path. */
export async function readSources(root: string = ROOT): Promise<ManifestSources> {
	const docs = (await readdir(join(root, BEST_PRACTICES_DIR), { withFileTypes: true }))
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => `${BEST_PRACTICES_DIR}/${e.name}`)
		.sort();
	const skillDirs = (await readdir(join(root, SKILLS_DIR), { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
	const skills: SourceFile[] = [];
	for (const dir of skillDirs) {
		const path = `${SKILLS_DIR}/${dir}/SKILL.md`;
		try {
			skills.push(await readSource(root, path));
		} catch {
			throw new Error(`${SKILLS_DIR}/${dir}/ has no SKILL.md`);
		}
	}
	return { bestPractices: await Promise.all(docs.map((p) => readSource(root, p))), skills };
}

export interface CheckResult {
	ok: boolean;
	message: string;
}

/** Regenerates in memory and compares with the file on disk. */
export async function checkSkillsManifest(root: string = ROOT): Promise<CheckResult> {
	let expected: string;
	try {
		expected = buildSkillsManifest(await readSources(root));
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	const actual = await readFile(join(root, MANIFEST_PATH), "utf8").then(lf, () => "");
	return actual === expected
		? { ok: true, message: `${MANIFEST_PATH} is up to date.` }
		: { ok: false, message: `${MANIFEST_PATH} is stale. Run \`pnpm gen:skills\` and commit the result.` };
}

async function main(argv: readonly string[]): Promise<void> {
	if (argv.includes("--check")) {
		const result = await checkSkillsManifest();
		if (result.ok) console.log(result.message);
		else {
			console.error(result.message);
			process.exitCode = 1;
		}
		return;
	}
	const sources = await readSources();
	await writeFile(join(ROOT, MANIFEST_PATH), buildSkillsManifest(sources));
	console.log(
		`Wrote ${MANIFEST_PATH}: ${sources.bestPractices.length} best-practice docs, ${sources.skills.length} skills.`,
	);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
