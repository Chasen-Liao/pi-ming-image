/**
 * Drives the real extension module: registers the factory against a stub ExtensionAPI,
 * then invokes the command handler and the tool execute() with a stubbed fetch.
 *
 * This covers the wiring the unit suite cannot: argument parsing feeding the shared
 * implementation, cwd-relative prompt files, and the text the model actually receives.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import mingImageExtension from "../extensions/index.ts";
import { USAGE } from "../lib/command-args.ts";
import { photoPng } from "./fixtures.ts";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const scratchDirs: string[] = [];

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};

/** Minimal stand-ins for the parts of ExtensionAPI / ExtensionContext the extension uses. */
function makeHost(overrides: { cwd: string; token?: string } ) {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const notices: { message: string; level: string }[] = [];

	const pi = {
		registerCommand(name: string, options: RegisteredCommand) {
			commands.set(name, options);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on() {
			return () => {};
		},
	};

	mingImageExtension(pi as never);

	const ctx = {
		cwd: overrides.cwd,
		mode: "rpc",
		hasUI: true,
		ui: {
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
		},
		modelRegistry: {
			getApiKeyForProvider: async () => overrides.token ?? "sk-test-not-a-real-token",
		},
	};

	return { commands, tools, notices, ctx };
}

function okImageResponse(count = 1) {
	return new Response(
		JSON.stringify({
			data: Array.from({ length: count }, () => ({ b64_json: PNG_1X1.toString("base64") })),
			usage: { total_tokens: 10, cost: 0 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function stubFetch(payload: Buffer = PNG_1X1) {
	const calls: { url: string; body: any }[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
		return new Response(JSON.stringify({ data: [{ b64_json: payload.toString("base64") }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

async function workspace() {
	const dir = await mkdtemp(path.join(tmpdir(), "ming-ext-"));
	scratchDirs.push(dir);
	await writeFile(path.join(dir, "prompt.txt"), "a calm hero", "utf8");
	await writeFile(path.join(dir, "board.png"), PNG_1X1);
	return dir;
}

after(async () => {
	await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("extension registration", () => {
	it("registers the command and the tool", () => {
		const host = makeHost({ cwd: "C:/nowhere" });
		assert.ok(host.commands.has("ming-image"));
		assert.ok(host.tools.has("generate_ming_image"));
		assert.equal(host.tools.get("generate_ming_image")?.label, "Ming Image");
		assert.ok(host.commands.get("ming-image")?.description.length);
	});

	it("tells the model that layer uploads the image", () => {
		const tool = makeHost({ cwd: "C:/nowhere" }).tools.get("generate_ming_image");
		assert.ok(tool);
		assert.match(tool.description, /upload/i);
		assert.match(tool.description, /imagePath/);
	});

	it("tells the model to read previews, not the full-size files", () => {
		const tool = makeHost({ cwd: "C:/nowhere" }).tools.get("generate_ming_image");
		assert.ok(tool);
		// Reading a full-resolution layer costs megabytes of base64 per image and
		// those bytes are resent with every later request, which is the stall.
		assert.match(tool.description, /previews/);
		assert.match(tool.description, /context/i);
	});

	it("registers nothing extra", () => {
		const host = makeHost({ cwd: "C:/nowhere" });
		assert.deepEqual([...host.commands.keys()], ["ming-image"]);
		assert.deepEqual([...host.tools.keys()], ["generate_ming_image"]);
	});
});

describe("/ming-image command", () => {
	it("runs a design request from a prompt file and reports saved paths", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		try {
			await host.commands.get("ming-image")!.handler("design prompt.txt", host.ctx);
		} finally {
			globalThis.fetch = original;
		}

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
		assert.equal(calls[0].body.model, "inclusionai/ming-image-0.1-design");
		assert.equal(calls[0].body.prompt, "a calm hero");

		// ctx.ui.notify only accepts info | warning | error, so a finished run
		// reports as info rather than a level Pi would reject.
		const success = host.notices.filter((n) => /image\(s\)/.test(n.message)).at(-1);
		assert.ok(success, "expected a completion notification");
		assert.equal(success.level, "info");
		assert.match(success.message, /1 image\(s\)/);
		assert.match(success.message, /manifest:/);
		// Progress must reach the user before the run finishes.
		assert.ok(
			host.notices.some((n) => /validating input/.test(n.message)),
			"expected stage progress notifications",
		);

		const dir = path.join(cwd, "artifacts");
		const run = (await import("node:fs/promises")).readdir(dir);
		const entries = await run;
		assert.equal(entries.length, 1);
		assert.ok((await readFile(path.join(dir, entries[0], "design_01.png"))).equals(PNG_1X1));
	});

	it("rejects bad arguments without sending a request", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		try {
			await host.commands.get("ming-image")!.handler("layer prompt.txt", host.ctx);
			await host.commands.get("ming-image")!.handler("draw prompt.txt", host.ctx);
			await host.commands.get("ming-image")!.handler("design prompt.txt board.png", host.ctx);
		} finally {
			globalThis.fetch = original;
		}
		assert.equal(calls.length, 0, "invalid input must not reach the network");
		for (const note of host.notices) {
			assert.equal(note.level, "error");
			assert.match(note.message, new RegExp(USAGE.split("\n")[1].replace(/[/<>]/g, "\\$&")));
		}
	});

	it("reports a missing prompt file as an error, not a crash", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		await host.commands.get("ming-image")!.handler("design missing.txt", host.ctx);
		const note = host.notices.at(-1);
		assert.equal(note?.level, "error");
		assert.match(note?.message ?? "", /invalid_input/);
	});

	it("resolves a quoted prompt path with spaces", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "my prompt.txt"), "quoted prompt", "utf8");
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		try {
			await host.commands.get("ming-image")!.handler('design "my prompt.txt"', host.ctx);
		} finally {
			globalThis.fetch = original;
		}
		assert.equal(calls[0].body.prompt, "quoted prompt");
	});
});

describe("generate_ming_image tool", () => {
	it("sends a design request and returns paths without image bytes", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		let result: Awaited<ReturnType<RegisteredTool["execute"]>>;
		try {
			result = await host.tools
				.get("generate_ming_image")!
				.execute("call-1", { task: "design", prompt: "a calm hero" }, undefined, undefined, host.ctx);
		} finally {
			globalThis.fetch = original;
		}

		assert.equal(calls[0].body.model, "inclusionai/ming-image-0.1-design");
		assert.equal("input_references" in calls[0].body, false);

		const text = result.content.map((c) => c.text).join("\n");
		assert.match(text, /1 image\(s\)/);
		assert.equal(text.includes(PNG_1X1.toString("base64")), false, "must not put base64 in the model context");
		assert.equal(text.includes("sk-test"), false, "must not leak the token");
		assert.ok((result.details as { files: string[] }).files.length === 1);
	});

	it("sends the input image for a layer request", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		try {
			await host.tools
				.get("generate_ming_image")!
				.execute("call-2", { task: "layer", prompt: "split", imagePath: "board.png" }, undefined, undefined, host.ctx);
		} finally {
			globalThis.fetch = original;
		}
		assert.equal(calls[0].body.model, "inclusionai/ming-image-0.1-design-layer");
		assert.equal(calls[0].body.input_references.length, 1);
		assert.ok(calls[0].body.input_references[0].image_url.url.startsWith("data:image/png;base64,"));
	});

	it("points the model at the small preview in the text it actually reads", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl } = stubFetch(photoPng());
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		let result: Awaited<ReturnType<RegisteredTool["execute"]>>;
		try {
			result = await host.tools
				.get("generate_ming_image")!
				.execute("call-4", { task: "design", prompt: "a calm hero" }, undefined, undefined, host.ctx);
		} finally {
			globalThis.fetch = original;
		}

		// The whole point is that the model is sent somewhere cheap to look.
		const text = result.content.map((c) => c.text).join("\n");
		assert.match(text, /previews[\\/]design_01\.png/);

		const details = result.details as { previewFiles: string[]; outputDir: string };
		assert.deepEqual(details.previewFiles, ["previews/design_01.png"]);
		const onDisk = await readFile(path.join(details.outputDir, "previews", "design_01.png"));
		const full = await readFile(path.join(details.outputDir, "design_01.png"));
		assert.ok(onDisk.length * 2 < full.length, `preview ${onDisk.length}B vs full ${full.length}B`);
	});

	it("validates arguments before spending a request", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		const { impl, calls } = stubFetch();
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		const tool = host.tools.get("generate_ming_image")!;
		const cases = [
			{ task: "layer", prompt: "p" },
			{ task: "design", prompt: "p", imagePath: "board.png" },
			{ task: "design", prompt: "   " },
		];
		for (const params of cases) {
			await assert.rejects(() => tool.execute("c", params, undefined, undefined, host.ctx), /MingImageError|invalid/);
		}
		globalThis.fetch = original;
		assert.equal(calls.length, 0);
	});

	it("streams stage updates so the wait is never silent", async () => {
		const cwd = await workspace();
		const host = makeHost({ cwd });
		// Hold the response open so the update stream is observed mid-flight.
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const impl = (async () => {
			await gate;
			return okImageResponse(1);
		}) as unknown as typeof fetch;

		const updates: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		const pending = host.tools
			.get("generate_ming_image")!
			.execute(
				"call-3",
				{ task: "design", prompt: "a calm hero" },
				undefined,
				(partial: { content: { text: string }[] }) => updates.push(partial.content[0].text),
				host.ctx,
			);
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(updates.length > 0, "expected progress before the request resolved");
			release();
			const result = await pending;
			assert.ok(updates.length >= 2);
			assert.match(updates[0], /validating input/);
			// The ceiling must be visible up front, not only once a heartbeat fires.
			assert.ok(updates.some((u) => /timeout 600s/.test(u)), `no timeout in ${JSON.stringify(updates)}`);
			assert.match(result.content.map((c) => c.text).join("\n"), /1 image\(s\)/);
		} finally {
			globalThis.fetch = original;
		}
	});
});
