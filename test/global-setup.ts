// Runs once in Node before the workerd tests: fail the run when src/skills/generated.ts
// no longer matches skills/*/SKILL.md and docs/best-practices/*.md (like `pnpm gen:skills --check`).
// The tests themselves run in workerd, which can't read the repo's files.

import { checkSkillsManifest } from "../scripts/gen-skills.ts";

export default async function checkManifest(): Promise<void> {
	const result = await checkSkillsManifest();
	if (!result.ok) throw new Error(result.message);
}
