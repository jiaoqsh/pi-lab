// Stands in for the ssh client between a pi-env Connection and its daemon: starts the command given as arguments and
// copies stdin/stdout/stderr through pipes. Killing this process cuts the transport while the daemon keeps running, as
// a dropped SSH connection would. Writes its pid to $PIPE_PROXY_PID_FILE when set.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.env.PIPE_PROXY_PID_FILE) writeFileSync(process.env.PIPE_PROXY_PID_FILE, String(process.pid));
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("exit", (code) => process.exit(code ?? 1));
