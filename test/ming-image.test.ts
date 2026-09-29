import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { allocateOutputDir, discardOutputDir, writeRun } from "../lib/artifacts.ts";
import { parseMingCommand, tokenize, USAGE } from "../lib/command-args.ts";
import { generateMingImage, resolveToken } from "../lib/generate.ts";
import { buildRequestBody, requestImages } from "../lib/openrouter.ts";
import { MingImageError } from "../lib/errors.ts";
import { readPromptFile, sniffImageMime } from "../lib/validate.ts";
import { MAX_OUTPUT_IMAGES, MAX_PROMPT_CHARS } from "../lib/types.ts";

/** Minimal valid PNG (1x1, transparent) reused across tests. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const JPEG_1X1 = Buffer.from(
	"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
	"base64",
);

// 1x1 WebP fixtures: lossless VP8L, lossy VP8, and extended VP8X with alpha.
const WEBP_1X1 = [
	"UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA",
	"UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
	"UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAUFZQOCAwAAAA0AEAnQEqAQABAAIANCWgAnS6AfgAA7AA/vDEC/8guWF1yNf/ID/kB/yA//jyAAAA",
].map((value) => Buffer.from(value, "base64"));

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "ming-image-test-"));
	scratchDirs.push(dir);
	return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fetch double that records the request and replays a scripted response. */
