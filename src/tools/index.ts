// Every tool module, in tools/list order, each tagged with the GTM_TOOL_GROUPS group it
// belongs to (src/tools/groups.ts). Adding a module = one import + one line here:
//
//   { group: "zones", register: zoneTools },
//
// A file whose tools belong to two groups exports one ToolGroup per group (version-admin.ts).
// `core` modules are always on and can't be switched off. See the "Adding tools" comment in
// src/mcp/server.ts.

import type { ToolGroup } from "../mcp/registry";
import { accountTools } from "./accounts";
import { builtInTools } from "./builtins";
import { containerAdminTools } from "./container-admin";
import { destinationTools } from "./destinations";
import { environmentTools } from "./environments";
import { folderAdminTools } from "./folder-admin";
import { folderTools } from "./folders";
import type { ToolGroupName, ToolGroupSelection } from "./groups";
import { gtagConfigTools } from "./gtag-configs";
import { guidanceTools } from "./guidance";
import { revertTools } from "./reverts";
import { serverTools } from "./server-side";
import { tagTools } from "./tags";
import { templateTools } from "./templates";
import { triggerTools } from "./triggers";
import { userTools } from "./users";
import { utilityTools } from "./utility";
import { variableTools } from "./variables";
import { versionAdminTools, versionReadTools } from "./version-admin";
import { versionTools } from "./versions";
import { workspaceAdminTools } from "./workspace-admin";
import { workspaceTools } from "./workspaces";
import { zoneTools } from "./zones";

export interface ToolModule {
	group: ToolGroupName | "core";
	register: ToolGroup;
}

export const TOOL_MODULES: readonly ToolModule[] = [
	{ group: "core", register: utilityTools },
	{ group: "accounts", register: accountTools },
	{ group: "users", register: userTools },
	{ group: "workspaces", register: workspaceTools },
	{ group: "tags", register: tagTools },
	{ group: "triggers", register: triggerTools },
	{ group: "variables", register: variableTools },
	{ group: "builtins", register: builtInTools },
	{ group: "folders", register: folderTools },
	{ group: "folder-admin", register: folderAdminTools },
	{ group: "zones", register: zoneTools },
	{ group: "gtag", register: gtagConfigTools },
	{ group: "server", register: serverTools },
	{ group: "templates", register: templateTools },
	{ group: "guidance", register: guidanceTools },
	{ group: "workspaces", register: versionTools },
	{ group: "workspaces", register: versionReadTools },
	{ group: "workspace-admin", register: workspaceAdminTools },
	{ group: "version-admin", register: versionAdminTools },
	{ group: "reverts", register: revertTools },
	{ group: "container-admin", register: containerAdminTools },
	{ group: "environments", register: environmentTools },
	{ group: "destinations", register: destinationTools },
];

/** The modules to register for the selected groups, in tools/list order. */
export function toolModulesFor(groups: ToolGroupSelection): ToolGroup[] {
	return TOOL_MODULES.filter((m) => m.group === "core" || groups.has(m.group)).map((m) => m.register);
}
