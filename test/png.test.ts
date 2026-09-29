import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePng, encodePng, makePngPreview, resizeRgba, type RgbaImage } from "../lib/png.ts";

/**
 * These fixtures were produced by an independent encoder (PIL), not by the
 * encoder under test. That matters: a round trip through our own `encodePng`
 * would pass even if both halves shared the same wrong assumption.
 */
const PNG_RGB =
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAeElEQVR4nO2VgQkAQQjD8sTbf+UfQ4RAF7Bt6gcMXtYTDms6wBKwCrHPIkHsupc0o17U9MgsAasQ+ywSxK57STPqRU2PzBKwCrHPIkHsupc0o17U9MgsAasQ+ywSxK57STPqRU2PzBKwCrHPIkHsupc0o17UXH9kP2VjJqIkYqAxAAAAAElFTkSuQmCC";
const PNG_LA =
	"iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAQAAAAngNWGAAAAJ0lEQVR4nGNkYOBBhf/R+AwQyMRAJGAaVYgPMOGVRQKjCvGCAQweACoYAgszKue4AAAAAElFTkSuQmCC";
const PNG_RGBA =
	"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";
const PNG_PALETTE =
	"iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAMAAABpA6zvAAADAFBMVEUAAAABBQkCChIDDxsEFCQFGS0GHjYHIz8IKEgJLVEKMloLN2MMPGwNQXUORn4PS4cQUJARVZkSWqITX6sUZLQVab0WbsYXc88YeNgZfeEaguobh/McjPwdkQUelg4fmxcgoCAhpSkiqjIjrzsktEQluU0mvlYnw18oyGgpzXEq0nor14Ms3Iwt4ZUu5p4v66cw8LAx9bky+sIz/8s0BNQ1Cd02DuY3E+84GPg5HQE6Igo7JxM8LBw9MSU+Ni4/OzdAQEBBRUlCSlJDT1tEVGRFWW1GXnZHY39IaIhJbZFKcppLd6NMfKxNgbVOhr5Pi8dQkNBRldlSmuJTn+tUpPRVqf1WrgZXsw9YuBhZvSFawipbxzNczDxd0UVe1k5f21dg4GBh5Wli6nJj73tk9IRl+Y1m/pZnA59oCKhpDbFqErprF8NsHMxtIdVuJt5vK+dwMPBxNflyOgJzPwt0RBR1SR12TiZ3Uy94WDh5XUF6Ykp7Z1N8bFx9cWV+dm5/e3eAgICBhYmCipKDj5uElKSFma2GnraHo7+IqMiJrdGKstqLt+OMvOyNwfWOxv6PyweQ0BCR1RmS2iKT3yuU5DSV6T2W7kaX80+Y+FiZ/WGaAmqbB3OcDHydEYWeFo6fG5egIKChJamiKrKjL7ukNMSlOc2mPtanQ9+oSOipTfGqUvqrVwOsXAytYRWuZh6vayewcDCxdTmyekKzf0u0hFS1iV22jma3k2+4mHi5nYG6ooq7p5O8rJy9saW+tq6/u7fAwMDBxcnCytLDz9vE1OTF2e3G3vbH4//I6AjJ7RHK8hrL9yPM/CzNATXOBj7PC0fQEFDRFVnSGmLTH2vUJHTVKX3WLobXM4/YOJjZPaHaQqrbR7PcTLzdUcXeVs7fW9fgYODhZeniavLjb/vkdATleQ3mfhbngx/oiCjpjTHqkjrrl0PsnEztoVXupl7vq2fwsHDxtXnyuoLzv4v0xJT1yZ32zqb306/42Lj53cH64sr759P87Nz98eX+9u7/+/etZba9AAABAHRSTlMAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/qVjM+gAAAXlJREFUeJxjYGDjEZKQU9EyMLNx8vALiUpIyymqqGvpmjBtzqIV67bsOnDszKUb9568YmBk5xWWlFfVNjS3dfb0D41OTM8trqxv7Z44fe7ileu37j54/Ozlm/efvmZg4uATkVJQ0zGysHPxCgiLScrIK6lqaOuZNGPeklUbtu05dOLclVsPnr1hYObkF5VWVNc1trR39Q4Mj03OzC+tbmzvnTxz/tLVG7fvPXzy/NXbD5+/ZWDhEhCTUdLQM7FycPMJiohLySooq2nq6Jsya8GyNZt27Dty6sK1O49evGNg5RYUl1XW1De1dnT3DY6MT80uLK9t7uyfOnvh8rWbd+4/evri9buPX74n1tMfGIj09EcGIj39iYFIT39mINLTXxiI9PRXBiI9/Y2BSE9/ZyDS0z8YiPT0TwYiPf2LgUhP/2Yg0tN/GIj09F8GIj39j4FIT/9nINbTDER6mpGBSE8zMRDpaWYGIj3NwkCkp1kZiPQ0GwORnmYHAJZFXofwdsVKAAAAAElFTkSuQmCC";

