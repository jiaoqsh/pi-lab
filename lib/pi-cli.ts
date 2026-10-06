// Run the published `pi` CLI in an isolated config directory and collect its JSON events and session file.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, scratchDir } from "./experiment.ts";

/** The published CLI entry point. Experiments can pass a modified copy to `runPi` instead. */
export const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
export const SHOP_SERVER = join(ROOT, "fixtures", "shop-mcp-server.ts");

export interface AgentDirOptions {
	/** Adds the shop MCP server with this exposure. */
	shopExposure?: "codemode" | "deferred" | "direct";
	/** Extension files copied into the agent's extensions/ directory, where pi discovers them. */
	extensions?: string[];
	settings?: Record<string, unknown>;
	/** Written as models.json: custom providers such as an OpenAI-compatible endpoint. */
	models?: Record<string, unknown>;
}

/** A fresh PI_CODING_AGENT_DIR: settings.json, mcp.json, and extensions, nothing from ~/.pi. */
export function createAgentDir(name: string, options: AgentDirOptions = {}): string {
	const dir = scratchDir(`agent-${name}`);
	writeFileSync(join(dir, "settings.json"), JSON.stringify(options.settings ?? {}, null, 2));
	if (options.models) writeFileSync(join(dir, "models.json"), JSON.stringify(options.models, null, 2));
	if (options.shopExposure) {
		const shop = { command: process.execPath, args: [SHOP_SERVER], description: "Shop backend with orders and customers" };
		const server = options.shopExposure === "codemode" ? shop : { ...shop, exposure: options.shopExposure };
		writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { shop: server } }, null, 2));
	}
	if (options.extensions?.length) {
		mkdirSync(join(dir, "extensions"));
		for (const file of options.extensions) copyFileSync(file, join(dir, "extensions", basename(file)));
	}
	return dir;
}

// Loosely typed views of pi's JSON events and session entries; only the fields the experiments read.
export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
export interface PiMessage {
	role: string;
	content: ContentBlock[] | string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	toolName?: string;
	isError?: boolean;
	toolsAdded?: { name: string }[];
	usage?: { input: number; output: number; cacheRead: number; cost: { total: number } };
}
export interface PiEvent {
	type: string;
	message?: PiMessage;
}
export interface SessionEntry {
	type: string;
	message?: PiMessage;
	customType?: string;
	data?: unknown;
	provider?: string;
	modelId?: string;
}

export interface PiRun {
	exitCode: number | null;
	events: PiEvent[];
	session: SessionEntry[];
	stderr: string;
}

/** Run `pi --mode json <prompt>`. stdin is closed: with an open pipe, pi waits for it to end before starting. */
export function runPi(
	agentDir: string,
	cwd: string,
	args: string[],
	prompt: string,
	timeoutMs = 300_000,
	cli = PI_CLI,
): Promise<PiRun> {
	const sessionDir = join(agentDir, "sessions", basename(cwd));
	mkdirSync(sessionDir, { recursive: true });
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, ...args, "--mode", "json", prompt], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			const events = stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as PiEvent);
			const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
			const session = files.length
				? readFileSync(join(sessionDir, files.sort().at(-1)!), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as SessionEntry)
				: [];
			resolve({ exitCode, events, session, stderr });
		});
	});
}

export function messagesOf(run: PiRun, role: string): PiMessage[] {
	return run.events.filter((e) => e.type === "message_end" && e.message?.role === role).map((e) => e.message!);
}

export function textOf(message: PiMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => block.text ?? "").join("");
}

/** Usage summed over a run's assistant messages. */
export function usageOf(run: PiRun) {
	const assistants = messagesOf(run, "assistant");
	const sum = (pick: (m: PiMessage) => number) => assistants.reduce((total, m) => total + pick(m), 0);
	return {
		turns: assistants.length,
		inputTokens: sum((m) => m.usage?.input ?? 0),
		cacheReadTokens: sum((m) => m.usage?.cacheRead ?? 0),
		outputTokens: sum((m) => m.usage?.output ?? 0),
		costUsd: Math.round(sum((m) => m.usage?.cost.total ?? 0) * 10000) / 10000,
	};
}
