/**
 * Shared image fixtures for the test suite.
 *
 * These must look like real photographic output. Flat or blocky synthetic
 * patterns are the wrong shape for a preview test: a preview of such an image
 * can be *larger* than the source, because downscaling destroys the
 * regularities that made the source compress well. A gradient plus fine noise
 * behaves the way real generated art does — downscaling averages the noise away.
 */

import { encodePng } from "../lib/png.ts";

/** Photographic content whose preview is genuinely worth writing. */
export function photoPng(width = 900, height = 600, seed = 12345): Buffer {
	const data = new Uint8Array(width * height * 4);
	let state = seed;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			state = (1103515245 * state + 12345) % 2147483648;
			const noise = (state >> 16) % 24;
			data[i] = Math.min(255, Math.floor((x * 200) / width) + noise);
			data[i + 1] = Math.min(255, Math.floor((y * 180) / height) + noise);
			data[i + 2] = Math.min(255, Math.floor(((x + y) * 90) / (width + height)) + noise);
			data[i + 3] = 255;
		}
	}
	return Buffer.from(encodePng({ width, height, data }));
}
