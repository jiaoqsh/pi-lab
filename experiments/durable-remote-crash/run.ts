// pi-durable's coding tools run on a pi-env daemon (started here over a local pipe, as it would be over SSH). A bash
// call runs `sleep 3` and then writes a marker file. Failures while it runs:
//   A. the daemon process is killed (a crash or OOM kill): what the tool result says, whether the command survives,
//      and whether the next call reconnects on its own;
//   A2. the transport is cut while the daemon lives (a dropped SSH connection), via fixtures/pipe-proxy.ts;
//   B. the harness process dies: whether the daemon stops the half-run command, and what the model sees after the
//      harness reopens its storage.
// Child mode (scenario B): run.ts <dir> <crash|resume>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type Storage, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { emit, log, ROOT, scratchDir } from "../../lib/experiment.ts";
import { localConnection, localDaemon } from "../../lib/pi-env.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const bash = (command: string, id: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

/** A harness whose tools run on the daemon, in `workDir`, with scripted model turns. */
async function openHarness(storage: Storage, connection: Connection, workDir: string, turns: ReturnType<typeof bash>[]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(turns);
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(
		storage,
		{ models, registry, env: () => new RemoteExecutionEnv({ connection, id: "pi-env:local", cwd: workDir }) },
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workDir } });
	return { harness, root };
}

/** Tool results of the root conversation, oldest first, with the scratch directory hidden. */
async function toolResults(root: Awaited<ReturnType<typeof openHarness>>["root"], workDir: string) {
	const entries = await root.entries({}, 100, undefined, context);
	return [...entries.items]
		.reverse()
		.filter((entry) => ToolResultEntry.is(entry))
		.map((entry) => {
			const message = entry.model![0] as ToolResultMessage;
			const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("").replaceAll(workDir, "<cwd>");
			return { isError: message.isError, text: text.trim() };
		});
}

const MARKER_COMMAND = "sleep 3 && echo finished > marker.txt";

/**
 * Kill the process `victim` picks (given the daemon's pid) one second into the first command; the second command
 * shows whether the connection recovers.
 */
async function cutMidCommand(label: string, connection: Connection, victim: (daemonPid: number) => number) {
	const workDir = scratchDir(label);
	const { harness, root } = await openHarness(new MemoryStorage(), connection, workDir, [
		bash(MARKER_COMMAND, "a1"),
		bash("echo second call; ls", "a2"),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const daemonPid = (await connection.info()).pid;
	const submission = await root.submit({ type: "input", content: "go" }, context);
	await sleep(1000);
	process.kill(victim(daemonPid), "SIGKILL");
	const settled = await submission.wait(context);
	await sleep(3000); // past the end of the killed command
	const result = {
		status: settled.status,
		toolResults: await toolResults(root, workDir),
		markerWritten: existsSync(join(workDir, "marker.txt")),
		oldDaemonAlive: isAlive(daemonPid),
		newDaemonStarted: (await connection.info()).pid !== daemonPid,
	};
	await harness.close(context);
	connection.close();
	return result;
}

async function child(dir: string, phase: "crash" | "resume") {
	const workDir = join(dir, "work");
	mkdirSync(workDir, { recursive: true });
	const connection = localConnection();
	const turns = phase === "crash" ? [bash(MARKER_COMMAND, "b1")] : [fauxAssistantMessage([fauxText("done")])];
	const { harness, root } = await openHarness(await openNodeJsonlStorage(join(dir, "storage"), context), connection, workDir, turns);
	if (phase === "crash") {
		writeFileSync(join(dir, "daemon.pid"), String((await connection.info()).pid));
		await root.submit({ type: "input", content: "go", requestId: "b" }, context);
		await sleep(1000);
		process.exit(1); // the daemon's stdin closes with this process
	}
	const settled = await (await root.submit({ type: "input", content: "go", requestId: "b" }, context)).wait(context);
	process.stdout.write(JSON.stringify({ status: settled.status, toolResults: await toolResults(root, workDir) }));
	await harness.close(context);
	connection.close();
}

async function scenarioB() {
	const dir = scratchDir("remote-b");
	const run = (phase: string) => spawnSync(process.execPath, [import.meta.filename, dir, phase], { encoding: "utf8" });
	const crash = run("crash");
	const daemonPid = Number(readFileSync(join(dir, "daemon.pid"), "utf8"));
	await sleep(500);
	const daemonAliveAfterCrash = isAlive(daemonPid);
	await sleep(3500); // past the end of the command, had it kept running
	const markerWritten = existsSync(join(dir, "work", "marker.txt"));
	const resume = run("resume");
	if (resume.status !== 0) throw new Error(`resume failed: ${resume.stderr}`);
	return { crashExitCode: crash.status, daemonAliveAfterCrash, markerWritten, afterRestart: JSON.parse(resume.stdout) };
}

if (process.argv.length > 2) {
	const [dir, phase] = process.argv.slice(2);
	await child(dir, phase as "crash" | "resume");
} else {
	log("A: kill the daemon mid-command");
	const a = await cutMidCommand("remote-a", localConnection(), (daemonPid) => daemonPid);
	log("A2: cut the transport mid-command");
	const pidFile = join(scratchDir("proxy"), "proxy.pid");
	process.env.PIPE_PROXY_PID_FILE = pidFile;
	const proxied = new Connection({ command: [process.execPath, join(ROOT, "fixtures", "pipe-proxy.ts"), localDaemon()] });
	const a2 = await cutMidCommand("remote-a2", proxied, () => Number(readFileSync(pidFile, "utf8")));
	log("B: kill the harness process mid-command");
	const b = await scenarioB();
	await emit({
		command: MARKER_COMMAND,
		"A: daemon process killed mid-command": a,
		"A2: transport cut mid-command (daemon alive)": a2,
		"B: harness process dies mid-command": b,
	});
}
