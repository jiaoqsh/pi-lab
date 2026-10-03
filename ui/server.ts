// Local web UI for pi-lab: browse experiment notes, run experiments with live logs, review snapshot diffs, set keys.
//
//   npm run ui            then open the printed URL (it carries the access token)
//
// The server only listens on 127.0.0.1. Because it runs processes and can spend API credits, every API request must
// also carry the random token printed at startup (a page on another site cannot read it), and requests whose Host
// header is not this server are rejected (DNS rebinding).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import { marked, type Tokens } from "marked";
import {
	acceptSnapshot,
	type Experiment,
	lastRunFile,
	loadExperiments,
	missingKeys,
	type Outcome,
	piVersions,
	ROOT,
	runExperiment,
	snapshotFile,
} from "../runner/core.ts";

const PORT = Number(process.env.PI_LAB_PORT ?? 4173);
const HOST = "127.0.0.1";
const TOKEN = randomBytes(24).toString("base64url");
const ENV_FILE = join(ROOT, ".env");
const REPO_BLOB = "https://github.com/jiaoqsh/pi-lab/blob/main";
const INDEX_HTML = join(import.meta.dirname, "index.html");

// ─── Keys ──────────────────────────────────────────────────────────────────

/** Keys entered in the UI and not saved to .env; gone when the server stops. */
const sessionKeys = new Map<string, string>();

/** Only keys some experiment declares can be set, so the UI cannot inject variables such as NODE_OPTIONS. */
function knownKeys(experiments: Experiment[]): string[] {
	return [...new Set(experiments.flatMap((each) => each.meta.keys))].sort();
}

function readEnvFile(): Record<string, string> {
	if (!existsSync(ENV_FILE)) return {};
	return parseEnv(readFileSync(ENV_FILE, "utf8")) as Record<string, string>;
}

/** Environment for a run: the server's environment, then .env (re-read each time), then keys entered in the UI. */
function runEnv(): NodeJS.ProcessEnv {
	return { ...process.env, ...readEnvFile(), ...Object.fromEntries(sessionKeys) };
}

function keySource(name: string, fileEnv: Record<string, string>): "ui" | "env-file" | "environment" | null {
	if (sessionKeys.get(name)) return "ui";
	if (fileEnv[name]) return "env-file";
	if (process.env[name]) return "environment";
	return null;
}

/** Set or remove `name=value` in .env, keeping the other lines. */
function saveToEnvFile(name: string, value: string): void {
	const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
	const kept = lines.filter((line) => !line.startsWith(`${name}=`));
	if (value) kept.splice(kept.at(-1) === "" ? kept.length - 1 : kept.length, 0, `${name}=${value}`);
	writeFileSync(ENV_FILE, `${kept.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

// ─── Runs ──────────────────────────────────────────────────────────────────

interface Run {
	id: string;
	experiment: string;
	startedAt: string;
	log: string;
	outcome?: Outcome;
	controller: AbortController;
	listeners: Set<ServerResponse>;
}

const runs = new Map<string, Run>();
/** The latest run per experiment, for the sidebar status and late-joining viewers. */
const latestRun = new Map<string, Run>();

function sse(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startRun(experiment: Experiment): Run {
	const run: Run = {
		id: randomBytes(8).toString("hex"),
		experiment: experiment.name,
		startedAt: new Date().toISOString(),
		log: "",
		controller: new AbortController(),
		listeners: new Set(),
	};
	runs.set(run.id, run);
	latestRun.set(experiment.name, run);
	void runExperiment(experiment, {
		env: runEnv(),
		signal: run.controller.signal,
		onLog: (chunk) => {
			run.log += chunk;
			for (const res of run.listeners) sse(res, "log", chunk);
		},
	}).then((outcome) => {
		run.outcome = outcome;
		for (const res of run.listeners) {
			sse(res, "done", outcome);
			res.end();
		}
		run.listeners.clear();
	});
	return run;
}

// ─── Notes ─────────────────────────────────────────────────────────────────

/** Render NOTES.md: links to other notes navigate inside the UI, other repo files open on GitHub. */
function renderNotes(experiment: Experiment): string {
	const file = join(experiment.dir, "NOTES.md");
	if (!existsSync(file)) return "<p>No notes yet.</p>";
	const base = `experiments/${experiment.name}`;
	const tokens = marked.lexer(readFileSync(file, "utf8"));
	marked.walkTokens(tokens, (token) => {
		if (token.type !== "link") return;
		const link = token as Tokens.Link;
		if (/^[a-z]+:/i.test(link.href) || link.href.startsWith("#")) return;
		const target = posix.normalize(posix.join(base, link.href));
		const notes = /^experiments\/([^/]+)\/NOTES\.md$/.exec(target);
		link.href = notes ? `#/exp/${notes[1]}` : `${REPO_BLOB}/${target}`;
	});
	return marked.parser(tokens).replaceAll('<a href="http', '<a target="_blank" rel="noreferrer" href="http');
}

// ─── Code ──────────────────────────────────────────────────────────────────

hljs.registerLanguage("typescript", typescript);

/** TypeScript files under `dir`, relative to the repo root, run.ts first. */
function experimentSources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => relative(ROOT, join(dir, file)).split(sep).join("/"))
		.sort((a, b) => Number(b.endsWith("/run.ts")) - Number(a.endsWith("/run.ts")) || a.localeCompare(b));
}

/**
 * The experiment's own sources plus the files its meta.json lists under `related`. Only .ts files inside the repo
 * (and outside node_modules) are served, so this cannot be used to read .env or anything else.
 */
