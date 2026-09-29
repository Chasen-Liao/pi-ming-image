/**
 * Minimal PNG decode, resize, and encode built only on `node:zlib`.
 *
 * Why this exists: reading a full-resolution layer into the model context costs
 * megabytes of base64 per image, and that is what makes a design session feel
 * stuck. Previews must be small, and the package takes no runtime dependencies,
 * so a decoder cannot be pulled in.
 *
 * Scope is deliberately narrow: 8-bit output, non-interlaced input, the colour
 * types OpenRouter actually emits. Anything outside that returns `undefined` so
 * the caller can skip the preview instead of failing a paid run.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** Straight (non-premultiplied) 8-bit RGBA. */
export type RgbaImage = {
	width: number;
	height: number;
	data: Uint8Array;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = -1;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

function hasSignature(bytes: Uint8Array): boolean {
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** Channels per pixel for each PNG colour type. */
const COLOR_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Undo the per-scanline filters in place, returning one contiguous buffer of
 * `stride * height` bytes.
 */
function unfilter(raw: Uint8Array, width: number, height: number, bytesPerPixel: number, stride: number): Uint8Array {
	const out = new Uint8Array(stride * height);
	let input = 0;
	for (let y = 0; y < height; y++) {
		if (input >= raw.length) throw new Error("png: truncated scanline data");
		const filterType = raw[input++];
		const rowStart = y * stride;
		const priorStart = rowStart - stride;
		for (let i = 0; i < stride; i++) {
			if (input + i >= raw.length) throw new Error("png: truncated scanline data");
			const value = raw[input + i];
			const left = i >= bytesPerPixel ? out[rowStart + i - bytesPerPixel] : 0;
			const up = y > 0 ? out[priorStart + i] : 0;
			const upLeft = y > 0 && i >= bytesPerPixel ? out[priorStart + i - bytesPerPixel] : 0;
			let restored: number;
			switch (filterType) {
				case 0:
					restored = value;
					break;
				case 1:
					restored = value + left;
					break;
				case 2:
					restored = value + up;
					break;
				case 3:
					restored = value + ((left + up) >> 1);
					break;
				case 4:
					restored = value + paeth(left, up, upLeft);
					break;
				default:
					throw new Error(`png: unknown filter ${filterType}`);
			}
			out[rowStart + i] = restored & 0xff;
		}
		input += stride;
	}
	return out;
}

/**
 * Decode a non-interlaced PNG to RGBA8. Returns `undefined` for anything this
 * module does not handle — a preview is optional, so unsupported input is not
 * an error.
 */
export function decodePng(bytes: Uint8Array): RgbaImage | undefined {
	try {
		if (bytes.length < 8 || !hasSignature(bytes)) return undefined;

		let offset = 8;
		let width = 0;
		let height = 0;
		let bitDepth = 0;
		let colorType = 0;
		let interlace = 0;
		let palette: Uint8Array | undefined;
		let transparency: Uint8Array | undefined;
		const idat: Uint8Array[] = [];

		while (offset + 8 <= bytes.length) {
			const length = readUint32(bytes, offset);
			const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
			const dataStart = offset + 8;
			const dataEnd = dataStart + length;
			if (dataEnd + 4 > bytes.length) return undefined;
			const data = bytes.subarray(dataStart, dataEnd);

			if (type === "IHDR") {
				if (length !== 13) return undefined;
				width = readUint32(data, 0);
				height = readUint32(data, 4);
				bitDepth = data[8];
				colorType = data[9];
				if (data[10] !== 0 || data[11] !== 0) return undefined; // compression, filter method
				interlace = data[12];
			} else if (type === "PLTE") {
				palette = data.slice();
			} else if (type === "tRNS") {
				transparency = data.slice();
			} else if (type === "IDAT") {
				idat.push(data);
			} else if (type === "IEND") {
				break;
			}
			offset = dataEnd + 4;
		}

		if (interlace !== 0) return undefined; // Adam7 is not supported
		if (width <= 0 || height <= 0) return undefined;
		const channels = COLOR_CHANNELS[colorType];
		if (channels === undefined) return undefined;
		if (![1, 2, 4, 8, 16].includes(bitDepth)) return undefined;
		if (colorType === 3 && !palette) return undefined;
		if (colorType === 3 && ![1, 2, 4, 8].includes(bitDepth)) return undefined;
		if (colorType !== 3 && colorType !== 0 && bitDepth < 8) return undefined;
		// Guard against a header that would allocate an absurd buffer.
		if (width > 32768 || height > 32768) return undefined;

		const bitsPerPixel = channels * bitDepth;
		const stride = Math.ceil((width * bitsPerPixel) / 8);
		const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
		const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, bytesPerPixel, stride);

		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			const row = raw.subarray(y * stride, y * stride + stride);
			for (let x = 0; x < width; x++) {
				const target = (y * width + x) * 4;
				if (bitDepth === 8 || bitDepth === 16) {
					const step = bitDepth === 16 ? 2 : 1;
					const base = x * channels * step;
					if (colorType === 0) {
						const gray = row[base];
						data[target] = data[target + 1] = data[target + 2] = gray;
						data[target + 3] = 255;
					} else if (colorType === 2) {
						data[target] = row[base];
						data[target + 1] = row[base + step];
						data[target + 2] = row[base + step * 2];
						data[target + 3] = 255;
					} else if (colorType === 3) {
						const index = row[base];
						data[target] = palette?.[index * 3] ?? 0;
						data[target + 1] = palette?.[index * 3 + 1] ?? 0;
						data[target + 2] = palette?.[index * 3 + 2] ?? 0;
						data[target + 3] = transparency?.[index] ?? 255;
					} else if (colorType === 4) {
						const gray = row[base];
						data[target] = data[target + 1] = data[target + 2] = gray;
						data[target + 3] = row[base + step];
					} else {
						data[target] = row[base];
						data[target + 1] = row[base + step];
						data[target + 2] = row[base + step * 2];
						data[target + 3] = row[base + step * 3];
					}
				} else {
					const bitIndex = x * bitDepth;
					const byte = row[bitIndex >> 3];
					const shift = 8 - bitDepth - (bitIndex & 7);
					const value = (byte >> shift) & ((1 << bitDepth) - 1);
					if (colorType === 3) {
						data[target] = palette?.[value * 3] ?? 0;
						data[target + 1] = palette?.[value * 3 + 1] ?? 0;
						data[target + 2] = palette?.[value * 3 + 2] ?? 0;
						data[target + 3] = transparency?.[value] ?? 255;
					} else {
						// Sub-bit greyscale scales the sample across the full range.
						const gray = Math.round((value * 255) / ((1 << bitDepth) - 1));
						data[target] = data[target + 1] = data[target + 2] = gray;
						data[target + 3] = 255;
					}
				}
			}
		}
		return { width, height, data };
	} catch {
		return undefined;
	}
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
	);
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
	target[offset] = (value >>> 24) & 0xff;
	target[offset + 1] = (value >>> 16) & 0xff;
	target[offset + 2] = (value >>> 8) & 0xff;
	target[offset + 3] = value & 0xff;
}

