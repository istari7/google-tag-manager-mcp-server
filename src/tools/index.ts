// Every tool group, in tools/list order. Adding a group = one import + one line here.
// See the "Adding tools" comment in src/mcp/server.ts.

import type { ToolGroup } from "../mcp/registry";
import { accountTools } from "./accounts";
import { builtInTools } from "./builtins";
import { destinationTools } from "./destinations";
import { environmentTools } from "./environments";
import { folderTools } from "./folders";
import { gtagConfigTools } from "./gtag-configs";
import { tagTools } from "./tags";
import { triggerTools } from "./triggers";
import { userTools } from "./users";
import { utilityTools } from "./utility";
import { variableTools } from "./variables";
import { versionTools } from "./versions";
import { workspaceTools } from "./workspaces";
import { zoneTools } from "./zones";

export const TOOL_GROUPS: readonly ToolGroup[] = [
	utilityTools,
	accountTools,
	userTools,
	workspaceTools,
	tagTools,
	triggerTools,
	variableTools,
	builtInTools,
	folderTools,
	zoneTools, // group: zones
	gtagConfigTools, // group: gtag
	versionTools,
	environmentTools, // group: environments
	destinationTools, // group: destinations
];