function stubFetch(responses: Response[] | ((url: string, init: RequestInit) => Response)) {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		const requestInit = init ?? {};
		calls.push({ url: String(url), init: requestInit });
		return typeof responses === "function"
			? responses(String(url), requestInit)
			: (responses.shift() as Response);
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function okImageResponse(count = 1, mime = "image/png") {
	const bytes = mime === "image/jpeg" ? JPEG_1X1 : PNG_1X1;
	return jsonResponse({
		data: Array.from({ length: count }, () => ({ b64_json: bytes.toString("base64") })),
		usage: { total_tokens: 42, cost: 0 },
	});
}

after(async () => {
	await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("format sniffing", () => {
	it("detects png, jpeg, and webp from magic bytes", () => {
		assert.equal(sniffImageMime(new Uint8Array(PNG_1X1)), "image/png");
		assert.equal(sniffImageMime(new Uint8Array(JPEG_1X1)), "image/jpeg");
		assert.equal(sniffImageMime(Buffer.from("RIFF____WEBPmore", "latin1")), "image/webp");
	});

	it("rejects non-image bytes", () => {
		assert.equal(sniffImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
		assert.equal(sniffImageMime(new Uint8Array(0)), undefined);
	});
});

describe("local file limits", () => {
	it("rejects an oversized prompt file even when most bytes are trimmed away", async () => {
		const cwd = await scratch();
		await writeFile(path.join(cwd, "large.txt"), `${" ".repeat(MAX_PROMPT_CHARS * 4 + 1)}ok`);
		await assert.rejects(
			() => readPromptFile("large.txt", cwd),
			(error: MingImageError) => error.code === "invalid_input" && /limit/.test(error.message),
		);
	});
});

describe("request body", () => {
	it("design sends text only", () => {
		const body = buildRequestBody("design", "a calm hero");
		assert.deepEqual(body, {
			model: "inclusionai/ming-image-0.1-design",
			prompt: "a calm hero",
			output_format: "png",
		});
		assert.equal("input_references" in body, false);
	});

	it("never sends size or aspect_ratio", () => {
		for (const task of ["design", "layer"] as const) {
			const body = buildRequestBody(task, "p", task === "layer" ? { path: "x", mime: "image/png", base64: "AAA", bytes: 3 } : undefined);
			assert.equal("size" in body, false);
			assert.equal("aspect_ratio" in body, false);
		}
	});

	it("layer attaches exactly one image reference", () => {
		const body = buildRequestBody("layer", "split this", {
			path: "C:/a.png",
			mime: "image/png",
			base64: "AAAA",
			bytes: 3,
		});
		assert.equal(body.model, "inclusionai/ming-image-0.1-design-layer");
		const refs = body.input_references as { type: string; image_url: { url: string } }[];
		assert.equal(refs.length, 1);
		assert.equal(refs[0].type, "image_url");
		assert.equal(refs[0].image_url.url, "data:image/png;base64,AAAA");
	});

	it("rejects mismatched task and image", () => {
		const image = { path: "x", mime: "image/png" as const, base64: "AA", bytes: 1 };
		assert.throws(() => buildRequestBody("layer", "p"), MingImageError);
		assert.throws(() => buildRequestBody("design", "p", image), MingImageError);
	});
});

describe("requestImages", () => {
	const base = { prompt: "hello", token: "sk-test-not-a-real-token" };

	it("posts to the images endpoint with a bearer token", async () => {
		const { impl, calls } = stubFetch([okImageResponse(2)]);
		const result = await requestImages({ ...base, task: "design", fetchImpl: impl });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
		const headers = calls[0].init.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer sk-test-not-a-real-token");
		assert.equal(headers["Content-Type"], "application/json");
		assert.equal(result.images.length, 2);
		assert.deepEqual(result.usage, { total_tokens: 42, cost: 0 });
	});

	it("does not echo even a numeric credential through a usage statistic", async () => {
		const { impl } = stubFetch([jsonResponse({
			data: [{ b64_json: PNG_1X1.toString("base64") }], usage: { total_tokens: 42, cost: 0 },
		})]);
		const result = await requestImages({ task: "design", prompt: "p", token: "42", fetchImpl: impl });
		assert.deepEqual(result.usage, { cost: 0 });
	});

	it("maps 402, 429, and auth failures to distinct codes", async () => {
		for (const [status, code] of [
			[402, "insufficient_credit"],
			[429, "rate_limited"],
			[401, "missing_credential"],
			[500, "upstream_error"],
		] as const) {
			const { impl } = stubFetch([jsonResponse({ error: { message: "boom" } }, status)]);
			await assert.rejects(
				() => requestImages({ ...base, task: "design", fetchImpl: impl }),
				(error: MingImageError) => {
					assert.equal(error.code, code);
					return true;
				},
			);
		}
	});

	it("rejects an empty image list", async () => {
		const { impl } = stubFetch([jsonResponse({ data: [] })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "empty_result",
		);
	});

	it("rejects invalid base64 characters even when decoded magic bytes look valid", async () => {
		const corrupt = `${PNG_1X1.toString("base64").slice(0, 16)}!${PNG_1X1.toString("base64").slice(16)}`;
		const { impl } = stubFetch([jsonResponse({ data: [{ b64_json: corrupt }] })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response" && /base64/.test(error.message),
		);
	});

	it("rejects images that only have a magic header or have truncated trailers", async () => {
		for (const broken of [PNG_1X1.subarray(0, 8), PNG_1X1.subarray(0, -12), JPEG_1X1.subarray(0, -2)]) {
			const { impl } = stubFetch([jsonResponse({ data: [{ b64_json: broken.toString("base64") }] })]);
			await assert.rejects(
				() => requestImages({ ...base, task: "design", fetchImpl: impl }),
				(error: MingImageError) => error.code === "bad_response",
			);
		}
	});

	it("accepts complete JPEG and WebP outputs", async () => {
		for (const [bytes, mime] of [[JPEG_1X1, "image/jpeg"], ...WEBP_1X1.map((bytes) => [bytes, "image/webp"] as const)] as const) {
			const { impl } = stubFetch([jsonResponse({ data: [{ b64_json: bytes.toString("base64") }] })]);
			const result = await requestImages({ ...base, task: "design", fetchImpl: impl });
			assert.equal(result.images[0].mime, mime);
		}
	});

	it("rejects a WebP container with no valid image payload", async () => {
		const invalid = Buffer.from("RIFF\x0e\0\0\0WEBPVP8L\x01\0\0\0\x2f\0", "latin1");
		const { impl } = stubFetch([jsonResponse({ data: [{ b64_json: invalid.toString("base64") }] })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response",
		);
	});

	it("rejects a non-image payload", async () => {
		const { impl } = stubFetch([jsonResponse({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response",
		);
	});

	it("rejects an oversized image list", async () => {
		const { impl } = stubFetch([okImageResponse(MAX_OUTPUT_IMAGES + 1)]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response",
		);
	});

	it("rejects a body that is not JSON", async () => {
		const { impl } = stubFetch([new Response("<html>gateway</html>", { status: 200 })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response",
		);
	});

	it("reports cancellation and leaves no retry", async () => {
		const controller = new AbortController();
		const { impl, calls } = stubFetch(() => {
			controller.abort();
			return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) as never;
		});
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl, signal: controller.signal }),
			(error: MingImageError) => error.code === "cancelled",
		);
		assert.equal(calls.length, 1, "must not retry a request that may have been billed");
	});

	it("keeps the timeout armed while the body is being read", async () => {
		// fetch resolves on response headers; a stalled body must still time out.
		// The fake mirrors undici by rejecting the body read once the signal aborts.
		let captured: AbortSignal | undefined;
		const { impl } = stubFetch((url, init) => {
			captured = (init as RequestInit).signal as AbortSignal;
			return new Response(new ReadableStream({
				start(controller) {
					captured?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
				},
			}));
		});
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl, timeoutMs: 120 }),
			(error: MingImageError) => error.code === "timeout",
		);
	});

	it("keeps cancellation armed while the body is being read", async () => {
		const controller = new AbortController();
		const { impl } = stubFetch((url, init) => {
			const upstream = (init as RequestInit).signal as AbortSignal;
			return new Response(new ReadableStream({
				start(controller) {
					upstream.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
				},
			}));
		});
		const pending = requestImages({
			...base,
			task: "design",
			fetchImpl: impl,
			signal: controller.signal,
			timeoutMs: 5000,
		});
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(
			() => pending,
			(error: MingImageError) => error.code === "cancelled",
		);
	});

	it("rejects a valid response when cancellation occurs after headers arrive", async () => {
		const controller = new AbortController();
		const { impl } = stubFetch(() => {
			controller.abort();
			return okImageResponse();
		});
		await assert.rejects(
			() => requestImages({ ...base, task: "design", signal: controller.signal, fetchImpl: impl }),
			(error: MingImageError) => error.code === "cancelled",
		);
	});

	it("refuses to start when the signal is already aborted", async () => {
		// An abort event that already fired never fires again, so the listener alone is not enough.
		const controller = new AbortController();
		controller.abort();
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl, signal: controller.signal }),
			(error: MingImageError) => error.code === "cancelled",
		);
		assert.equal(calls.length, 0, "an already-cancelled request must not be billed");
	});

	it("refuses to start when the signal is already aborted at the generate level", async () => {
		const cwd = await scratch();
		const controller = new AbortController();
		controller.abort();
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() =>
				generateMingImage({
					task: "design",
					prompt: "p",
					cwd,
					fetchImpl: impl,
					signal: controller.signal,
					token: "sk-test-not-a-real-token",
				}),
			(error: MingImageError) => error.code === "cancelled",
		);
		assert.equal(calls.length, 0);
		const { readdir } = await import("node:fs/promises");
		await assert.rejects(() => readdir(path.join(cwd, "artifacts")), /ENOENT/);
	});

	it("redacts a reflected credential in JSON and plain-text upstream errors", async () => {
		for (const response of [
			jsonResponse({ error: { message: `credential ${base.token} rejected` } }, 500),
			new Response(`credential ${base.token} rejected`, { status: 500 }),
		]) {
			const { impl } = stubFetch([response]);
			await assert.rejects(
				() => requestImages({ ...base, task: "design", fetchImpl: impl }),
				(error: MingImageError) => {
					assert.equal(error.code, "upstream_error");
					assert.equal(error.message.includes(base.token), false);
					assert.match(error.message, /\[REDACTED\]/);
					return true;
				},
			);
		}
	});

	it("does not expose credentials reflected in transport errors", async () => {
		const { impl } = stubFetch(() => {
			throw new Error(`request Authorization: Bearer ${base.token} failed`);
		});
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "upstream_error" && !error.message.includes(base.token),
		);
	});

	it("caps an error body with no declared length while streaming", async () => {
		let chunksRead = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunksRead++;
				if (chunksRead <= 18) controller.enqueue(new Uint8Array(4096).fill(65));
				else controller.close();
			},
		});
		const { impl } = stubFetch([new Response(stream, { status: 500 })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "upstream_error" && /exceeded/.test(error.message),
		);
		assert.ok(chunksRead < 30, `read ${chunksRead} chunks despite the 64 KB cap`);
	});

	it("caps the error body it will read", async () => {
		const { impl } = stubFetch([
			{
				ok: false,
				status: 500,
				headers: new Headers({ "content-length": String(512 * 1024 * 1024) }),
				text: () => {
					throw new Error("body must not be read");
				},
			} as unknown as Response,
		]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "upstream_error" && /exceeded/.test(error.message),
		);
	});

	it("caps a successful response with no declared length while streaming", async () => {
		let chunksRead = 0;
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunksRead++;
				if (chunksRead <= 129) controller.enqueue(chunk);
				else controller.close();
			}
		});
		const { impl } = stubFetch([new Response(stream)]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response" && /limit/.test(error.message),
		);
		assert.ok(chunksRead < 140, `read ${chunksRead} MB despite the 128 MB cap`);
	});

	it("rejects an oversized declared body before reading it", async () => {
		const { impl } = stubFetch((_url, init) => {
			void init;
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-length": String(512 * 1024 * 1024) }),
				json: () => {
					throw new Error("body must not be read");
				},
			} as unknown as Response;
		});
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "bad_response",
		);
	});

	it("still reports upstream errors, not timeouts, on a fast failure", async () => {
		const { impl } = stubFetch([new Response("nope", { status: 503 })]);
		await assert.rejects(
			() => requestImages({ ...base, task: "design", fetchImpl: impl }),
			(error: MingImageError) => error.code === "upstream_error",
		);
	});
});

