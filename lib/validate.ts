/**
 * Input validation: prompt text, local image selection, and format sniffing.
 *
 * Magic bytes identify the format; basic container checks reject truncated files.
 * This is not a full pixel decoder.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

import { MingImageError } from "./errors.ts";
import {
	INPUT_IMAGE_EXTENSIONS,
	MAX_INPUT_IMAGE_BYTES,
	MAX_OUTPUT_IMAGE_BYTES,
	MAX_PROMPT_CHARS,
	type DecodedImage,
	type ImageMime,
	type InputImage,
} from "./types.ts";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
	if (bytes.length < magic.length) return false;
	return magic.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1");
}

export function sniffImageMime(bytes: Uint8Array): ImageMime | undefined {
	if (startsWith(bytes, PNG_MAGIC)) return "image/png";
	if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
		return "image/webp";
	}
	return undefined;
}

// These checks reject truncated and malformed containers; they are not pixel decoders.
function validImageStructure(bytes: Uint8Array, mime: ImageMime): boolean {
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (mime === "image/png") {
		let offset = 8;
		let hasImageData = false;
		while (offset + 12 <= data.length) {
			const length = data.readUInt32BE(offset);
			if (length > data.length - offset - 12) return false;
			const type = data.toString("ascii", offset + 4, offset + 8);
			const end = offset + 12 + length;
			if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
			if (offset === 8) {
				if (type !== "IHDR" || length !== 13 || !data.readUInt32BE(offset + 8) || !data.readUInt32BE(offset + 12)) {
					return false;
				}
			} else if (type === "IHDR") {
				return false;
			}
			if (type === "IDAT" && length > 0) hasImageData = true;
			if (type === "IEND") return length === 0 && hasImageData && end === data.length;
			offset = end;
		}
		return false;
	}
	if (mime === "image/jpeg") {
		if (data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
			return false;
		}
		let offset = 2;
		let hasFrame = false;
		while (offset + 4 <= data.length - 2) {
			if (data[offset++] !== 0xff) return false;
			while (data[offset] === 0xff) offset++;
			const marker = data[offset++];
			if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || offset + 2 > data.length - 2) return false;
			const length = data.readUInt16BE(offset);
			if (length < 2 || offset + length > data.length - 2) return false;
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				if (length < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5)) return false;
				hasFrame = true;
			}
			if (marker === 0xda) return hasFrame && offset + length < data.length - 2;
			offset += length;
		}
		return false;
	}
	if (data.length < 20 || data.readUInt32LE(4) !== data.length - 8) return false;
	let offset = 12;
	let hasImageData = false;
	while (offset + 8 <= data.length) {
		const type = data.toString("ascii", offset, offset + 4);
		const length = data.readUInt32LE(offset + 4);
		const padded = length + (length % 2);
		if (padded > data.length - offset - 8) return false;
		if (offset === 12 && !["VP8 ", "VP8L", "VP8X"].includes(type)) return false;
		if (type === "VP8X" && length !== 10) return false;
		if (type === "VP8L" && (length < 5 || data[offset + 8] !== 0x2f)) return false;
		if (type === "VP8 " && (length < 10 || data[offset + 11] !== 0x9d || data[offset + 12] !== 0x01 || data[offset + 13] !== 0x2a)) {
			return false;
		}
		if (type === "ANMF" && length < 24) return false;
		if (["VP8 ", "VP8L", "ANMF"].includes(type)) hasImageData = true;
		offset += 8 + padded;
	}
	return hasImageData && offset === data.length;
}

async function readBoundedFile(resolved: string, limit: number, label: string): Promise<Buffer> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(resolved, "r");
		const info = await file.stat();
		if (!info.isFile()) throw new MingImageError("invalid_input", `Not a file: ${resolved}`);
		if (info.size === 0) throw new MingImageError("invalid_input", `${label} is empty: ${resolved}`);
		if (info.size > limit) {
			throw new MingImageError("invalid_input", `${label} is ${formatBytes(info.size)}; the limit is ${formatBytes(limit)}.`);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		// Read from the same open handle that was stat-ed; growth after stat is still capped.
		for await (const chunk of file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) {
			size += chunk.byteLength;
			if (size > limit) {
				throw new MingImageError("invalid_input", `${label} exceeded the ${formatBytes(limit)} limit.`);
			}
			chunks.push(chunk);
		}
		if (!size) throw new MingImageError("invalid_input", `${label} is empty: ${resolved}`);
		return Buffer.concat(chunks, size);
	} catch (error) {
		if (error instanceof MingImageError) throw error;
		throw new MingImageError("invalid_input", `Cannot read ${label.toLowerCase()}: ${resolved}`, { cause: error });
	} finally {
		await file?.close();
	}
}

export function assertPrompt(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) {
		throw new MingImageError("invalid_input", "Prompt is empty.");
	}
	if (trimmed.length > MAX_PROMPT_CHARS) {
		throw new MingImageError(
			"invalid_input",
			`Prompt is ${trimmed.length} characters; the limit is ${MAX_PROMPT_CHARS}.`,
		);
	}
	return trimmed;
}

/** Read a UTF-8 prompt file and return its trimmed contents. */
export async function readPromptFile(promptPath: string, cwd: string): Promise<{ prompt: string; file: string }> {
	const resolved = path.resolve(cwd, promptPath);
	// Four bytes per allowed character covers all valid UTF-8 without reading huge files.
	const bytes = await readBoundedFile(resolved, MAX_PROMPT_CHARS * 4, "Prompt file");
	return { prompt: assertPrompt(bytes.toString("utf8")), file: resolved };
}

