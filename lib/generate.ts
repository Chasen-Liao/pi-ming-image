/**
 * The single implementation both `/ming-image` and `generate_ming_image` call.
 *
 * Guarantees: nothing is written unless a full response arrives, and a failure
 * or cancellation removes the partially written directory instead of reporting
 * a bogus success.
 */

import { assertNotCancelled, MingImageError } from "./errors.ts";
import { allocateOutputDir, discardOutputDir, writeRun } from "./artifacts.ts";
import { requestImages } from "./openrouter.ts";
import { PROVIDER_ID, TASK_MODELS, type InputImage, type MingTask, type RunManifest, type UsageSummary } from "./types.ts";
import { assertPrompt, loadInputImage } from "./validate.ts";

export type TokenSource = {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
};

export type GenerateRequest = {
	task: MingTask;
	/** Raw prompt text. Callers using the command read it from a file first. */
	prompt: string;
	/** Recorded in the manifest when the prompt came from a file. */
	promptFile?: string;
	imagePath?: string;
	cwd: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	token?: string;
	tokenSource?: TokenSource;
	env?: Record<string, string | undefined>;
};

export type GenerateSuccess = {
	outputDir: string;
	files: string[];
	manifestPath: string;
	elapsedSeconds: number;
	usage: UsageSummary | undefined;
	model: string;
	task: MingTask;
	inputImage?: string;
};

/**
 * Resolve an OpenRouter token from the registry first, then the environment.
 * The token is returned to the caller only; it is never logged or persisted.
 */
export async function resolveToken(source?: TokenSource, env: Record<string, string | undefined> = process.env): Promise<string> {
	const fromRegistry = await source?.getApiKeyForProvider(PROVIDER_ID).catch(() => undefined);
	const token = fromRegistry?.trim() || env.OPENROUTER_API_KEY?.trim();
	if (!token) {
		throw new MingImageError(
			"missing_credential",
			"No OpenRouter credential. Run `pi auth check --provider openrouter` or set OPENROUTER_API_KEY.",
		);
	}
	return token;
}

export async function generateMingImage(request: GenerateRequest): Promise<GenerateSuccess> {
	const { task, cwd, signal, fetchImpl } = request;

	const prompt = assertPrompt(request.prompt);
	if (task === "design" && request.imagePath) {
		throw new MingImageError("invalid_input", "Design accepts text only; it cannot take an input image.");
	}
	if (task === "layer" && !request.imagePath) {
		throw new MingImageError("invalid_input", "Layer requires a local image path.");
	}

	let inputImage: InputImage | undefined;
	if (request.imagePath) {
		inputImage = await loadInputImage(request.imagePath, cwd);
	}

	const token = request.token ?? (await resolveToken(request.tokenSource, request.env ?? process.env));

	const started = Date.now();
	const result = await requestImages({
		task,
		prompt,
		inputImage,
		token,
		signal,
		fetchImpl,
	});

	assertNotCancelled(signal);
	const outputDir = await allocateOutputDir(cwd, task);
	try {
		assertNotCancelled(signal);
		const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
		const manifest: RunManifest = {
			task,
			model: TASK_MODELS[task],
			prompt,
			...(request.promptFile ? { prompt_file: request.promptFile } : {}),
			...(inputImage ? { input_image: inputImage.path, input_image_bytes: inputImage.bytes } : {}),
			output_files: [],
			elapsed_seconds: elapsedSeconds,
			usage: result.usage,
			created_at: new Date().toISOString(),
		};
		const written = await writeRun(outputDir, result.images, manifest, signal);
		assertNotCancelled(signal);
		return {
			outputDir,
			files: written.files.map((name) => `${outputDir}/${name}`.replace(/\\/g, "/")),
			manifestPath: written.manifestPath,
			elapsedSeconds,
			usage: result.usage,
			model: manifest.model,
			task,
			...(inputImage ? { inputImage: inputImage.path } : {}),
		};
	} catch (error) {
		await discardOutputDir(outputDir);
		throw error;
	}
}