describe("token resolution", () => {
	it("prefers the registry over the environment", async () => {
		const token = await resolveToken({ getApiKeyForProvider: async () => "from-registry" }, {
			OPENROUTER_API_KEY: "from-env",
		});
		assert.equal(token, "from-registry");
	});

	it("falls back to the environment variable", async () => {
		const token = await resolveToken({ getApiKeyForProvider: async () => undefined }, {
			OPENROUTER_API_KEY: "from-env",
		});
		assert.equal(token, "from-env");
	});

	it("fails clearly when no credential exists", async () => {
		await assert.rejects(
			() => resolveToken({ getApiKeyForProvider: async () => undefined }, {}),
			(error: MingImageError) => error.code === "missing_credential",
		);
	});
});

describe("command parsing", () => {
	it("tokenizes quoted paths with spaces", () => {
		assert.deepEqual(tokenize('design "C:\\my art\\hero.txt"'), ["design", "C:\\my art\\hero.txt"]);
		assert.deepEqual(tokenize("layer 'a b.png' 'c d.txt'"), ["layer", "a b.png", "c d.txt"]);
		assert.deepEqual(tokenize("  design   hero.txt  "), ["design", "hero.txt"]);
		assert.deepEqual(tokenize("design \"\""), ["design", ""]);
	});

	it("rejects an unbalanced quote", () => {
		const parsed = parseMingCommand('design "unclosed');
		assert.equal(parsed.ok, false);
		assert.match(parsed.ok ? "" : parsed.error, /Unbalanced quote/);
	});

	it("parses design and layer", () => {
		const design = parseMingCommand("design prompts/hero.txt");
		assert.deepEqual(design, { ok: true, task: "design", promptFile: "prompts/hero.txt" });

		const layer = parseMingCommand('layer prompts/layer.txt "D:\\my art\\board.png"');
		assert.deepEqual(layer, {
			ok: true,
			task: "layer",
			promptFile: "prompts/layer.txt",
			imagePath: "D:\\my art\\board.png",
		});
	});

	it("rejects malformed input with usage", () => {
		for (const args of ["", "draw hero.txt", "design", "layer hero.txt", "design hero.txt extra.png", "design hero.txt stray"]) {
			const parsed = parseMingCommand(args);
			assert.equal(parsed.ok, false, `expected failure for: ${args}`);
			assert.ok(parsed.ok ? "" : parsed.error.includes("Usage:"));
		}
		assert.ok(USAGE.includes("/ming-image design"));
	});
});

