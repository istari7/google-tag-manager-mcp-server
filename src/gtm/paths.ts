// GTM resource path builders and parsers. Every ID is validated as a numeric
// string before it goes into a path, so tool input can't reshape the URL.

export class InvalidGtmIdError extends TypeError {
	override readonly name = "InvalidGtmIdError";
}

const NUMERIC_ID = /^\d{1,20}$/;
const PUBLIC_CONTAINER_ID = /^GTM-[A-Z0-9]{4,12}$/;

/** Throws unless `value` is a numeric GTM ID such as "1234567890". Returns it unchanged. */
export function assertGtmId(label: string, value: string): string {
	if (typeof value !== "string" || !NUMERIC_ID.test(value)) {
		throw new InvalidGtmIdError(`${label} must be a numeric ID (got ${JSON.stringify(value)}).`);
	}
	return value;
}

export function isGtmId(value: unknown): value is string {
	return typeof value === "string" && NUMERIC_ID.test(value);
}

/** Public container IDs look like "GTM-ABC1234" (used by containers:lookup, not in paths). */
export function isPublicContainerId(value: unknown): value is string {
	return typeof value === "string" && PUBLIC_CONTAINER_ID.test(value);
}

export interface AccountIds {
	accountId: string;
}
export interface ContainerIds extends AccountIds {
	containerId: string;
}
export interface WorkspaceIds extends ContainerIds {
	workspaceId: string;
}
export interface TagIds extends WorkspaceIds {
	tagId: string;
}
export interface TriggerIds extends WorkspaceIds {
	triggerId: string;
}
export interface VariableIds extends WorkspaceIds {
	variableId: string;
}
export interface FolderIds extends WorkspaceIds {
	folderId: string;
}
export interface VersionIds extends ContainerIds {
	versionId: string;
}
export interface GtagConfigIds extends WorkspaceIds {
	gtagConfigId: string;
}
export interface ZoneIds extends WorkspaceIds {
	zoneId: string;
}
export interface EnvironmentIds extends ContainerIds {
	environmentId: string;
}
export interface DestinationIds extends ContainerIds {
	destinationLinkId: string;
}
export interface ClientIds extends WorkspaceIds {
	clientId: string;
}
export interface TransformationIds extends WorkspaceIds {
	transformationId: string;
}

export function accountPath(ids: AccountIds): string {
	return `accounts/${assertGtmId("accountId", ids.accountId)}`;
}

export function containerPath(ids: ContainerIds): string {
	return `${accountPath(ids)}/containers/${assertGtmId("containerId", ids.containerId)}`;
}

export function workspacePath(ids: WorkspaceIds): string {
	return `${containerPath(ids)}/workspaces/${assertGtmId("workspaceId", ids.workspaceId)}`;
}

export function tagPath(ids: TagIds): string {
	return `${workspacePath(ids)}/tags/${assertGtmId("tagId", ids.tagId)}`;
}

export function triggerPath(ids: TriggerIds): string {
	return `${workspacePath(ids)}/triggers/${assertGtmId("triggerId", ids.triggerId)}`;
}

export function variablePath(ids: VariableIds): string {
	return `${workspacePath(ids)}/variables/${assertGtmId("variableId", ids.variableId)}`;
}

/** Folder "0" is valid for move_entities_to_folder: it moves entities out of their folder. */
export function folderPath(ids: FolderIds): string {
	return `${workspacePath(ids)}/folders/${assertGtmId("folderId", ids.folderId)}`;
}

/** Path used by built_in_variables create/delete/revert (`{workspace}/built_in_variables`). */
export function builtInVariablesPath(ids: WorkspaceIds): string {
	return `${workspacePath(ids)}/built_in_variables`;
}

export function gtagConfigPath(ids: GtagConfigIds): string {
	return `${workspacePath(ids)}/gtag_config/${assertGtmId("gtagConfigId", ids.gtagConfigId)}`;
}

export function zonePath(ids: ZoneIds): string {
	return `${workspacePath(ids)}/zones/${assertGtmId("zoneId", ids.zoneId)}`;
}

export function environmentPath(ids: EnvironmentIds): string {
	return `${containerPath(ids)}/environments/${assertGtmId("environmentId", ids.environmentId)}`;
}

/**
 * Destination link IDs and destination IDs ("G-ABC123", "AW-123") are not always numeric, so
 * they get their own check: letters, digits, "_" and "-" only, so they can't reshape a path.
 */
const DESTINATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isDestinationId(value: unknown): value is string {
	return typeof value === "string" && DESTINATION_ID.test(value);
}

export function destinationPath(ids: DestinationIds): string {
	if (!isDestinationId(ids.destinationLinkId)) {
		throw new InvalidGtmIdError(`destinationLinkId is not a valid ID (got ${JSON.stringify(ids.destinationLinkId)}).`);
	}
	return `${containerPath(ids)}/destinations/${ids.destinationLinkId}`;
}

/** Server containers only. */
export function clientPath(ids: ClientIds): string {
	return `${workspacePath(ids)}/clients/${assertGtmId("clientId", ids.clientId)}`;
}

/** Server containers only. */
export function transformationPath(ids: TransformationIds): string {
	return `${workspacePath(ids)}/transformations/${assertGtmId("transformationId", ids.transformationId)}`;
}

export function versionPath(ids: VersionIds): string {
	return `${containerPath(ids)}/versions/${assertGtmId("versionId", ids.versionId)}`;
}

export type WorkspaceEntityKind = "tags" | "triggers" | "variables" | "folders";

export interface ParsedGtmPath {
	accountId: string;
	containerId?: string;
	workspaceId?: string;
	versionId?: string;
	entity?: { kind: WorkspaceEntityKind; id: string };
}

const ENTITY_KINDS: readonly WorkspaceEntityKind[] = ["tags", "triggers", "variables", "folders"];

/**
 * Parse an account / container / workspace / entity / version path back into
 * IDs. Throws InvalidGtmIdError on anything else.
 */
export function parseGtmPath(path: string): ParsedGtmPath {
	const fail = (): never => {
		throw new InvalidGtmIdError(`Not a GTM path: ${JSON.stringify(path)}`);
	};
	if (typeof path !== "string") return fail();
	const s = path.split("/");
	const id = (i: number): string => {
		const v = s[i];
		return v !== undefined && NUMERIC_ID.test(v) ? v : fail();
	};
	if (s[0] !== "accounts") return fail();
	const out: ParsedGtmPath = { accountId: id(1) };
	if (s.length === 2) return out;
	if (s[2] !== "containers") return fail();
	out.containerId = id(3);
	if (s.length === 4) return out;
	if (s[4] === "versions" && s.length === 6) {
		out.versionId = id(5);
		return out;
	}
	if (s[4] !== "workspaces") return fail();
	out.workspaceId = id(5);
	if (s.length === 6) return out;
	const kind = ENTITY_KINDS.find((k) => k === s[6]);
	if (kind === undefined || s.length !== 8) return fail();
	out.entity = { kind, id: id(7) };
	return out;
}