export async function loadInputImage(imagePath: string, cwd: string): Promise<InputImage> {
	const resolved = path.resolve(cwd, imagePath);
	const extension = path.extname(resolved).toLowerCase();
	const declared = INPUT_IMAGE_EXTENSIONS[extension];
	if (!declared) {
		throw new MingImageError(
			"invalid_input",
			`Unsupported image format "${extension || "(none)"}". Use .png, .jpg, .jpeg, or .webp.`,
		);
	}

	const bytes = await readBoundedFile(resolved, MAX_INPUT_IMAGE_BYTES, "Image");
	const actual = sniffImageMime(bytes);
	if (!actual) {
		throw new MingImageError("invalid_input", `Unrecognized image format: ${resolved}`);
	}
	if (actual !== declared) {
		throw new MingImageError(
			"invalid_input",
			`Extension says ${declared} but the file content is ${actual}: ${resolved}`,
		);
	}
	if (!validImageStructure(bytes, actual)) {
		throw new MingImageError("invalid_input", `Image file is incomplete or malformed: ${resolved}`);
	}

	return {
		path: resolved,
		mime: actual,
		base64: bytes.toString("base64"),
		bytes: bytes.length,
	};
}

export function decodeBase64Image(value: string, index: number): DecodedImage {
	// Buffer.from silently ignores invalid characters and accepts non-canonical padding.
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new MingImageError("bad_response", `Image ${index} is not valid base64.`);
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(value, "base64");
	} catch (error) {
		throw new MingImageError("bad_response", `Image ${index} is not valid base64.`, { cause: error });
	}
	if (bytes.length === 0) {
		throw new MingImageError("bad_response", `Image ${index} decoded to zero bytes.`);
	}
	if (bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
		throw new MingImageError(
			"bad_response",
			`Image ${index} is ${formatBytes(bytes.length)}; the limit is ${formatBytes(MAX_OUTPUT_IMAGE_BYTES)}.`,
		);
	}
	const mime = sniffImageMime(bytes);
	if (!mime) {
		throw new MingImageError("bad_response", `Image ${index} is not a PNG, JPEG, or WebP file.`);
	}
	if (!validImageStructure(bytes, mime)) {
		throw new MingImageError("bad_response", `Image ${index} is incomplete or malformed.`);
	}
	return { bytes: new Uint8Array(bytes), mime };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