describe("output directories", () => {
	it("never reuses a directory under concurrency", async () => {
		const cwd = await scratch();
		const now = new Date("2026-09-28T10:00:00Z");
		const dirs = await Promise.all(
			Array.from({ length: 12 }, () => allocateOutputDir(cwd, "design", now)),
		);
		assert.equal(new Set(dirs).size, 12);
		for (const dir of dirs) await discardOutputDir(dir);
	});

	it("writes under the caller's cwd, not the package", async () => {
		const cwd = await scratch();
		const dir = await allocateOutputDir(cwd, "design");
		assert.equal(path.dirname(path.dirname(dir)).replace(/\\/g, "/"), cwd.replace(/\\/g, "/"));
		await discardOutputDir(dir);
	});

	it("cleans up and reports cancellation that arrives during image writing", async () => {
		const cwd = await scratch();
		const dir = await allocateOutputDir(cwd, "design");
		const controller = new AbortController();
		const image = {
			mime: "image/png" as const,
			get bytes() {
				controller.abort();
				return new Uint8Array(PNG_1X1);
			},
		};
		await assert.rejects(
			() => writeRun(dir, [image], {
				task: "design", model: "m", prompt: "p", output_files: [], elapsed_seconds: 1,
				created_at: new Date().toISOString(),
			}, controller.signal),
			(error: MingImageError) => error.code === "cancelled",
		);
		await assert.rejects(() => readFile(path.join(dir, "manifest.json")), /ENOENT/);
	});

	it("removes the directory when a write fails", async () => {
		const cwd = await scratch();
		const dir = await allocateOutputDir(cwd, "design");
		// A directory where a file is expected makes the image write fail.
		await mkdir(path.join(dir, "design_01.png"));
		await assert.rejects(
			() => writeRun(dir, [{ bytes: new Uint8Array(PNG_1X1), mime: "image/png" }], {
				task: "design",
				model: "m",
				prompt: "p",
				output_files: [],
				elapsed_seconds: 1,
				created_at: new Date().toISOString(),
			}),
			(error: MingImageError) => error.code === "write_failed",
		);
		await assert.rejects(() => readFile(path.join(dir, "manifest.json")), /ENOENT/);
	});
});