const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const pixel = (image: RgbaImage, x: number, y: number) => {
	const i = (y * image.width + x) * 4;
	return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
};

describe("png decoding", () => {
	it("reads an externally encoded RGB image", () => {
		const image = decodePng(fromBase64(PNG_RGB));
		assert.ok(image);
		assert.equal(image.width, 64);
		assert.equal(image.height, 48);
		assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 255]);
		// The fixture is (x*4 % 256, y*5 % 256, (x+y)*3 % 256).
		assert.deepEqual(pixel(image, 4, 3), [16, 15, 21, 255]);
	});

	it("reads gray+alpha and keeps the alpha channel", () => {
		const image = decodePng(fromBase64(PNG_LA));
		assert.ok(image);
		assert.equal(image.width, 20);
		assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 0]);
		assert.deepEqual(pixel(image, 9, 0), [108, 108, 108, 255]);
	});

	it("reads RGBA and preserves hard transparency edges", () => {
		const image = decodePng(fromBase64(PNG_RGBA));
		assert.ok(image);
		assert.equal(image.width, 97);
		assert.equal(image.height, 61);
		// The fixture is transparent for x < 97/3 and opaque after.
		assert.equal(pixel(image, 0, 0)[3], 0);
		assert.equal(pixel(image, 40, 0)[3], 255);
	});

	it("reads a palette image and honours tRNS", () => {
		const image = decodePng(fromBase64(PNG_PALETTE));
		assert.ok(image);
		assert.equal(image.width, 40);
		assert.equal(image.height, 30);
		// tRNS is a ramp, so a pixel's alpha is its palette index: (x*6 + y) % 256.
		assert.equal(pixel(image, 0, 0)[3], 0);
		assert.equal(pixel(image, 5, 0)[3], 30);
		assert.equal(pixel(image, 0, 1)[3], 1);
	});

	it("declines input it cannot decode instead of throwing", () => {
		assert.equal(decodePng(new Uint8Array(0)), undefined);
		assert.equal(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
		assert.equal(decodePng(fromBase64("RIFF____WEBPmore")), undefined);
		assert.equal(decodePng(fromBase64(PNG_RGBA).slice(0, 400)), undefined, "truncated");
	});

	it("declines an interlaced image rather than mis-decoding it", () => {
		// Interlace lives in IHDR byte 12, which is offset 28 in the file.
		const bytes = fromBase64(PNG_RGB);
		assert.equal(bytes[28], 0);
		bytes[28] = 1;
		assert.equal(decodePng(bytes), undefined);
	});
});

describe("png encoding", () => {
	const solid = (width: number, height: number, rgba: [number, number, number, number]): RgbaImage => ({
		width,
		height,
		data: new Uint8Array(width * height * 4).fill(0).map((_, i) => rgba[i % 4]),
	});

	it("round-trips pixels exactly", () => {
		const source = solid(37, 23, [12, 200, 88, 255]);
		const decoded = decodePng(encodePng(source));
		assert.ok(decoded);
		assert.equal(decoded.width, 37);
		assert.deepEqual([...decoded.data], [...source.data]);
	});

	it("drops the alpha channel only when every pixel is opaque", () => {
		const opaque = encodePng(solid(8, 8, [1, 2, 3, 255]));
		assert.equal(opaque[25], 2, "colour type 2 (RGB) for opaque images");

		const translucent = solid(8, 8, [1, 2, 3, 128]);
		translucent.data[0] = 4; // one non-opaque pixel
		assert.equal(encodePng(translucent)[25], 6, "colour type 6 (RGBA) when alpha varies");
	});
});

