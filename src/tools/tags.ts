import { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { accounts, type Entity, type Tag } from "../gtm/generated";
import { createTag, updateTag } from "../gtm/merge";
import { tagPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import { fingerprintInput, gtmId, idList, nameInput, notesInput, parametersInput, workspaceInput } from "./inputs";
import { describeEntity } from "./summaries";
import { isEmptyPatch, okWrite } from "./write";

const tags = accounts.containers.workspaces.tags;

/**
 * Tag types for which GTM may create an unpaused Google tag and gtagConfigs by itself (Q23):
 * GA4 event, Google Ads conversion and remarketing, Floodlight counter and sales.
 */
export const GOOGLE_TAG_CREATING_TYPES: ReadonlySet<string> = new Set(["gaawe", "awct", "sp", "flc", "fls"]);

export const AUTO_GOOGLE_TAG_UNCHECKED =
	"GTM may also have created an unpaused Google tag and Google tag configs for this tag (Q23). Check get_workspace_status and tell the user.";

const entityKey = (e: Entity) => {
	const d = describeEntity(e);
	return `${d?.kind}:${d?.id ?? d?.name}`;
};

/** The workspace's changed entities, or undefined if the status can't be read. */
async function changedEntities(gtm: GtmClient, path: string): Promise<Entity[] | undefined> {
	try {
		return (await accounts.containers.workspaces.getStatus(gtm, { path }))?.workspaceChange ?? [];
	} catch {
		return undefined;
	}
}

/**
 * Q23: what GTM added or changed by itself while it saved `saved`, found by comparing the
 * workspace status before and after (two GETs). Returns the extra result fields and warning.
 */
async function autoCreated(
	gtm: GtmClient,
	path: string,
	before: Entity[] | undefined,
	saved: Tag,
): Promise<{ fields: Record<string, unknown>; warnings: string[] }> {
	const after = before && (await changedEntities(gtm, path));
	if (!before || !after) return { fields: {}, warnings: [AUTO_GOOGLE_TAG_UNCHECKED] };
	const known = new Set(before.map(entityKey));
	known.add(`tag:${saved.tagId}`);
	const extra = after
		.filter((e) => !known.has(entityKey(e)))
		.map((e) => ({
			kind: "unknown",
			...describeEntity(e),
			type: e.tag?.type ?? e.gtagConfig?.type,
			paused: e.tag ? e.tag.paused === true : undefined,
			changeStatus: e.changeStatus,
		}));
	if (extra.length === 0) return { fields: {}, warnings: [] };
	const activeTags = extra.filter((e) => e.kind === "tag" && !e.paused).length;
	return {
		fields: { alsoChangedByGtm: extra },
		warnings: [
			`GTM also ${extra.length === 1 ? "changed 1 other entity" : `changed ${extra.length} other entities`} by itself (Q23, see alsoChangedByGtm)${activeTags > 0 ? `, including ${activeTags} unpaused tag(s)` : ""}. They go live with this workspace when it is published. Tell the user; remove unwanted ones with delete_tag / delete_gtag_config.`,
		],
	};
}

/** One list_tags row; also the delete_tag preview. `paused` only when true (the description says so). */
export function tagRow(t: Tag) {
	return {
		tagId: t.tagId,
		name: t.name,
		type: t.type,
		parentFolderId: t.parentFolderId,
		firingTriggerId: t.firingTriggerId,
		blockingTriggerId: t.blockingTriggerId,
		paused: t.paused || undefined,
	};
}

/** Tag fields a caller may set. Google's names, so get_tag output can be sent back. */
const tagFields = z.object({
	name: nameInput("Tag"),
	type: z.string().trim().min(1).describe('Tag type, e.g. "gaawe" (GA4 event), "googtag" (Google tag), "html"'),
	parameter: parametersInput.optional(),
	firingTriggerId: idList("Firing trigger").optional(),
	blockingTriggerId: idList("Blocking trigger").optional(),
	setupTag: z
		.array(z.object({ tagName: z.string(), stopOnSetupFailure: z.boolean().optional() }))
		.max(1)
		.optional(),
	teardownTag: z
		.array(z.object({ tagName: z.string(), stopTeardownOnFailure: z.boolean().optional() }))
		.max(1)
		.optional(),
	tagFiringOption: z.enum(["unlimited", "oncePerEvent", "oncePerLoad"]).optional(),
	paused: z.boolean().optional(),
	notes: notesInput,
	consentStatus: z.enum(["notSet", "notNeeded", "needed"]).optional(),
	consentTypes: z
		.array(z.string())
		.optional()
		// Q14: consent goes through normalizeTag (quirks.ts), which applies this rule.
		.describe('When consent is "needed" (given, or stored on update), e.g. ad_storage. Update: omit to keep'),
});

const tagIdInput = { tagId: gtmId("Tag ID") };

const tag = workspaceEntity({
	kind: "tag",
	ids: workspaceInput.extend(tagIdInput),
	id: (ids) => ids.tagId,
	path: tagPath,
	api: tags,
	items: (page) => page.tag,
	row: tagRow,
});

export const tagTools: ToolGroup = (tools) => {
	addListTool(tools, tag, {
		name: "list_tags",
		key: "tags",
		description:
			"List the tags in a GTM workspace: ID, name, type, folder, firing and blocking trigger IDs, paused: true if paused (absent = active).",
	});

	addGetTool(tools, tag, {
		name: "get_tag",
		description: "Get one tag with all its parameters, triggers, consent settings and fingerprint.",
	});

	tools.add(
		"create_tag",
		{
			description:
				"Create a tag in a workspace. Create its triggers and variables first. Not live until a version is published.",
			input: workspaceInput.extend(tagFields.shape).extend({ parentFolderId: gtmId("Folder ID").optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const watch = GOOGLE_TAG_CREATING_TYPES.has(fields.type);
			const before = watch ? await changedEntities(gtm, parent) : undefined;
			const { result, warnings } = await createTag(gtm, parent, fields);
			if (!watch) return okWrite({ tag: result }, { warnings });
			const auto = await autoCreated(gtm, parent, before, result);
			return okWrite({ tag: result, ...auto.fields }, { warnings: [...warnings, ...auto.warnings] });
		},
	);

	tools.add(
		"update_tag",
		{
			description:
				"Change some fields of a tag; omitted fields are kept, [] clears a list. Pass the fingerprint from get_tag to avoid overwriting newer edits.",
			input: workspaceInput
				.extend(tagIdInput)
				.extend(tagFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, tagId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one tag field.");
			const path = tagPath({ accountId, containerId, workspaceId, tagId });
			// Q23: only a new type or new parameters (e.g. a measurement ID) can make GTM add a
			// Google tag. The stored type is unknown until updateTag's GET, so check by result.
			const watch =
				fields.type !== undefined ? GOOGLE_TAG_CREATING_TYPES.has(fields.type) : fields.parameter !== undefined;
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const before = watch ? await changedEntities(gtm, parent) : undefined;
			const { result, warnings } = await updateTag(gtm, path, fields, { expectedFingerprint: fingerprint });
			if (!watch || !GOOGLE_TAG_CREATING_TYPES.has(result.type ?? "")) return okWrite({ tag: result }, { warnings });
			const auto = await autoCreated(gtm, parent, before, result);
			return okWrite({ tag: result, ...auto.fields }, { warnings: [...warnings, ...auto.warnings] });
		},
	);

	addDeleteTool(tools, tag, {
		name: "delete_tag",
		description: "Delete a tag from a workspace. Without confirm: true, only shows what would be deleted.",
	});
};
