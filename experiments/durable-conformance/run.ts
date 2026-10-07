// Run pi-durable's own conformance suites, which define what an ExecutionEnv and a Storage must do, against the
// implementations a host can pick: the local NodeExecutionEnv, the pi-env daemon (RemoteExecutionEnv, here started on
// this machine instead of over SSH), and the memory, JSONL, and SQLite storages.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createEnvConformance,
	createStorageConformance,
	type StorageConformanceAssertions,
} from "@earendil-works/pi-durable/testing";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { emit, log, truncate } from "../../lib/experiment.ts";
import { localConnection } from "../../lib/pi-env.ts";

const context = BACKGROUND_CONTEXT;

/** `expected`'s fields must be present in `actual` with equal values; arrays compare element by element. */
function partialMatch(actual: unknown, expected: unknown): boolean {
	if (expected === null || typeof expected !== "object") return isDeepStrictEqual(actual, expected);
	if (actual === null || typeof actual !== "object") return false;
	if (Array.isArray(expected)) {
		return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => partialMatch(actual[i], item));
	}
	return Object.entries(expected).every(([key, value]) => partialMatch((actual as Record<string, unknown>)[key], value));
}

const assertions: StorageConformanceAssertions = {
	ok: (value, message) => assert.ok(value, message),
	strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
	deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
	partialDeepEqual: (actual, expected) => assert.ok(partialMatch(actual, expected), `partial mismatch: ${truncate(JSON.stringify(actual))}`),
	greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} is not greater than ${expected}`),
	rejects: async (operation, messageIncludes) => {
		await assert.rejects(operation, (error: Error) => String(error?.message).includes(messageIncludes));
	},
};

/** A fresh, empty, writable directory per case, removed afterwards. */
async function inTempDir(use: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-lab-conformance-"));
	try {
		await use(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const remoteConnection = localConnection();

const envs: Record<string, (use: (env: ExecutionEnv) => Promise<void>) => Promise<void>> = {
	NodeExecutionEnv: (use) => inTempDir((cwd) => use(new NodeExecutionEnv({ cwd }))),
	"RemoteExecutionEnv (pi-env daemon, local pipe)": (use) =>
		inTempDir((cwd) => use(new RemoteExecutionEnv({ connection: remoteConnection, id: "pi-env:local", cwd }))),
};

async function closeStorage(storage: Storage): Promise<void> {
	await (storage as unknown as { close?: (context: unknown) => Promise<void> }).close?.(context);
}

const storages: Record<string, (use: (storage: Storage) => Promise<void>) => Promise<void>> = {
	MemoryStorage: async (use) => {
		const storage = new MemoryStorage();
		try {
			await use(storage);
		} finally {
			await closeStorage(storage);
		}
	},
	"JSONL storage": (use) =>
		inTempDir(async (dir) => {
			const storage = await openNodeJsonlStorage(dir, context);
			try {
				await use(storage);
			} finally {
				await closeStorage(storage);
			}
		}),
	"SQLite storage": (use) =>
		inTempDir(async (dir) => {
			const storage = await openNodeSqliteStorage(join(dir, "pi.sqlite"));
			try {
				await use(storage);
			} finally {
				await closeStorage(storage);
			}
		}),
};

async function runCases(label: string, cases: readonly { name: string; timeoutMs?: number; run(): Promise<void> }[]) {
	const failed: Record<string, string> = {};
	for (const testCase of cases) {
		const limit = testCase.timeoutMs ?? 30_000;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				testCase.run(),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`timed out after ${limit} ms`)), limit);
				}),
			]);
		} catch (error) {
			failed[testCase.name] = truncate(String((error as Error)?.message ?? error).split("\n")[0], 200);
		} finally {
			clearTimeout(timer);
		}
	}
	log(`${label}: ${cases.length - Object.keys(failed).length}/${cases.length} passed`);
	return { cases: cases.length, passed: cases.length - Object.keys(failed).length, failed };
}

const envCaseNames = createEnvConformance({ assertions, withEnv: envs.NodeExecutionEnv }).map((c) => c.name);
const storageCaseNames = createStorageConformance({ assertions, withStorage: storages.MemoryStorage }).map((c) => c.name);

const envResults: Record<string, unknown> = {};
for (const [label, withEnv] of Object.entries(envs)) {
	envResults[label] = await runCases(label, createEnvConformance({ assertions, withEnv }));
}
remoteConnection.close();

const storageResults: Record<string, unknown> = {};
for (const [label, withStorage] of Object.entries(storages)) {
	storageResults[label] = await runCases(label, createStorageConformance({ assertions, withStorage }));
}

await emit({
	suites: { env: envCaseNames, storage: storageCaseNames },
	env: envResults,
	storage: storageResults,
});
