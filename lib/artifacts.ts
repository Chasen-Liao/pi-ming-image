/**
 * Artifact directory allocation, image writing, and manifest emission.
 *
 * The manifest records caller metadata and allowlisted numeric usage statistics;
 * raw upstream payloads, token echoes, and image base64 are not persisted.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertNotCancelled, MingImageError } from "./errors.ts";
import type { DecodedImage, MingTask, RunManifest } from "./types.ts";

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

/** Write every image plus the manifest. Removes the directory if any write fails. */
export async function writeRun(
	outputDir: string,
	images: DecodedImage[],
	manifest: RunManifest,
	signal?: AbortSignal,
): Promise<{ files: string[]; manifestPath: string }> {
	const written: string[] = [];
	try {
		for (const [index, image] of images.entries()) {
			assertNotCancelled(signal);
			const name = `${manifest.task}_${String(index + 1).padStart(2, "0")}${EXTENSIONS[image.mime]}`;
			await writeFile(path.join(outputDir, name), image.bytes);
			assertNotCancelled(signal);
			written.push(name);
		}
		assertNotCancelled(signal);
		const manifestPath = path.join(outputDir, "manifest.json");
		await writeFile(manifestPath, `${JSON.stringify({ ...manifest, output_files: written }, null, 2)}\n`, "utf8");
		assertNotCancelled(signal);
		return { files: written, manifestPath };
	} catch (error) {
		await discardOutputDir(outputDir);
		if (error instanceof MingImageError && error.code === "cancelled") throw error;
		throw new MingImageError("write_failed", `Could not write artifacts to ${outputDir}`, { cause: error });
	}
}

export async function discardOutputDir(outputDir: string): Promise<void> {
	await rm(outputDir, { recursive: true, force: true });
}
