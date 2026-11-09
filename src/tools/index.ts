// Every tool group, in tools/list order. Adding a group = one import + one line here.
// See the "Adding tools" comment in src/mcp/server.ts.

import type { ToolGroup } from "../mcp/registry";
import { accountTools } from "./accounts";
import { builtInTools } from "./builtins";
import { containerAdminTools } from "./container-admin";
import { folderAdminTools } from "./folder-admin";
import { folderTools } from "./folders";
import { gtagConfigTools } from "./gtag-configs";
import { revertTools } from "./reverts";
import { tagTools } from "./tags";
import { triggerTools } from "./triggers";
import { userTools } from "./users";
import { utilityTools } from "./utility";
import { variableTools } from "./variables";
import { versionAdminTools } from "./version-admin";
import { versionTools } from "./versions";
import { workspaceAdminTools } from "./workspace-admin";
import { workspaceTools } from "./workspaces";

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
	gtagConfigTools,
	versionTools,
	workspaceAdminTools, // group: workspace-admin
	versionAdminTools, // group: version-admin
	revertTools, // group: reverts
	folderAdminTools, // group: folder-admin
	containerAdminTools, // group: container-admin
];