describe("resizing", () => {
	it("averages premultiplied so a transparent colour cannot tint an edge", () => {
		// One opaque red pixel against three fully transparent blue ones. Naive
		// averaging would yield a blue-purple pixel; premultiplied must stay red.
		const source: RgbaImage = {
			width: 2,
			height: 2,
			data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0]),
		};
		const out = resizeRgba(source, 1, 1);
		assert.deepEqual([...out.data], [255, 0, 0, 64]);
	});

	it("keeps a fully transparent region fully transparent", () => {
		const source: RgbaImage = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };
		const out = resizeRgba(source, 2, 2);
		for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 0);
	});

	it("preserves aspect-correct averaging of a solid block", () => {
		const source: RgbaImage = {
			width: 2,
			height: 2,
			data: new Uint8Array([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]),
		};
		const out = resizeRgba(source, 1, 1);
		assert.deepEqual([...out.data], [10, 20, 30, 255]);
	});
});

describe("previews", () => {
	/** Smooth gradient: compresses the way a real illustration does. */
	const gradient = (width: number, height: number): RgbaImage => {
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				data[i] = Math.floor((x / width) * 255);
				data[i + 1] = Math.floor((y / height) * 255);
				data[i + 2] = Math.floor(((x + y) / (width + height)) * 255);
				data[i + 3] = 255;
			}
		}
		return { width, height, data };
	};

	/** Noisy: a worst case for a PNG preview. */
	const noisy = (width: number, height: number, seed: number): RgbaImage => {
		const data = new Uint8Array(width * height * 4);
		let state = seed;
		for (let i = 0; i < width * height; i++) {
			state = (1103515245 * state + 12345) % 2147483648;
			data[i * 4] = (state >> 16) % 256;
			data[i * 4 + 1] = (state >> 16) % 256;
			data[i * 4 + 2] = (state >> 16) % 256;
			data[i * 4 + 3] = 255;
		}
		return { width, height, data };
	};

	/**
	 * Mid-frequency structure. A plain gradient compresses so well that any
	 * preview already fits, and pure noise fits at no size; this sits between so
	 * the size-cap branch is actually reachable.
	 */
	const structured = (width: number, height: number): RgbaImage => {
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				const block = ((x >> 5) + (y >> 5)) % 2 ? 180 : 60;
				data[i] = Math.min(255, block + Math.floor((x / width) * 60));
				data[i + 1] = Math.min(255, block + Math.floor((y / height) * 60));
				data[i + 2] = Math.min(255, block + ((x + y) % 64));
				data[i + 3] = 255;
			}
		}
		return { width, height, data };
	};

	const generous = { maxDimension: 512, maxBytes: 8 * 1024 * 1024, minDimension: 64 };

	it("bounds the longest edge and keeps the aspect ratio", () => {
		const full = encodePng(gradient(1400, 900));
		const preview = makePngPreview(full, generous);
		assert.ok(preview);
		assert.equal(preview.width, 512);
		assert.equal(preview.height, 329);
		assert.ok(preview.bytes.length < full.length, `preview ${preview.bytes.length}B vs full ${full.length}B`);
	});

	it("keeps a small image instead of upscaling it", () => {
		const preview = makePngPreview(encodePng(gradient(64, 48)), generous);
		assert.ok(preview);
		assert.equal(preview.width, 64);
		assert.equal(preview.height, 48);
	});

	it("still returns a preview when the image resists compression", () => {
		// A byte cap no attempt can meet must degrade to the smallest attempt, not
		// to nothing: losing the preview entirely is worse than a large one.
		const preview = makePngPreview(encodePng(noisy(900, 900, 11)), {
			maxDimension: 512,
			maxBytes: 64,
			minDimension: 64,
		});
		assert.ok(preview, "must always return something decodable");
		assert.ok(Math.max(preview.width, preview.height) <= 512);
		const decoded = decodePng(preview.bytes);
		assert.ok(decoded, "and it must still be a valid PNG");
	});

	it("shrinks further when the encoded preview is still too large", () => {
		const full = encodePng(structured(1400, 900));
		const unconstrained = makePngPreview(full, generous);
		const tight = makePngPreview(full, { maxDimension: 512, maxBytes: 40_000, minDimension: 64 });
		assert.ok(unconstrained);
		assert.ok(tight);
		assert.ok(unconstrained.bytes.length > 40_000, "the fixture must exceed the cap when unscaled");
		assert.ok(tight.bytes.length <= 40_000, `preview was ${tight.bytes.length}B`);
		assert.ok(
			Math.max(tight.width, tight.height) < Math.max(unconstrained.width, unconstrained.height),
			"a tighter budget must produce a smaller image",
		);
	});
});
