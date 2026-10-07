// Inputs for the release analyst: pi's changelogs (from GitHub, since not every npm package ships one) and the
// per-experiment sections of a tracking report written by runner/core.ts.

/** Package directories under packages/ in earendil-works/pi. */
export const PACKAGES = ["ai", "agent", "codemode", "coding-agent", "durable", "env", "mcp", "tui"];

const cache = new Map<string, string>();

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

/** The changelog sections of `pkg` for releases after `from` up to and including `to`, read at tag v<to>. */
export async function fetchChangelog(pkg: string, from: string, to: string): Promise<string> {
	if (!PACKAGES.includes(pkg)) throw new Error(`Unknown package "${pkg}". Known: ${PACKAGES.join(", ")}`);
	const url = `https://raw.githubusercontent.com/earendil-works/pi/v${to}/packages/${pkg}/CHANGELOG.md`;
	let text = cache.get(url);
	if (text === undefined) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
		text = await response.text();
		cache.set(url, text);
	}
	const sections = text.split(/\n(?=## \[)/).filter((section) => {
		const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
		return version !== undefined && compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
	});
	const body = sections.join("\n").trim();
	if (!body) return `No changelog entries for ${pkg} between ${from} and ${to}.`;
	return body.length > 15_000 ? `${body.slice(0, 15_000)}\n… (truncated)` : body;
}

/** The report's "## <experiment>: <status>" section with its diff, if the report has one. */
export function extractSection(report: string, experiment: string): string | undefined {
	const start = report.search(new RegExp(`^## ${experiment}: `, "m"));
	if (start === -1) return undefined;
	const next = report.indexOf("\n## ", start + 1);
	return report.slice(start, next === -1 ? undefined : next).trim();
}

// ─── Tracing a change to code: commits, diffs, and sources at a tag (GitHub API) ───────────────────────────────────

const REPO = "earendil-works/pi";

async function github(path: string): Promise<unknown> {
	const headers: Record<string, string> = { accept: "application/vnd.github+json" };
	// Unauthenticated requests are limited to 60 an hour; CI and `gh auth token` provide a token.
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers });
	if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
	return response.json();
}

interface CommitSummary {
	sha: string;
	commit: { message: string };
}

/** Commits between tags v<from> and v<to> that touch packages/<pkg>, newest first: short sha and subject. */
export async function listCommits(pkg: string, from: string, to: string): Promise<string> {
	if (!PACKAGES.includes(pkg)) throw new Error(`Unknown package "${pkg}". Known: ${PACKAGES.join(", ")}`);
	const compare = (await github(`compare/v${from}...v${to}`)) as { commits: CommitSummary[] };
	const inRange = new Set(compare.commits.map((c) => c.sha));
	const touching = (await github(`commits?sha=v${to}&path=packages/${pkg}&per_page=100`)) as CommitSummary[];
	const lines = touching.filter((c) => inRange.has(c.sha)).map((c) => `${c.sha.slice(0, 9)} ${c.commit.message.split("\n")[0]}`);
	return lines.length ? lines.join("\n") : `No commits touching packages/${pkg} between v${from} and v${to}.`;
}

/** One commit's message and its patch, limited to files under `pathPrefix` when given. */
export async function commitDiff(sha: string, pathPrefix = ""): Promise<string> {
	if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("sha must be 7 to 40 hex characters");
	const commit = (await github(`commits/${sha}`)) as {
		commit: { message: string };
		files: { filename: string; patch?: string }[];
	};
	const files = commit.files.filter((file) => file.filename.startsWith(pathPrefix));
	const body = [
		commit.commit.message.trim(),
		...files.map((file) => `--- ${file.filename}\n${file.patch ?? "(no textual patch)"}`),
	].join("\n\n");
	return body.length > 20_000 ? `${body.slice(0, 20_000)}\n… (truncated)` : body;
}

/** A source file of the pi repo at tag v<version>; `path` starts with packages/. */
export async function readSource(path: string, version: string): Promise<string> {
	if (!/^packages\/[\w./-]+$/.test(path) || path.includes("..")) throw new Error("path must be a file under packages/");
	const url = `https://raw.githubusercontent.com/${REPO}/v${version}/${path}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
	const text = await response.text();
	return text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (truncated)` : text;
}
