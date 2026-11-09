import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { GtmApiError } from "../gtm/errors";
import { accounts, type ContainerVersion, type ContainerVersionHeader } from "../gtm/generated";
import { containerPath, parseGtmPath, versionPath, workspacePath } from "../gtm/paths";
import { createVersionProblem } from "../gtm/quirks";
import type { ToolGroup } from "../mcp/registry";
import { fail, ok, okList } from "../mcp/result";
import { confirmInput, containerInput, gtmId, nameInput, workspaceInput } from "./inputs";
import { describeEntity, summarizeVersion, versionHeadline } from "./summaries";
import { okWrite } from "./write";

const versions = accounts.containers.versions;
const versionHeaders = accounts.containers.versionHeaders;
const workspaces = accounts.containers.workspaces;

/** Google omits a count when it is zero; report 0, as get_live_version does. */
const count = (value: string | undefined) => (value === undefined ? 0 : Number(value));

function versionRow(h: ContainerVersionHeader) {
	return {
		containerVersionId: h.containerVersionId,
		name: h.name,
		deleted: h.deleted || undefined,
		numTags: count(h.numTags),
		numTriggers: count(h.numTriggers),
		numVariables: count(h.numVariables),
	};
}

/** The live version, or undefined when nothing has been published yet (404). */
async function liveVersion(gtm: GtmClient, parent: string): Promise<ContainerVersion | undefined> {
	try {
		return await versions.live(gtm, { parent });
	} catch (error) {
		if (error instanceof GtmApiError && error.kind === "notFound") return undefined;
		throw error;
	}
}

function entityLabel(e: ReturnType<typeof describeEntity>): string {
	if (!e) return "unknown entity";
	const id = "id" in e && e.id ? ` ${e.id}` : "";
	const name = "name" in e && e.name ? ` "${e.name}"` : "";
	return `${e.kind}${id}${name}`;
}

export const versionTools: ToolGroup = (tools) => {
	tools.add(
		"create_version",
		{
			description:
				"Save a workspace's changes as a new container version. Does not publish (see publish_version). Fails if the workspace has no changes or has merge conflicts.",
			input: workspaceInput.extend({
				name: nameInput("Version").describe("Version name: what changed, e.g. Add GA4 purchase event"),
				notes: z.string().optional().describe("Version notes: what changed and why"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ name, notes, ...ids }, { gtm }): Promise<CallToolResult> => {
			const path = workspacePath(ids);
			// Check the workspace first, so we never version nothing or a conflicted workspace.
			const status = await workspaces.getStatus(gtm, { path });
			const conflicts = status?.mergeConflict ?? [];
			if (conflicts.length > 0) {
				const which = conflicts.map((c) => entityLabel(describeEntity(c.entityInWorkspace ?? c.entityInBaseVersion)));
				return fail(
					`Workspace ${ids.workspaceId} has ${conflicts.length} merge conflict(s) (${which.join(", ")}). Resolve them in the GTM UI, then retry. No version was created.`,
				);
			}
			if ((status?.workspaceChange ?? []).length === 0) {
				return fail(`Workspace ${ids.workspaceId} has no changes, so there is nothing to version.`);
			}

			const response = await workspaces.createVersion(gtm, { path }, { name, notes });
			const problem = createVersionProblem(response); // Q20
			if (problem || !response.containerVersion) return fail(problem ?? "No version was created.");

			const version = versionHeadline(response.containerVersion);
			const id = response.containerVersion.containerVersionId;
			let next = "";
			if (response.newWorkspacePath) {
				try {
					const w = parseGtmPath(response.newWorkspacePath).workspaceId;
					if (w && w !== ids.workspaceId)
						next = ` GTM replaced workspace ${ids.workspaceId} with workspace ${w}; make further edits there.`;
				} catch {
					// Not a workspace path: leave the hint out.
				}
			}
			return okWrite(
				{ version },
				{
					note: `Version ${id} is saved but NOT live. Show the user what it contains. To make it live, get the user's explicit go-ahead and call publish_version, or they can publish it in the GTM UI (Versions > Publish).${next}`,
				},
			);
		},
	);

	tools.add(
		"publish_version",
		{
			description:
				"Publish a container version: it goes live on every site using the container. Without confirm: true, only previews. Needs the user's explicit go-ahead.",
			input: containerInput.extend({
				containerVersionId: gtmId("Container version ID (from create_version or list_versions)"),
				confirm: confirmInput("publish"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ containerVersionId, confirm, ...ids }, { gtm }): Promise<CallToolResult> => {
			const path = versionPath({ ...ids, versionId: containerVersionId });
			if (confirm !== true) {
				const [version, live] = await Promise.all([versions.get(gtm, { path }), liveVersion(gtm, containerPath(ids))]);
				if (version.deleted) return fail(`Version ${containerVersionId} is deleted, so it cannot be published.`);
				const alreadyLive = live?.containerVersionId === containerVersionId;
				return ok({
					preview: true,
					wouldPublish: summarizeVersion(version) ?? {},
					currentlyLive: live
						? { containerVersionId: live.containerVersionId, name: live.name }
						: "nothing (this container has never been published)",
					...(alreadyLive ? { alreadyLive: true } : {}),
					message:
						"Nothing was published. Show the user what this version contains and what is live now, get their explicit go-ahead, then call publish_version again with confirm: true.",
				});
			}
			const response = await versions.publish(gtm, { path });
			if (response?.compilerError) {
				return fail(
					`Version ${containerVersionId} does not compile, so nothing was published. Fix the errors in GTM, then create and publish a new version.`,
				);
			}
			return ok({
				published: versionHeadline(response?.containerVersion ?? { containerVersionId }),
				note: `Version ${containerVersionId} is now LIVE on every site that loads this container. To roll back, publish an earlier version (list_versions).`,
			});
		},
	);

	tools.add(
		"get_live_version",
		{
			description:
				"Summarise the published (live) version of a container: version ID, entity counts, and the name and type of every tag, trigger and variable.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = containerPath(ids);
			const live = await liveVersion(gtm, parent);
			if (!live) return fail(`No live version for ${parent}: nothing has been published yet, or the IDs are wrong.`);
			return ok(summarizeVersion(live) ?? {});
		},
	);

	tools.add(
		"list_versions",
		{
			description: "List a container's saved versions, newest first, with tag/trigger/variable counts.",
			input: containerInput.extend({
				includeDeleted: z.boolean().optional().describe("Also list deleted versions"),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ includeDeleted, ...ids }, { gtm }) => {
			const parent = containerPath(ids);
			const list = await gtm.listAll(
				(pageToken) => versionHeaders.list(gtm, { parent, pageToken, includeDeleted }),
				(page) => page.containerVersionHeader,
			);
			const items = [...list.items].sort(
				(a, b) => Number(b.containerVersionId ?? 0) - Number(a.containerVersionId ?? 0),
			);
			return okList("versions", { ...list, items }, versionRow);
		},
	);
};
