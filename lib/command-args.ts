/**
 * Argument parsing for `/ming-image`.
 *
 * Accepts quoted paths so Windows paths with spaces work:
 *   /ming-image design prompts/hero.txt
 *   /ming-image layer prompts/layer.txt "D:\my art\board.png"
 */

import { MING_TASKS, type MingTask } from "./types.ts";

export type ParsedCommand =
	| { ok: true; task: MingTask; promptFile: string; imagePath?: string }
	| { ok: false; error: string };

export const USAGE = [
	"Usage:",
	"  /ming-image design <prompt-file>",
	"  /ming-image layer <prompt-file> <image-path>",
	"",
	"Quote paths that contain spaces. Layer uploads <image-path> to OpenRouter.",
].join("\n");

/** Split on whitespace while honouring single and double quotes. */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (const char of input) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started || current) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}

	if (quote) {
		throw new Error("Unbalanced quote in arguments.");
	}
	if (started || current) {
		tokens.push(current);
	}
	return tokens;
}

export function parseMingCommand(input: string): ParsedCommand {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, error: `Missing arguments.\n${USAGE}` };
	}

	let tokens: string[];
	try {
		tokens = tokenize(trimmed);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const [task, promptFile, imagePath, ...extra] = tokens;
	if (!MING_TASKS.includes(task as MingTask)) {
		return { ok: false, error: `Unknown task "${task ?? ""}". Use design or layer.\n${USAGE}` };
	}
	if (!promptFile) {
		return { ok: false, error: `Missing prompt file.\n${USAGE}` };
	}
	if (extra.length > 0) {
		return { ok: false, error: `Unexpected extra arguments.\n${USAGE}` };
	}
	if (task === "layer" && !imagePath) {
		return { ok: false, error: `Layer requires an image path.\n${USAGE}` };
	}
	if (task === "design" && imagePath) {
		return { ok: false, error: `Design accepts a prompt file only; drop the image path.\n${USAGE}` };
	}

	return imagePath === undefined
		? { ok: true, task: task as MingTask, promptFile }
		: { ok: true, task: task as MingTask, promptFile, imagePath };
}
