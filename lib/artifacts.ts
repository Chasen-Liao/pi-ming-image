/**
 * Artifact directory allocation, image writing, and manifest emission.
 *
 * The manifest records caller metadata and allowlisted numeric usage statistics;
 * raw upstream payloads, token echoes, and image base64 are not persisted.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertNotCancelled, MingImageError } from "./errors.ts";
import { makePngPreview } from "./png.ts";
import {
	PREVIEW_DIRNAME,
	PREVIEW_MAX_BYTES,
	PREVIEW_MAX_DIMENSION,
	PREVIEW_MIN_DIMENSION,
	type DecodedImage,
	type MingTask,
	type RunManifest,
} from "./types.ts";

const EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
};

function timestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

/**
 * Create `artifacts/<task>-<stamp>` under `cwd`, adding a numeric suffix on collision.
 *
 * Uses non-recursive mkdir so two parallel runs cannot claim the same directory.
 */
export async function allocateOutputDir(cwd: string, task: MingTask, now = new Date()): Promise<string> {
	const root = path.join(cwd, "artifacts");
	try {
		await mkdir(root, { recursive: true });
	} catch (error) {
		throw new MingImageError("write_failed", `Cannot create ${root}`, { cause: error });
	}

	const base = path.join(root, `${task}-${timestamp(now)}`);
	for (let attempt = 0; attempt < 100; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
		try {
			await mkdir(candidate);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw new MingImageError("write_failed", `Cannot create output directory ${candidate}`, { cause: error });
		}
	}
	throw new MingImageError("write_failed", `Could not allocate an output directory under ${root}`);
}

/**
 * Write a small PNG preview of one image.
 *
 * Best effort by design: the run has already been billed, so an image this
 * module cannot decode loses its preview and nothing else. Only PNG is handled
 * — JPEG and WebP would need decoders the package deliberately does not carry.
 */
async function writePreview(previewDir: string, name: string, image: DecodedImage): Promise<string | undefined> {
	if (image.mime !== "image/png") return undefined;
	const preview = makePngPreview(image.bytes, {
		maxDimension: PREVIEW_MAX_DIMENSION,
		maxBytes: PREVIEW_MAX_BYTES,
		minDimension: PREVIEW_MIN_DIMENSION,
	});
	if (!preview) return undefined;
	// A preview exists to cut what the model has to read. If this image already
	// compresses so well that the preview is not smaller, it buys nothing and
	// would only add a file.
	if (preview.bytes.length >= image.bytes.length) return undefined;
	// Downstream scripts glob `layer_*.png` non-recursively, so previews stay in
	// their own directory and cannot be mistaken for a real layer.
	await mkdir(previewDir, { recursive: true });
	await writeFile(path.join(previewDir, name), preview.bytes);
	return `${PREVIEW_DIRNAME}/${name}`;
}

/** Write every image plus the manifest. Removes the directory if any write fails. */
export async function writeRun(
	outputDir: string,
	images: DecodedImage[],
	manifest: RunManifest,
	signal?: AbortSignal,
): Promise<{ files: string[]; previewFiles: string[]; manifestPath: string }> {
	const written: string[] = [];
	const previews: string[] = [];
	try {
		for (const [index, image] of images.entries()) {
			assertNotCancelled(signal);
			const name = `${manifest.task}_${String(index + 1).padStart(2, "0")}${EXTENSIONS[image.mime]}`;
			await writeFile(path.join(outputDir, name), image.bytes);
			assertNotCancelled(signal);
			written.push(name);

			try {
				const preview = await writePreview(path.join(outputDir, PREVIEW_DIRNAME), name, image);
				if (preview) previews.push(preview);
			} catch {
				// A preview is an optimisation; losing one must not discard a paid run.
			}
		}
		assertNotCancelled(signal);
		const manifestPath = path.join(outputDir, "manifest.json");
		await writeFile(
			manifestPath,
			`${JSON.stringify({ ...manifest, output_files: written, preview_files: previews }, null, 2)}\n`,
			"utf8",
		);
		assertNotCancelled(signal);
		return { files: written, previewFiles: previews, manifestPath };
	} catch (error) {
		await discardOutputDir(outputDir);
		if (error instanceof MingImageError && error.code === "cancelled") throw error;
		throw new MingImageError("write_failed", `Could not write artifacts to ${outputDir}`, { cause: error });
	}
}

export async function discardOutputDir(outputDir: string): Promise<void> {
	await rm(outputDir, { recursive: true, force: true });
}
