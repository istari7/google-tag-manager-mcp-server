// Google API error → short, model-friendly message.
//
// Google's message is kept only when it adds information beyond our own
// sentence (see GTM_API_QUIRKS.md Q17). Messages never contain request headers, so the
// bearer token can't leak through an error.

/** One entry of Google's legacy `error.errors[]` array. */
export interface GoogleErrorItem {
	reason?: string;
	message?: string;
	domain?: string;
}

/** One entry of Google's `error.details[]` array (google.rpc.Status details). */
export interface GoogleErrorDetail {
	"@type"?: string;
	reason?: string;
	domain?: string;
	metadata?: Record<string, string>;
}

/** The JSON error body Google APIs return. */
export interface GoogleErrorBody {
	error?: {
		code?: number;
		message?: string;
		status?: string;
		errors?: GoogleErrorItem[];
		details?: GoogleErrorDetail[];
	};
}

export type GtmErrorKind =
	| "auth"
	| "permission"
	| "apiDisabled"
	| "scope"
	| "notFound"
	| "conflict"
	| "rateLimit"
	| "quota"
	| "invalid"
	| "server"
	| "network"
	| "invalidResponse"
	| "unknown";

export interface GtmApiErrorInit {
	status: number;
	kind: GtmErrorKind;
	method: string;
	path: string;
	reason?: string;
	googleStatus?: string;
	googleMessage?: string;
	cause?: unknown;
}