/**
 * Area-average downscale.
 *
 * Alpha is premultiplied while averaging: mixing a transparent pixel's colour
 * into a layer edge is what produces the coloured halos that make a composited
 * layer look wrong.
 */
export function resizeRgba(source: RgbaImage, dstWidth: number, dstHeight: number): RgbaImage {
	if (dstWidth === source.width && dstHeight === source.height) {
		return { width: source.width, height: source.height, data: source.data.slice() };
	}
	const out = new Uint8Array(dstWidth * dstHeight * 4);
	const { width: srcWidth, height: srcHeight, data: src } = source;

	for (let dy = 0; dy < dstHeight; dy++) {
		const sy0 = (dy * srcHeight) / dstHeight;
		const sy1 = ((dy + 1) * srcHeight) / dstHeight;
		for (let dx = 0; dx < dstWidth; dx++) {
			const sx0 = (dx * srcWidth) / dstWidth;
			const sx1 = ((dx + 1) * srcWidth) / dstWidth;

			let sumAlpha = 0;
			let sumRed = 0;
			let sumGreen = 0;
			let sumBlue = 0;
			let sumWeight = 0;

			const firstRow = Math.floor(sy0);
			const lastRow = Math.min(srcHeight, Math.ceil(sy1));
			for (let sy = firstRow; sy < lastRow; sy++) {
				const weightY = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
				if (weightY <= 0) continue;
				const firstCol = Math.floor(sx0);
				const lastCol = Math.min(srcWidth, Math.ceil(sx1));
				for (let sx = firstCol; sx < lastCol; sx++) {
					const weightX = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
					if (weightX <= 0) continue;
					const weight = weightX * weightY;
					const index = (sy * srcWidth + sx) * 4;
					const alpha = src[index + 3] / 255;
					sumAlpha += alpha * weight;
					sumRed += src[index] * alpha * weight;
					sumGreen += src[index + 1] * alpha * weight;
					sumBlue += src[index + 2] * alpha * weight;
					sumWeight += weight;
				}
			}

			const target = (dy * dstWidth + dx) * 4;
			if (sumWeight <= 0 || sumAlpha <= 0) {
				out[target + 3] = 0;
				continue;
			}
			out[target] = clamp255(sumRed / sumAlpha);
			out[target + 1] = clamp255(sumGreen / sumAlpha);
			out[target + 2] = clamp255(sumBlue / sumAlpha);
			out[target + 3] = clamp255((sumAlpha / sumWeight) * 255);
		}
	}
	return { width: dstWidth, height: dstHeight, data: out };
}

function clamp255(value: number): number {
	const rounded = Math.round(value);
	return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/** Score a filtered row the way libpng does: cheaper filters compress better. */
function filterCost(row: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < row.length; i++) {
		const value = row[i];
		sum += value < 128 ? value : 256 - value;
	}
	return sum;
}

