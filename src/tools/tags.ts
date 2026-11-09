import { z } from "zod";
import { accounts, type Tag } from "../gtm/generated";
import { createTag, updateTag } from "../gtm/merge";
import { tagPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import { fingerprintInput, gtmId, idList, nameInput, notesInput, parametersInput, workspaceInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const tags = accounts.containers.workspaces.tags;

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
			"List a workspace's tags: ID, name, type, folder, firing/blocking trigger IDs, paused: true if paused (absent = active).",
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
			const { result, warnings } = await createTag(gtm, workspacePath({ accountId, containerId, workspaceId }), fields);
			return okWrite({ tag: result }, { warnings });
		},
	);

	tools.add(
		"update_tag",
		{
			description:
				"Change some fields of a tag; omitted fields are kept, [] clears a list. Pass get_tag's fingerprint to avoid overwriting newer edits.",
			input: workspaceInput
				.extend(tagIdInput)
				.extend(tagFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, tagId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one tag field.");
			const path = tagPath({ accountId, containerId, workspaceId, tagId });
			const { result, warnings } = await updateTag(gtm, path, fields, { expectedFingerprint: fingerprint });
			return okWrite({ tag: result }, { warnings });
		},
	);

	addDeleteTool(tools, tag, {
		name: "delete_tag",
		description: "Delete a tag. Without confirm: true, only previews.",
	});
};
