/**
 * Single request path against OpenRouter `POST /api/v1/images`.
 *
 * Design sends text only; Layer adds exactly one image as a data URL. Neither
 * task sends size or aspect_ratio. There is no automatic retry: a retry would
 * silently duplicate a billable generation.
 */

import { MingImageError, summarizeUpstreamMessage } from "./errors.ts";
import {
	DEFAULT_TIMEOUT_MS,
	MAX_ERROR_BODY_BYTES,
	MAX_OUTPUT_IMAGES,
	MAX_RESPONSE_BYTES,
	OPENROUTER_IMAGE_ENDPOINT,
	TASK_MODELS,
	type DecodedImage,
	type InputImage,
	type MingTask,
	type UsageSummary,
} from "./types.ts";
import { decodeBase64Image, formatBytes } from "./validate.ts";

export type RequestOptions = {
	task: MingTask;
	prompt: string;
	inputImage?: InputImage;
	token: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
};

export type RequestResult = {
	images: DecodedImage[];
	usage: UsageSummary | undefined;
};

function safeUsage(raw: unknown, token: string): UsageSummary | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const summary: UsageSummary = {};
	for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"] as const) {
		const value = source[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
		if (key !== "cost" && !Number.isSafeInteger(value)) continue;
		// Even an unusual numeric credential must not be re-emitted as a statistic.
		if (token && String(value).includes(token)) continue;
		summary[key] = value;
	}
	return Object.keys(summary).length ? summary : undefined;
}

export function buildRequestBody(task: MingTask, prompt: string, inputImage?: InputImage): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: TASK_MODELS[task],
		prompt,
		output_format: "png",
	};
	if (task === "layer") {
		if (!inputImage) {
			throw new MingImageError("invalid_input", "Layer requires an input image.");
		}
		body.input_references = [
			{
				type: "image_url",
				image_url: { url: `data:${inputImage.mime};base64,${inputImage.base64}` },
			},
		];
	} else if (inputImage) {
		throw new MingImageError("invalid_input", "Design accepts text only; it cannot take an input image.");
	}
	return body;
}

function statusToError(status: number, detail: string | undefined): MingImageError {
	if (status === 402) {
		return new MingImageError("insufficient_credit", "OpenRouter reports insufficient credit for this request.");
	}
	if (status === 429) {
		return new MingImageError("rate_limited", "OpenRouter rate limited the request. Try again shortly.");
	}
	if (status === 401 || status === 403) {
		return new MingImageError("missing_credential", `OpenRouter rejected the credential (HTTP ${status}).`);
	}
	return new MingImageError(
		"upstream_error",
		detail ? `OpenRouter request failed (HTTP ${status}): ${detail}` : `OpenRouter request failed (HTTP ${status}).`,
	);
}

/** Release an unread body so the underlying connection is not left half-open. */
async function discardResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Already consumed, already errored, or nothing to release.
	}
}

async function readBoundedBody(response: Response, limit: number, label: string): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				void reader.cancel().catch(() => {});
				throw new MingImageError("bad_response", `${label} exceeded the ${formatBytes(limit)} limit.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readErrorDetail(response: Response, token: string): Promise<string | undefined> {
	try {
		const declared = Number(response.headers?.get?.("content-length") ?? NaN);
		if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) {
			return `error body ${formatBytes(declared)} exceeded ${formatBytes(MAX_ERROR_BODY_BYTES)}`;
		}
		const text = new TextDecoder().decode(await readBoundedBody(response, MAX_ERROR_BODY_BYTES, "error body"));
		if (!text) return undefined;
		let message = text;
		try {
			const parsed = JSON.parse(text) as { error?: { message?: unknown } };
			if (typeof parsed.error?.message === "string") message = parsed.error.message;
		} catch {
			// Not JSON; fall through to the raw text.
		}
		return summarizeUpstreamMessage(token ? message.replaceAll(token, "[REDACTED]") : message);
	} catch (error) {
		return error instanceof MingImageError ? error.message : undefined;
	}
}

export async function requestImages(options: RequestOptions): Promise<RequestResult> {
	const { task, prompt, inputImage, token, signal, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

	const body = buildRequestBody(task, prompt, inputImage);
	// A signal that aborted BEFORE this call never fires another "abort" event, so an
	// already-cancelled request would otherwise run to completion — billed and written.
	if (signal?.aborted) {
		throw new MingImageError("cancelled", "Request cancelled.");
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onCallerAbort = () => controller.abort();
	signal?.addEventListener("abort", onCallerAbort, { once: true });

	// The timer and the abort listener must stay armed until the body is fully read.
	// fetch() resolves when response HEADERS arrive, so clearing them right after the
	// call would leave the stream read with no timeout and no way to cancel a stalled body.
	let response: Response;
	let payload: { data?: unknown; usage?: unknown };
	try {
		response = await fetchImpl(OPENROUTER_IMAGE_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw statusToError(response.status, await readErrorDetail(response, token));
		}
		// Reject an oversized body from its declared length before materialising it.
		// base64 inflates by 4/3, so allow for that plus JSON framing.
		const declared = Number(response.headers?.get?.("content-length") ?? NaN);
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
			// The body is never read on this path, so it has to be released
			// explicitly or the connection stays half-open in the fetch pool.
			await discardResponseBody(response);
			throw new MingImageError(
				"bad_response",
				`OpenRouter response is ${formatBytes(declared)}; the limit is ${formatBytes(MAX_RESPONSE_BYTES)}.`,
			);
		}
		const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, "OpenRouter response");
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes)) as { data?: unknown; usage?: unknown };
		} catch (error) {
			throw new MingImageError("bad_response", "OpenRouter returned a body that is not valid JSON.", {
				cause: error,
			});
		}
	} catch (error) {
		// Cancellation takes precedence even when a fetch double returns a response after abort.
		if (timedOut) {
			throw new MingImageError("timeout", `OpenRouter did not respond within ${Math.round(timeoutMs / 1000)}s.`);
		}
		if (signal?.aborted || controller.signal.aborted) {
			throw new MingImageError("cancelled", "Request cancelled.");
		}
		if (error instanceof MingImageError) throw error;
		// Transport errors are untrusted too: some clients include request headers in their messages.
		throw new MingImageError("upstream_error", "Could not reach OpenRouter.", { cause: error });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onCallerAbort);
	}

	if (signal?.aborted) throw new MingImageError("cancelled", "Request cancelled.");
	if (timedOut) throw new MingImageError("timeout", `OpenRouter did not respond within ${Math.round(timeoutMs / 1000)}s.`);

	if (!Array.isArray(payload.data)) {
		throw new MingImageError("bad_response", "OpenRouter response has no image array.");
	}
	if (payload.data.length === 0) {
		throw new MingImageError("empty_result", "OpenRouter returned no images.");
	}
	if (payload.data.length > MAX_OUTPUT_IMAGES) {
		throw new MingImageError(
			"bad_response",
			`OpenRouter returned ${payload.data.length} images; the limit is ${MAX_OUTPUT_IMAGES}.`,
		);
	}

	const images: DecodedImage[] = payload.data.map((item, index) => {
		const b64 = (item as { b64_json?: unknown } | null)?.b64_json;
		if (typeof b64 !== "string" || !b64) {
			throw new MingImageError("bad_response", `Image ${index + 1} has no b64_json field.`);
		}
		return decodeBase64Image(b64, index + 1);
	});

	if (signal?.aborted) throw new MingImageError("cancelled", "Request cancelled.");
	return { images, usage: safeUsage(payload.usage, token) };
}