describe("generateMingImage", () => {
	const token = { token: "sk-test-not-a-real-token" };

	async function workspace() {
		const cwd = await scratch();
		await writeFile(path.join(cwd, "prompt.txt"), "a calm hero", "utf8");
		await writeFile(path.join(cwd, "board.png"), PNG_1X1);
		return cwd;
	}

	it("saves images and a redacted manifest for design", async () => {
		const cwd = await workspace();
		const { impl } = stubFetch([okImageResponse(1)]);
		const result = await generateMingImage({ task: "design", prompt: "a calm hero", cwd, fetchImpl: impl, ...token });

		assert.equal(result.files.length, 1);
		assert.ok(result.outputDir.startsWith(path.join(cwd, "artifacts")));
		assert.ok((await readFile(result.files[0])).equals(PNG_1X1));

		const manifestText = await readFile(result.manifestPath, "utf8");
		const manifest = JSON.parse(manifestText);
		assert.equal(manifest.task, "design");
		assert.equal(manifest.model, "inclusionai/ming-image-0.1-design");
		assert.deepEqual(manifest.output_files, ["design_01.png"]);
		assert.equal(manifest.usage.total_tokens, 42);
		assert.equal(typeof manifest.elapsed_seconds, "number");
		assert.equal(manifest.input_image, undefined);

		assert.equal(manifestText.includes(token.token), false, "manifest must not contain the token");
		assert.equal(manifestText.includes(PNG_1X1.toString("base64")), false, "manifest must not contain image bytes");
		assert.equal(manifestText.includes("b64_json"), false);
	});

	it("does not persist or return reflected token and image bytes in usage", async () => {
		const cwd = await workspace();
		const encoded = PNG_1X1.toString("base64");
		const { impl } = stubFetch([jsonResponse({
			data: [{ b64_json: encoded }],
			usage: { total_tokens: 42, cost: 0, note: token.token, extra_image: encoded, prompt_tokens: "42" },
		})]);
		const result = await generateMingImage({ task: "design", prompt: "p", cwd, fetchImpl: impl, ...token });
		const manifest = await readFile(result.manifestPath, "utf8");
		assert.deepEqual(result.usage, { total_tokens: 42, cost: 0 });
		assert.deepEqual(JSON.parse(manifest).usage, result.usage);
		assert.equal(manifest.includes(token.token), false);
		assert.equal(manifest.includes(encoded), false);
	});

	it("records the input image path for layer", async () => {
		const cwd = await workspace();
		const { impl, calls } = stubFetch([okImageResponse(3)]);
		const result = await generateMingImage({
			task: "layer",
			prompt: "split this",
			imagePath: "board.png",
			cwd,
			fetchImpl: impl,
			...token,
		});

		const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
		assert.equal(manifest.input_image, path.join(cwd, "board.png"));
		assert.equal(manifest.input_image_bytes, PNG_1X1.length);
		assert.deepEqual(manifest.output_files, ["layer_01.png", "layer_02.png", "layer_03.png"]);

		const sent = JSON.parse((calls[0].init.body as string) as string);
		assert.equal(sent.input_references.length, 1);
		assert.ok(sent.input_references[0].image_url.url.startsWith("data:image/png;base64,"));
	});

	it("refuses layer without an image and design with one", async () => {
		const cwd = await workspace();
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() => generateMingImage({ task: "layer", prompt: "p", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "invalid_input",
		);
		await assert.rejects(
			() => generateMingImage({ task: "design", prompt: "p", imagePath: "board.png", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "invalid_input",
		);
		assert.equal(calls.length, 0, "invalid input must not reach the network");
	});

	it("rejects a renamed non-image before uploading", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "fake.png"), "this is not a png");
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() => generateMingImage({ task: "layer", prompt: "p", imagePath: "fake.png", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "invalid_input",
		);
		assert.equal(calls.length, 0);
	});

	it("rejects a truncated local image before uploading", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "truncated.png"), PNG_1X1.subarray(0, 8));
		const { impl, calls } = stubFetch([okImageResponse()]);
		await assert.rejects(
			() => generateMingImage({ task: "layer", prompt: "p", imagePath: "truncated.png", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "invalid_input",
		);
		assert.equal(calls.length, 0);
	});

	it("rejects a missing image without contacting the network", async () => {
		const cwd = await workspace();
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() => generateMingImage({ task: "layer", prompt: "p", imagePath: "nope.png", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "invalid_input",
		);
		assert.equal(calls.length, 0);
	});

	it("writes nothing when the request fails", async () => {
		const cwd = await workspace();
		const { impl } = stubFetch([jsonResponse({ error: { message: "no credit" } }, 402)]);
		await assert.rejects(
			() => generateMingImage({ task: "design", prompt: "p", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "insufficient_credit",
		);
		const { readdir } = await import("node:fs/promises");
		await assert.rejects(() => readdir(path.join(cwd, "artifacts")), /ENOENT/);
	});

	it("writes nothing when the response has no images", async () => {
		const cwd = await workspace();
		const { impl } = stubFetch([jsonResponse({ data: [] })]);
		await assert.rejects(
			() => generateMingImage({ task: "design", prompt: "p", cwd, fetchImpl: impl, ...token }),
			(error: MingImageError) => error.code === "empty_result",
		);
		const { readdir } = await import("node:fs/promises");
		await assert.rejects(() => readdir(path.join(cwd, "artifacts")), /ENOENT/);
	});

	it("keeps concurrent runs in separate directories", async () => {
		const cwd = await workspace();
		const results = await Promise.all(
			Array.from({ length: 4 }, () => {
				const { impl } = stubFetch([okImageResponse(1)]);
				return generateMingImage({ task: "design", prompt: "p", cwd, fetchImpl: impl, ...token });
			}),
		);
		assert.equal(new Set(results.map((r) => r.outputDir)).size, 4);
		for (const result of results) {
			assert.ok((await readFile(result.files[0])).equals(PNG_1X1));
		}
	});

	it("surfaces a missing credential without a network call", async () => {
		const cwd = await workspace();
		const { impl, calls } = stubFetch([okImageResponse(1)]);
		await assert.rejects(
			() =>
				generateMingImage({
					task: "design",
					prompt: "p",
					cwd,
					fetchImpl: impl,
					tokenSource: { getApiKeyForProvider: async () => undefined },
					env: {},
				}),
			(error: MingImageError) => error.code === "missing_credential",
		);
		assert.equal(calls.length, 0);
	});
});
