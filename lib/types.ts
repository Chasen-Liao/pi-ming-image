/**
 * Shared types and limits for the Ming image pipeline.
 */

export type MingTask = "design" | "layer";

export const MING_TASKS: readonly MingTask[] = ["design", "layer"];

export const TASK_MODELS: Record<MingTask, string> = {
	design: "inclusionai/ming-image-0.1-design",
	layer: "inclusionai/ming-image-0.1-design-layer",
};

/** Verified working endpoint (see ming-image-web-lab/scripts/ming-image.ps1). */
export const OPENROUTER_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";

export const PROVIDER_ID = "openrouter";

/** Layer uploads the referenced local file to OpenRouter; keep the payload bounded. */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 32_000;
/** Observed Design output is ~3.5 MB PNG; leave headroom but refuse absurd bodies. */
export const MAX_OUTPUT_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_OUTPUT_IMAGES = 16;
/** Ceiling for the whole JSON body: base64 inflates by 4/3, plus JSON framing. */
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
/** Error bodies are only mined for a short message, so they get a far smaller ceiling. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Design took ~59 s locally; layer decomposition is slower, so allow 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export const INPUT_IMAGE_EXTENSIONS: Record<string, ImageMime> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

export type UsageSummary = Partial<Record<"prompt_tokens" | "completion_tokens" | "total_tokens" | "cost", number>>;

export type DecodedImage = {
	bytes: Uint8Array;
	mime: ImageMime;
};

export type InputImage = {
	path: string;
	mime: ImageMime;
	base64: string;
	bytes: number;
};

export type RunManifest = {
	task: MingTask;
	model: string;
	prompt: string;
	prompt_file?: string;
	input_image?: string;
	input_image_bytes?: number;
	output_files: string[];
	elapsed_seconds: number;
	usage?: UsageSummary;
	created_at: string;
};
