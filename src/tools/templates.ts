// Custom templates (CustomTemplate): tag, variable and client templates written in the GTM
// template editor or imported from the Community Template Gallery. A tag or variable built
// from one has the type `cvt_…` (templateType below).
//
// `templateData` is the whole .tpl file (often tens of KB), so only get_template returns it.
// Every other result describes a template with templateRow.
//
// Tool names and the cvt_ type rule adapted from Paolo Bietolini's gtm-mcp-server
// (BSD-3-Clause; gtm/tool_templates.go, gtm/tool_*_template.go). See NOTICE.

import { z } from "zod";
import { type GtmClient, pagesPerList } from "../gtm/client";
import { accounts, type CustomTemplate } from "../gtm/generated";
import { updateTemplate } from "../gtm/merge";
import { templatePath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { okEntity } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { addDeleteTool, addListTool, workspaceEntity } from "./entity";
import { confirmInput, fingerprintInput, gtmId, nameInput, type WorkspaceInput, workspaceInput } from "./inputs";
import { incompleteCheckNote, listTags, listVariables } from "./references";
import { okWrite } from "./write";

const ws = accounts.containers.workspaces;
const templates = ws.templates;

const USES: Readonly<Record<string, string>> = { TAG: "tag", MACRO: "variable", CLIENT: "client" };

/**
 * The `___INFO___` section of a .tpl file is JSON with the template's `type` (TAG, MACRO or
 * CLIENT) and the `displayName` the GTM UI shows (the API's `name` is a separate field).
 * Anything unreadable yields nothing rather than an error.
 */
export function templateInfo(templateData: string | undefined): { for?: string; displayName?: string } {
	const section = templateData?.split(/^___INFO___\s*?$/m)[1]?.split(/^___[A-Z_]+___\s*?$/m)[0];
	if (section === undefined) return {};
	try {
		const info: unknown = JSON.parse(section);
		if (typeof info !== "object" || info === null) return {};
		const { type, displayName } = info as { type?: unknown; displayName?: unknown };
		return {
			for: typeof type === "string" ? USES[type] : undefined,
			displayName: typeof displayName === "string" ? displayName : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * The `type` a tag or variable built from this template has: `cvt_<galleryTemplateId>` for a
 * Community Template Gallery import, else `cvt_<containerId>_<templateId>` (Paolo's server
 * uses the same rule; see GTM_API_QUIRKS.md Q28).
 */
export function templateType(t: CustomTemplate): string | undefined {
	const galleryId = t.galleryReference?.galleryTemplateId;
	if (galleryId) return `cvt_${galleryId}`;
	const containerId = t.containerId ?? t.path?.split("/")[3];
	return containerId && t.templateId ? `cvt_${containerId}_${t.templateId}` : undefined;
}

/** One list_templates row; also the delete preview and the write result. Never the .tpl code. */
export function templateRow(t: CustomTemplate) {
	const info = templateInfo(t.templateData);
	const g = t.galleryReference;
	return {
		templateId: t.templateId,
		name: t.name,
		displayName: info.displayName === t.name ? undefined : info.displayName,
		for: info.for,
		type: templateType(t),
		gallery: g && { owner: g.owner, repository: g.repository, version: g.version, modified: g.isModified || undefined },
	};
}

/**
 * Tags and variables whose type is this template's: what a delete would break. Both lists share
 * LIST_PAGE_BUDGET (Workers' subrequest cap); on a huge workspace the check is partial.
 */
type TemplateUsers = {
	usedBy?: string[];
	usedByNote?: string;
	partial?: true;
	partialNote?: string;
};

async function templateUsers(gtm: GtmClient, ids: WorkspaceInput, type: string | undefined): Promise<TemplateUsers> {
	if (type === undefined) return {};
	const budget = pagesPerList(2);
	const [tags, variables] = await Promise.all([listTags(gtm, ids, budget), listVariables(gtm, ids, budget)]);
	const usedBy = [
		...tags.items.filter((t) => t.type === type).map((t) => `tag ${t.tagId} "${t.name}"`),
		...variables.items.filter((v) => v.type === type).map((v) => `variable ${v.variableId} "${v.name}"`),
	];
	const complete = !tags.truncated && !variables.truncated;
	// deleteWithConfirm compacts the preview, so an empty usedBy disappears.
	return {
		usedBy,
		usedByNote: usedBy.length ? "These use the template: delete or change them first." : undefined,
		...(complete ? {} : { partial: true as const, partialNote: incompleteCheckNote("template", "tags or variables") }),
	};
}

/** The write result: the row plus the new fingerprint (for a follow-up update_template). */
function templateResult(t: CustomTemplate) {
	return { template: { ...templateRow(t), fingerprint: t.fingerprint } };
}

const templateIdInput = { templateId: gtmId("Template ID") };

const templateDataInput = z.string().min(1).describe("The whole .tpl file");

const template = workspaceEntity({
	kind: "template",
	ids: workspaceInput.extend(templateIdInput),
	id: (ids) => ids.templateId,
	path: templatePath,
	api: templates,
	items: (page) => page.template,
	row: templateRow,
});

// GitHub owner and repository names, and a commit SHA: nothing else reaches the query string.
// refine() rather than regex(), so the patterns stay out of tools/list (budget).
const matching = (pattern: RegExp, what: string, description: string) =>
	z
		.string()
		.refine((v) => pattern.test(v), { message: `must be ${what}` })
		.describe(description);
const galleryOwner = matching(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, "a GitHub user or organisation", "GitHub owner");
const galleryRepository = matching(/^[A-Za-z0-9._-]{1,100}$/, "a GitHub repository name", "GitHub repository");
const gallerySha = matching(/^[0-9a-fA-F]{7,40}$/, "a commit SHA", "Commit SHA; omit for the latest").optional();

export const templateTools: ToolGroup = (tools) => {
	addListTool(tools, template, {
		name: "list_templates",
		key: "templates",
		description:
			"List a workspace's custom templates: ID, name, for (tag, variable, client) and the type their tags or variables use. No code.",
	});

	tools.add(
		"get_template",
		{
			description: "Get one custom template with its .tpl code (templateData) and fingerprint.",
			input: workspaceInput.extend(templateIdInput).extend({
				includeTemplateData: z.boolean().optional().describe("false: leave out the code"),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ includeTemplateData, ...ids }, { gtm }) => {
			const t = await templates.get(gtm, { path: templatePath(ids) });
			const { templateData, ...rest } = t;
			return okEntity({
				...rest,
				for: templateInfo(templateData).for,
				type: templateType(t),
				...(includeTemplateData === false ? { templateDataLength: templateData?.length ?? 0 } : { templateData }),
			});
		},
	);

	tools.add(
		"create_template",
		{
			description:
				"Create a custom template from its .tpl code. For a Community Template Gallery one, use import_gallery_template.",
			input: workspaceInput.extend({ name: nameInput("Template"), templateData: templateDataInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ name, templateData, ...ids }, { gtm }) => {
			const created = await templates.create(gtm, { parent: workspacePath(ids) }, { name, templateData });
			return okWrite(templateResult(created));
		},
	);

	tools.add(
		"update_template",
		{
			description:
				"Replace a template's code (templateData). GTM names templates from the code's ___INFO___ displayName, so edit that to rename one. Pass get_template's fingerprint.",
			input: workspaceInput.extend(templateIdInput).extend({
				templateData: templateDataInput,
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ templateData, fingerprint, ...ids }, { gtm }) => {
			// Q36: no `name` argument: GTM ignores it and takes the name from ___INFO___ displayName.
			// Q8: updateTemplate sends the stored fingerprint as the query parameter and in the body.
			const { result } = await updateTemplate(
				gtm,
				templatePath(ids),
				{ templateData },
				{ expectedFingerprint: fingerprint },
			);
			return okWrite(templateResult(result));
		},
	);

	addDeleteTool(tools, template, {
		name: "delete_template",
		description:
			"Delete a custom template. Without confirm: true, only previews, listing the tags and variables that use it.",
		related: (ids, { gtm }, found) => templateUsers(gtm, ids, templateType(found)),
		// Q34: GTM refuses (bare 400) to delete a template that tags or variables still use.
		rejected: async (ids, { gtm }) => {
			const t = await templates.get(gtm, { path: templatePath(ids) });
			const { usedBy = [], partialNote } = await templateUsers(gtm, ids, templateType(t));
			const partial = partialNote ? ` ${partialNote}` : "";
			return usedBy.length > 0
				? `Nothing was deleted: GTM refuses to delete template ${ids.templateId} while it is still used by ${usedBy.join(", ")}. Delete those or change their type first, then retry.${partial}`
				: `Nothing was deleted: GTM refused to delete template ${ids.templateId}. This usually means a tag or variable still uses it (type ${templateType(t) ?? "cvt_…"}). Find and remove that use, then retry.${partial}`;
		},
	});

	tools.add(
		"import_gallery_template",
		{
			description:
				"Import a Community Template Gallery template from GitHub, accepting its declared permissions. Without confirm: true, only previews.",
			input: workspaceInput.extend({
				galleryOwner,
				galleryRepository,
				gallerySha,
				confirm: confirmInput("import it and accept its permissions"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ galleryOwner, galleryRepository, gallerySha, confirm, ...ids }, { gtm }) =>
			confirmGate({
				confirm,
				// The GTM API has no way to read a gallery template before importing it, so the
				// preview can only name it and say what importing accepts.
				preview: () => {
					const repo = `https://github.com/${galleryOwner}/${galleryRepository}`;
					return okPreview(
						{
							wouldImport: {
								owner: galleryOwner,
								repository: galleryRepository,
								sha: gallerySha ?? "latest",
								source: gallerySha ? `${repo}/tree/${gallerySha}` : repo,
								into: workspacePath(ids),
							},
						},
						"Nothing was imported. Importing accepts, on the user's behalf, every permission the template declares (in its template.tpl: e.g. which URLs it may load scripts from or send data to, cookies, data layer access). The GTM API can't read a gallery template before importing it, so those permissions are not shown here: check them in the repository and tell the user what they allow. Get the user's go-ahead, then call import_gallery_template again with confirm: true.",
					);
				},
				// acknowledgePermissions must be true or Google refuses the import.
				apply: async () => {
					const imported = await templates.importFromGallery(gtm, {
						parent: workspacePath(ids),
						galleryOwner,
						galleryRepository,
						gallerySha,
						acknowledgePermissions: true,
					});
					return okWrite(templateResult(imported));
				},
			}),
	);
};
