/**
 * Error codes the command and the tool both translate into user-facing text.
 *
 * Messages must never embed credentials, base64 payloads, or raw upstream bodies.
 */

export type MingErrorCode =
	| "invalid_input"
	| "missing_credential"
	| "insufficient_credit"
	| "rate_limited"
	| "upstream_error"
	| "empty_result"
	| "bad_response"
	| "cancelled"
	| "timeout"
	| "write_failed";

export class MingImageError extends Error {
	readonly code: MingErrorCode;

	constructor(code: MingErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MingImageError";
		this.code = code;
	}
}

export function assertNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new MingImageError("cancelled", "Request cancelled.");
}

export function isMingImageError(value: unknown): value is MingImageError {
	return value instanceof MingImageError;
}

/** Keep upstream text short and single-line so it stays readable in the TUI. */
export function summarizeUpstreamMessage(raw: string): string | undefined {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}