function experimentCode(experiment: Experiment) {
	const paths = [...experimentSources(experiment.dir), ...(experiment.meta.related ?? [])];
	return paths.flatMap((path) => {
		const absolute = resolve(ROOT, path);
		const inside = absolute.startsWith(ROOT + sep) && !absolute.includes(`${sep}node_modules${sep}`);
		if (!inside || !absolute.endsWith(".ts") || !existsSync(absolute)) return [];
		const source = readFileSync(absolute, "utf8");
		return [
			{
				path,
				lines: source.split("\n").length,
				html: hljs.highlight(source, { language: "typescript" }).value,
				url: `${REPO_BLOB}/${path}`,
			},
		];
	});
}

function readJson(file: string): unknown {
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, url: URL): boolean {
	const given = Buffer.from(String(req.headers["x-pi-lab-token"] ?? url.searchParams.get("token") ?? ""));
	const expected = Buffer.from(TOKEN);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (text.length > 64 * 1024) throw new Error("body too large");
	}
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function state() {
	const experiments = loadExperiments();
	const env = runEnv();
	const fileEnv = readEnvFile();
	return {
		versions: piVersions(),
		keys: knownKeys(experiments).map((name) => ({ name, source: keySource(name, fileEnv) })),
		experiments: experiments.map((experiment) => {
			const run = latestRun.get(experiment.name);
			const lastRun = readJson(lastRunFile(experiment)) as { ranAt: string; versions: string } | undefined;
			return {
				name: experiment.name,
				meta: experiment.meta,
				missingKeys: missingKeys(experiment, env),
				lastRecorded: lastRun ? { ranAt: lastRun.ranAt, versions: lastRun.versions } : undefined,
				run: run && { id: run.id, running: !run.outcome, status: run.outcome?.status, seconds: run.outcome?.seconds },
			};
		}),
	};
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
	const experiments = loadExperiments();
	const find = (name: string | undefined) => experiments.find((each) => each.name === name);

	if (req.method === "GET" && parts[0] === "state") return send(res, 200, state());

	if (parts[0] === "experiments") {
		const experiment = find(parts[1]);
		if (!experiment) return send(res, 404, { error: "unknown experiment" });
		if (req.method === "GET" && parts.length === 2) {
			const offline = experiment.meta.keys.length === 0;
			return send(res, 200, {
				name: experiment.name,
				meta: experiment.meta,
				notesHtml: renderNotes(experiment),
				stored: offline ? readJson(snapshotFile(experiment)) : readJson(lastRunFile(experiment)),
				storedKind: offline ? "snapshot.json" : "last-run.json",
			});
		}
		if (req.method === "GET" && parts[2] === "code") return send(res, 200, { files: experimentCode(experiment) });
		if (req.method === "POST" && parts[2] === "run") {
			const current = latestRun.get(experiment.name);
			if (current && !current.outcome) return send(res, 409, { error: "already running", runId: current.id });
			const missing = missingKeys(experiment, runEnv());
			if (missing.length) return send(res, 400, { error: `missing keys: ${missing.join(", ")}` });
			return send(res, 200, { runId: startRun(experiment).id });
		}
		if (req.method === "POST" && parts[2] === "accept") {
			const { runId } = await body(req);
			const run = runs.get(String(runId));
			if (!run || run.experiment !== experiment.name || run.outcome?.status !== "changed") {
				return send(res, 400, { error: "no changed result to accept" });
			}
			acceptSnapshot(experiment, run.outcome.result);
			run.outcome = { ...run.outcome, status: "updated" };
			return send(res, 200, { ok: true });
		}
	}

	if (parts[0] === "runs") {
		const run = runs.get(String(parts[1]));
		if (!run) return send(res, 404, { error: "unknown run" });
		if (req.method === "GET" && parts[2] === "events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			// Late joiners get the log so far, then live chunks.
			if (run.log) sse(res, "log", run.log);
			if (run.outcome) {
				sse(res, "done", run.outcome);
				return void res.end();
			}
			run.listeners.add(res);
			req.on("close", () => run.listeners.delete(res));
			return;
		}
		if (req.method === "POST" && parts[2] === "stop") {
			run.controller.abort();
			return send(res, 200, { ok: true });
		}
	}

	if (req.method === "POST" && parts[0] === "keys") {
		const { name, value, persist } = await body(req);
		if (typeof name !== "string" || !knownKeys(experiments).includes(name)) return send(res, 400, { error: "unknown key" });
		const text = typeof value === "string" ? value.trim() : "";
		if (persist) {
			saveToEnvFile(name, text);
			sessionKeys.delete(name);
		} else if (text) sessionKeys.set(name, text);
		else sessionKeys.delete(name);
		return send(res, 200, { ok: true });
	}

	send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
	const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`];
	if (!allowedHosts.includes(req.headers.host ?? "")) {
		res.writeHead(403).end("forbidden host");
		return;
	}
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	if (url.pathname === "/" && req.method === "GET") {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
			"referrer-policy": "no-referrer",
		});
		res.end(readFileSync(INDEX_HTML));
		return;
	}
	if (url.pathname.startsWith("/api/")) {
		if (!authorized(req, url)) return send(res, 401, { error: "missing or wrong token: open the URL printed by npm run ui" });
		handleApi(req, res, url).catch((error: unknown) => send(res, 500, { error: (error as Error).message }));
		return;
	}
	send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
	console.log(`pi-lab UI: http://${HOST}:${PORT}/#token=${TOKEN}`);
	console.log("Listening on 127.0.0.1 only. Ctrl+C to stop.");
});
