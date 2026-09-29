/**
 * Ming Image — Pi extension.
 *
 * Exposes one implementation through two entry points:
 *   /ming-image design|layer <prompt-file> [image-path]
 *   generate_ming_image  { task, prompt, imagePath? }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseMingCommand, USAGE } from "../lib/command-args.ts";
import { MingImageError } from "../lib/errors.ts";
import { generateMingImage, type GenerateSuccess } from "../lib/generate.ts";
import { MING_TASKS } from "../lib/types.ts";
import { formatBytes, readPromptFile } from "../lib/validate.ts";

function describeFailure(error: unknown): string {
	if (error instanceof MingImageError) return `${error.code}: ${error.message}`;
	return `unexpected_error: ${error instanceof Error ? error.message : String(error)}`;
}

function describeSuccess(result: GenerateSuccess): string {
	const cost = (result.usage as { cost?: unknown } | undefined)?.cost;
	const costText = typeof cost === "number" ? `, cost ${cost}` : "";
	return [
		`${result.task}: ${result.files.length} image(s) in ${result.outputDir}`,
		...result.files.map((file) => `  ${file}`),
		`manifest: ${result.manifestPath}`,
		`elapsed: ${result.elapsedSeconds}s${costText}`,
		result.task === "layer" ? "Inspect every layer: the model decides how many it returns and they may not match the request." : "",
	]
		.filter(Boolean)
		.join("\n");
}

export default function mingImageExtension(pi: ExtensionAPI) {
	const run = async (ctx: ExtensionContext, label: string, action: () => Promise<GenerateSuccess>) => {
		ctx.ui.notify(`${label}…`, "info");
		try {
			const result = await action();
			ctx.ui.notify(describeSuccess(result), "success");
		} catch (error) {
			ctx.ui.notify(describeFailure(error), "error");
		}
	};

	pi.registerTool({
		name: "generate_ming_image",
		label: "Ming Image",
		description: [
			"Generate images with the Ming models on OpenRouter, or decompose an existing local image into editable layers.",
			'task "design": text-to-image from the prompt alone. Use it for new artwork, mockups, and visual concepts.',
			'task "layer": decompose the ONE local PNG/JPEG/WebP named by imagePath into transparent layers. imagePath is required.',
			"UPLOAD NOTICE: task=layer sends the file at imagePath to OpenRouter. Only pass images the user has allowed to be uploaded.",
			"Returns saved file paths. The layer count and roles are decided by the model and may not match the prompt; always inspect the saved files.",
		].join(" "),
		promptSnippet: "generate_ming_image: text-to-image (design) or image layer decomposition (layer)",
		parameters: Type.Object({
			task: Type.Union([Type.Literal("design"), Type.Literal("layer")], {
				description: 'design for text-to-image; layer to decompose one existing local image',
			}),
			prompt: Type.String({ description: "What to generate, or how to decompose the input image." }),
			imagePath: Type.Optional(
				Type.String({ description: "Local image for task=layer. Required for layer, rejected for design." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Arguments are passed to the model, so validate before spending a request.
			if (params.task === "layer" && !params.imagePath) {
				throw new MingImageError("invalid_input", "task=layer requires imagePath.");
			}
			if (params.task === "design" && params.imagePath) {
				throw new MingImageError("invalid_input", "task=design does not accept imagePath.");
			}
			if (!MING_TASKS.includes(params.task)) {
				throw new MingImageError("invalid_input", `Unknown task "${params.task}".`);
			}

			const result = await generateMingImage({
				task: params.task,
				prompt: params.prompt,
				imagePath: params.imagePath,
				cwd: ctx.cwd,
				signal,
				tokenSource: ctx.modelRegistry,
			});
			// Paths and counts only; image bytes stay on disk.
			return { content: [{ type: "text", text: describeSuccess(result) }], details: result };
		},
	});

	pi.registerCommand("ming-image", {
		description: "Generate images or decompose a local image into layers via OpenRouter",
		handler: async (args, ctx) => {
			const parsed = parseMingCommand(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			let prompt: string;
			let promptFile: string;
			try {
				const read = await readPromptFile(parsed.promptFile, ctx.cwd);
				prompt = read.prompt;
				promptFile = read.file;
			} catch (error) {
				ctx.ui.notify(describeFailure(error), "error");
				return;
			}

			await run(ctx, `/ming-image ${parsed.task}`, async () =>
				generateMingImage({
					task: parsed.task,
					prompt,
					promptFile,
					imagePath: parsed.imagePath,
					cwd: ctx.cwd,
					// Commands are user-initiated, so the agent is usually not streaming and
					// ctx.signal is undefined. Cancellation is then genuinely unavailable —
					// a private controller here would be dead code, not a feature.
					signal: ctx.signal,
					tokenSource: ctx.modelRegistry,
				}),
			);
		},
	});
}