function writeChunk(parts: Uint8Array[], type: string, data: Uint8Array): void {
	const header = new Uint8Array(8);
	header[0] = (data.length >>> 24) & 0xff;
	header[1] = (data.length >>> 16) & 0xff;
	header[2] = (data.length >>> 8) & 0xff;
	header[3] = data.length & 0xff;
	for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);

	const crc = new Uint8Array(4);
	writeUint32(crc, 0, crc32(Buffer.concat([header.subarray(4, 8), data])));

	parts.push(header, data, crc);
}

/** Encode RGBA8 as PNG, dropping the alpha channel when every pixel is opaque. */
export function encodePng(image: RgbaImage): Uint8Array {
	const { width, height, data } = image;
	if (width <= 0 || height <= 0) throw new Error("png: refusing to encode an empty image");

	let opaque = true;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] !== 255) {
			opaque = false;
			break;
		}
	}
	const channels = opaque ? 3 : 4;
	const stride = width * channels;

	const raw = new Uint8Array((stride + 1) * height);
	const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
	const best = new Uint8Array(stride);
	// The source is always RGBA, but the encoded row may be RGB. Packing each row
	// first is what drops the alpha channel; indexing the RGBA buffer directly
	// would read R,G,B,R,G,B... as if it were one row.
	const packed = new Uint8Array(stride);
	let priorPacked = new Uint8Array(stride);

	for (let y = 0; y < height; y++) {
		const rowStart = y * width * 4;
		for (let x = 0; x < width; x++) {
			const source = rowStart + x * 4;
			const target = x * channels;
			packed[target] = data[source];
			packed[target + 1] = data[source + 1];
			packed[target + 2] = data[source + 2];
			if (channels === 4) packed[target + 3] = data[source + 3];
		}
		for (let i = 0; i < stride; i++) {
			const rawByte = packed[i];
			const left = i >= channels ? packed[i - channels] : 0;
			const up = y > 0 ? priorPacked[i] : 0;
			const upLeft = y > 0 && i >= channels ? priorPacked[i - channels] : 0;
			candidates[0][i] = rawByte;
			candidates[1][i] = (rawByte - left) & 0xff;
			candidates[2][i] = (rawByte - up) & 0xff;
			candidates[3][i] = (rawByte - ((left + up) >> 1)) & 0xff;
			candidates[4][i] = (rawByte - paeth(left, up, upLeft)) & 0xff;
		}

		let bestIndex = 0;
		let bestCost = Number.POSITIVE_INFINITY;
		for (let filterType = 0; filterType < 5; filterType++) {
			const cost = filterCost(candidates[filterType]);
			if (cost < bestCost) {
				bestCost = cost;
				bestIndex = filterType;
			}
		}
		best.set(candidates[bestIndex]);
		raw[y * (stride + 1)] = bestIndex;
		raw.set(best, y * (stride + 1) + 1);

		priorPacked = packed.slice();
	}

	const ihdr = new Uint8Array(13);
	writeUint32(ihdr, 0, width);
	writeUint32(ihdr, 4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = opaque ? 2 : 6; // colour type
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
	writeChunk(parts, "IHDR", ihdr);
	writeChunk(parts, "IDAT", new Uint8Array(deflateSync(raw, { level: 9 })));
	writeChunk(parts, "IEND", new Uint8Array(0));

	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const png = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}

export type PreviewOptions = {
	/** Longest edge of the first attempt. */
	maxDimension: number;
	/** Shrink further when the encoded preview is still too large to read cheaply. */
	maxBytes: number;
	/** Never shrink past this; a thumbnail this small stops being useful. */
	minDimension: number;
};

export type PngPreview = {
	bytes: Uint8Array;
	width: number;
	height: number;
};

/**
 * Build a preview bounded on both axes: longest edge first, then encoded size.
 *
 * Returns `undefined` only when the input is not a PNG this module can decode.
 * A byte cap that no attempt can meet degrades to the smallest attempt rather
 * than to no preview: a large preview is still worth far more than none.
 */
export function makePngPreview(bytes: Uint8Array, options: PreviewOptions): PngPreview | undefined {
	const decoded = decodePng(bytes);
	if (!decoded) return undefined;
	if (decoded.width <= 1 || decoded.height <= 1) return undefined;

	const longest = Math.max(decoded.width, decoded.height);
	let scale = Math.min(1, options.maxDimension / longest);
	// The most recent attempt. Returned as-is when no attempt met the byte cap.
	let lastAttempt: PngPreview | undefined;

	for (let attempt = 0; attempt < 4; attempt++) {
		const width = Math.max(1, Math.round(decoded.width * scale));
		const height = Math.max(1, Math.round(decoded.height * scale));
		const encoded = encodePng(resizeRgba(decoded, width, height));
		lastAttempt = { bytes: encoded, width, height };
		if (encoded.length <= options.maxBytes) return lastAttempt;
		if (Math.max(width, height) <= options.minDimension) break;
		scale *= 0.75;
	}
	return lastAttempt;
}