export const MESSAGES = {
	auth: "Google session expired. Reconnect the GTM connector.",
	rateLimit: "GTM API rate limit hit. Wait a minute and retry.",
	quota: "The GTM API daily quota for this Google Cloud project is used up. It resets at midnight Pacific time.",
	conflict:
		"It changed since it was read (possibly by an earlier call, even your own). Re-read it with get_* and retry with the new fingerprint.",
	apiDisabled:
		"The Tag Manager API is not enabled in this Google Cloud project. Enable it, wait a few minutes, then retry.",
	scope:
		"The connected Google account did not grant the permission this action needs. Reconnect the GTM connector and approve every requested permission.",
	network: "Could not reach the GTM API. Retry in a moment.",
	invalidResponse: "The GTM API returned a response that could not be read. Retry in a moment.",
} as const;

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
const QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded"]);
const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
const SCOPE_REASONS = new Set(["ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

/** Google messages that only restate the HTTP status; dropping them saves model tokens. */
const GENERIC_MESSAGES: readonly RegExp[] = [
	/^not found\.?$/i,
	/^requested entity was not found\.?$/i,
	/^the caller does not have permission\.?$/i,
	/^(forbidden|permission denied|insufficient permissions?)\.?$/i,
	/^request had invalid authentication credentials\b/i,
	/^(login required|invalid credentials|unauthenticated|unauthorized)\.?$/i,
	/^(internal error|internal error encountered|backend error|service unavailable|the service is currently unavailable|unknown error)\.?$/i,
	/^(quota exceeded|rate limit exceeded|user rate limit exceeded|too many requests|resource has been exhausted.*)\.?$/i,
	/^(conflict|precondition failed|fingerprint mismatch|aborted)\.?$/i,
	/^(bad request|invalid argument|request contains an invalid argument)\.?$/i,
];

const MAX_DETAIL_LENGTH = 500;

/** An error from the GTM API (or from reaching it), with a message safe to show the model. */
export class GtmApiError extends Error {
	override readonly name = "GtmApiError";
	/** HTTP status; 0 when the request never got a response. */
	readonly status: number;
	readonly kind: GtmErrorKind;
	readonly method: string;
	readonly path: string;
	/** First machine-readable reason Google gave (`errors[].reason` or `details[].reason`). */
	readonly reason: string | undefined;
	/** Google's canonical status, e.g. `PERMISSION_DENIED`. */
	readonly googleStatus: string | undefined;
	/** Google's raw message (already trimmed), kept for logs and debugging. */
	readonly googleMessage: string | undefined;

	constructor(message: string, init: GtmApiErrorInit) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.status = init.status;
		this.kind = init.kind;
		this.method = init.method;
		this.path = init.path;
		this.reason = init.reason;
		this.googleStatus = init.googleStatus;
		this.googleMessage = init.googleMessage;
	}

	/**
	 * True when the request may succeed if sent again after a pause (Q16).
	 * 429 and 403 rate limits are always safe: Google did not process the request.
	 * 5xx is retried only for GET: a write may have been applied before the failure,
	 * so resending it could create a duplicate or hit a false fingerprint conflict.
	 */
	get retryable(): boolean {
		if (this.status === 429) return true;
		if (this.status === 403) return this.kind === "rateLimit";
		return this.status >= 500 && this.method === "GET";
	}

	/** A local conflict: the caller's expected fingerprint no longer matches what Google has. */
	static conflict(method: string, path: string): GtmApiError {
		return new GtmApiError(MESSAGES.conflict, { status: 409, kind: "conflict", method, path });
	}
}

/** Caller input refused before anything is written (e.g. a field that needs a different stored state). Model-safe message. */
export class GtmInputError extends Error {
	override readonly name: string = "GtmInputError";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the Google error envelope out of an already-parsed body, tolerating junk. */
export function readGoogleError(body: unknown): NonNullable<GoogleErrorBody["error"]> | undefined {
	if (!isRecord(body) || !isRecord(body.error)) return undefined;
	const raw = body.error;
	const items: GoogleErrorItem[] = Array.isArray(raw.errors)
		? raw.errors
				.filter(isRecord)
				.map((e) => ({ reason: str(e.reason), message: str(e.message), domain: str(e.domain) }))
		: [];
	const details: GoogleErrorDetail[] = Array.isArray(raw.details)
		? raw.details
				.filter(isRecord)
				.map((d) => ({ "@type": str(d["@type"]), reason: str(d.reason), domain: str(d.domain) }))
		: [];
	return {
		code: typeof raw.code === "number" ? raw.code : undefined,
		message: str(raw.message),
		status: str(raw.status),
		errors: items,
		details,
	};
}

function reasonsOf(error: NonNullable<GoogleErrorBody["error"]> | undefined): string[] {
	if (!error) return [];
	const out: string[] = [];
	for (const e of error.errors ?? []) if (e.reason) out.push(e.reason);
	for (const d of error.details ?? []) if (d.reason) out.push(d.reason);
	return out;
}

function classify(
	status: number,
	reasons: readonly string[],
	googleStatus: string | undefined,
	message: string,
): GtmErrorKind {
	const has = (set: ReadonlySet<string>) => reasons.some((r) => set.has(r));
	if (status === 401) return "auth";
	if (status === 429) return has(QUOTA_REASONS) ? "quota" : "rateLimit";
	if (status === 403) {
		if (has(RATE_LIMIT_REASONS)) return "rateLimit";
		if (has(QUOTA_REASONS)) return "quota";
		if (has(API_DISABLED_REASONS) || /has not been used in project|is disabled/i.test(message)) return "apiDisabled";
		if (has(SCOPE_REASONS) || /insufficient authentication scopes/i.test(message)) return "scope";
		if (googleStatus === "RESOURCE_EXHAUSTED") return "rateLimit";
		return "permission";
	}
	if (status === 404) return "notFound";
	if (status === 409 || status === 412) return "conflict";
	if (status === 400) return "invalid";
	if (status >= 500) return "server";
	return "unknown";
}

/**
 * The parts of Google's error worth showing: distinct messages that say more
 * than the status code. Raw text bodies are used only when there's no
 * structured error (and aren't HTML).
 */
export function informativeDetail(
	error: NonNullable<GoogleErrorBody["error"]> | undefined,
	rawText = "",
): string | undefined {
	const candidates: string[] = [];
	if (error) {
		if (error.message) candidates.push(error.message);
		for (const e of error.errors ?? []) if (e.message) candidates.push(e.message);
	} else {
		const text = rawText.trim();
		if (text && !text.startsWith("<")) candidates.push(text);
	}
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const c of candidates) {
		const key = c.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (GENERIC_MESSAGES.some((re) => re.test(c))) continue;
		kept.push(c);
	}
	if (kept.length === 0) return undefined;
	const joined = kept.join(" / ");
	return joined.length > MAX_DETAIL_LENGTH ? `${joined.slice(0, MAX_DETAIL_LENGTH - 1)}…` : joined;
}

function withDetail(base: string, detail: string | undefined): string {
	return detail ? `${base} Google says: ${detail}` : base;
}

/** Singular names for API path collections whose plural doesn't just lose an "s". */
const COLLECTION_LABELS: Record<string, string> = {
	built_in_variables: "built-in variable",
	gtag_config: "Google tag config",
	user_permissions: "user permission",
};

/**
 * Which IDs to check after a 404, read from the path, innermost first:
 * `accounts/1/containers/2/workspaces/3/tags/4` → "Check the tag ID, then the
 * account/container/workspace IDs."
 */
export function notFoundHint(resource: string): string {
	const segments = resource.split("/");
	const kinds: string[] = [];
	for (let i = 0; i + 1 < segments.length; i += 2) {
		const collection = segments[i] ?? "";
		const id = (segments[i + 1] ?? "").split(":")[0] ?? "";
		if (!/^\d+$/.test(id)) break;
		kinds.push(COLLECTION_LABELS[collection] ?? collection.replace(/_/g, " ").replace(/s$/, ""));
	}
	const inner = kinds.pop();
	if (!inner) return "Check the IDs in this path.";
	if (kinds.length === 0) return `Check the ${inner} ID.`;
	return `Check the ${inner} ID, then the ${kinds.join("/")} ID${kinds.length > 1 ? "s" : ""}.`;
}

function resourceOf(path: string): string {
	const q = path.indexOf("?");
	return q === -1 ? path : path.slice(0, q);
}

/** Build the friendly error for a non-2xx response. `body` is the parsed JSON, or undefined. */
export function toGtmApiError(input: {
	status: number;
	method: string;
	path: string;
	body: unknown;
	rawText?: string;
}): GtmApiError {
	const { status, method, path } = input;
	const google = readGoogleError(input.body);
	const reasons = reasonsOf(google);
	const googleMessage = google?.message;
	const kind = classify(status, reasons, google?.status, googleMessage ?? "");
	const detail = informativeDetail(google, input.rawText);
	const resource = resourceOf(path);

	let message: string;
	switch (kind) {
		case "auth":
			message = MESSAGES.auth;
			break;
		case "rateLimit":
			message = MESSAGES.rateLimit;
			break;
		case "quota":
			message = MESSAGES.quota;
			break;
		case "apiDisabled":
			// Google's message carries the console link to enable the API; always keep it.
			message = withDetail(MESSAGES.apiDisabled, detail);
			break;
		case "scope":
			message = MESSAGES.scope;
			break;
		case "permission":
			message = withDetail(`No permission for ${resource}. Check the Google account has access.`, detail);
			break;
		case "notFound":
			message = withDetail(`Not found: ${resource}. ${notFoundHint(resource)}`, detail);
			break;
		case "conflict":
			message = withDetail(MESSAGES.conflict, detail);
			break;
		case "invalid":
			message = detail
				? `GTM rejected the request: ${detail}`
				: "GTM rejected the request as invalid. Check field names and parameter types.";
			break;
		case "server":
			// Q16: a failed write is not retried, because Google may have applied it.
			message =
				method === "GET"
					? withDetail(`The GTM API is temporarily unavailable (HTTP ${status}). Retry in a minute.`, detail)
					: withDetail(
							`The GTM API failed (HTTP ${status}) during a ${method} to ${resource}. The write may or may not have been applied: re-read the affected entity (get_* or list_*) before retrying, so a retry doesn't create a duplicate or report a false conflict.`,
							detail,
						);
			break;
		default:
			message = withDetail(`GTM API error (HTTP ${status}).`, detail);
	}

	return new GtmApiError(message, {
		status,
		kind,
		method,
		path,
		reason: reasons[0],
		googleStatus: google?.status,
		googleMessage,
	});
}
