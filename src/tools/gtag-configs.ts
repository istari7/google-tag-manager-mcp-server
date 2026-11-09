// Google tag configs (gtagConfig): settings GTM creates by itself next to GA4 event, Google Ads
// conversion and Floodlight tags. Deleting those tags leaves the configs behind (Q23).

import { accounts, type GtagConfig } from "../gtm/generated";
import { gtagConfigPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { okList } from "../mcp/result";
import { confirmInput, gtmId, workspaceInput } from "./inputs";
import { deleteWithConfirm } from "./write";

const gtagConfigs = accounts.containers.workspaces.gtagConfig;

export function gtagConfigRow(g: GtagConfig) {
	return { gtagConfigId: g.gtagConfigId, type: g.type, parameter: g.parameter };
}

export const gtagConfigTools: ToolGroup = (tools) => {
	tools.add(
		"list_gtag_configs",
		{
			description:
				"List a workspace's Google tag configs (gtagConfig), which GTM creates with GA4, Google Ads and Floodlight tags.",
			input: workspaceInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const parent = workspacePath(ids);
			const list = await gtm.listAll(
				(pageToken) => gtagConfigs.list(gtm, { parent, pageToken }),
				(page) => page.gtagConfig,
			);
			return okList("gtagConfigs", list, gtagConfigRow);
		},
	);

	tools.add(
		"delete_gtag_config",
		{
			description:
				"Delete a Google tag config, e.g. one left behind after its GA4 or Ads tag was deleted. Without confirm: true, only previews.",
			input: workspaceInput.extend({ gtagConfigId: gtmId("Google tag config ID"), confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ confirm, ...ids }, { gtm }) => {
			const path = gtagConfigPath(ids);
			return deleteWithConfirm({
				confirm,
				kind: "gtag_config",
				id: ids.gtagConfigId,
				get: () => gtagConfigs.get(gtm, { path }),
				summarize: gtagConfigRow,
				remove: () => gtagConfigs.delete(gtm, { path }),
			});
		},
	);
};
