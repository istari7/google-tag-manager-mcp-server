// Google tag configs (gtagConfig): settings GTM creates by itself next to GA4 event, Google Ads
// conversion and Floodlight tags. Deleting those tags leaves the configs behind (Q23).
// Tool names follow Paolo's server (PLAN §6): *_google_tag_config(s).

import { z } from "zod";
import { accounts, type GtagConfig } from "../gtm/generated";
import { getMergePut, stripServerFields } from "../gtm/merge";
import { gtagConfigPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import { fingerprintInput, gtmId, parametersInput, workspaceInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const gtagConfigs = accounts.containers.workspaces.gtagConfig;

/**
 * One list row, also the delete preview and the write result. Configs carry long parameter
 * lists (seen live), so the row keeps only what identifies one: its type and its tag ID.
 * get_google_tag_config returns everything.
 */
export function gtagConfigRow(g: GtagConfig) {
	return {
		gtagConfigId: g.gtagConfigId,
		type: g.type,
		tagId: g.parameter?.find((p) => p.key === "tagId")?.value,
		parameters: g.parameter?.length,
	};
}

const gtagConfig = workspaceEntity({
	kind: "gtagConfig",
	label: "Google tag config",
	ids: workspaceInput.extend({ gtagConfigId: gtmId("Google tag config ID") }),
	id: (ids) => ids.gtagConfigId,
	path: gtagConfigPath,
	api: gtagConfigs,
	items: (page) => page.gtagConfig,
	row: gtagConfigRow,
});

const typeInput = z.string().trim().min(1).describe('Config type, e.g. "googtag"');

export const gtagConfigTools: ToolGroup = (tools) => {
	addListTool(tools, gtagConfig, {
		name: "list_google_tag_configs",
		key: "gtagConfigs",
		description:
			"List a workspace's Google tag configs (gtagConfig), which GTM creates with GA4, Google Ads and Floodlight tags.",
	});

	addGetTool(tools, gtagConfig, {
		name: "get_google_tag_config",
		description: "Get one Google tag config with all its parameters and fingerprint.",
	});

	tools.add(
		"create_google_tag_config",
		{
			description: "Create a Google tag config in a workspace. Not live until a version is published.",
			input: workspaceInput.extend({ type: typeInput, parameter: parametersInput.optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ type, parameter, ...ids }, { gtm }) => {
			const body = stripServerFields<GtagConfig>({ type, parameter });
			const result = await gtagConfigs.create(gtm, { parent: workspacePath(ids) }, body);
			return okWrite({ gtagConfig: { ...gtagConfigRow(result), fingerprint: result.fingerprint } });
		},
	);

	tools.add(
		"update_google_tag_config",
		{
			description:
				"Change a Google tag config's type or parameters; omitted fields are kept. Pass the fingerprint from get_google_tag_config.",
			input: gtagConfig.ids.extend({
				type: typeInput.optional(),
				parameter: parametersInput.optional(),
				fingerprint: fingerprintInput,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ type, parameter, fingerprint, ...ids }, { gtm }) => {
			if (isEmptyPatch({ type, parameter })) return fail("Nothing to update: pass type and/or parameter.");
			const path = gtagConfigPath(ids);
			// Q1/Q2/Q7: GET, overlay (undefined keeps, [] clears), PUT with ?fingerprint=.
			const { result } = await getMergePut<GtagConfig, Partial<GtagConfig>>({
				path,
				patch: { type, parameter },
				expectedFingerprint: fingerprint,
				get: () => gtagConfigs.get(gtm, { path }),
				put: (body, stored) => gtagConfigs.update(gtm, { path, fingerprint: stored }, body),
				normalize: (patch) => ({ value: patch, warnings: [] }),
			});
			return okWrite({ gtagConfig: { ...gtagConfigRow(result), fingerprint: result.fingerprint } });
		},
	);

	addDeleteTool(tools, gtagConfig, {
		name: "delete_google_tag_config",
		description:
			"Delete a Google tag config, e.g. one left behind after its GA4 or Ads tag was deleted. Without confirm: true, only previews.",
	});
};
