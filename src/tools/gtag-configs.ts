// Google tag configs (gtagConfig): settings GTM creates by itself next to GA4 event, Google Ads
// conversion and Floodlight tags. Deleting those tags leaves the configs behind (Q23).

import { accounts, type GtagConfig } from "../gtm/generated";
import { gtagConfigPath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { addDeleteTool, addListTool, workspaceEntity } from "./entity";
import { gtmId, workspaceInput } from "./inputs";

const gtagConfigs = accounts.containers.workspaces.gtagConfig;

export function gtagConfigRow(g: GtagConfig) {
	return { gtagConfigId: g.gtagConfigId, type: g.type, parameter: g.parameter };
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

export const gtagConfigTools: ToolGroup = (tools) => {
	addListTool(tools, gtagConfig, {
		name: "list_gtag_configs",
		key: "gtagConfigs",
		description:
			"List a workspace's Google tag configs (gtagConfig), which GTM creates with GA4, Google Ads and Floodlight tags.",
	});

	addDeleteTool(tools, gtagConfig, {
		name: "delete_gtag_config",
		description:
			"Delete a Google tag config, e.g. one left behind after its GA4 or Ads tag was deleted. Without confirm: true, only previews.",
	});
};
