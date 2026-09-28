import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildInProcessChildLaunch, inheritedChildRuntime } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { runExternalJob } from "../../src/runs/shared/external-job-runner.ts";
import { resolveHerdrMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";

const envKeys = ["FEISHU_SUBAGENT_HOST_MODULE", "FEISHU_SUBAGENT_CONTEXT"] as const;

function launch(cwd: string): ChildSessionLaunch {
	return { cwd, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } };
}

function fakeSdk(): PiCodingAgentModule {
	const forbidden = () => { throw new Error("ordinary Pi discovery was reached"); };
	return {
		ModelRuntime: { create: forbidden },
		SettingsManager: { create: forbidden },
		DefaultResourceLoader: class { constructor() { forbidden(); } },
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async ({ resourceLoader }: { resourceLoader: { getSystemPrompt(): string } }) => ({
			session: {
				bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false },
				subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {},
				messages: [{ role: "user", content: resourceLoader.getSystemPrompt(), timestamp: 0 }], sessionId: "feishu-child",
			},
		}),
	} as unknown as PiCodingAgentModule;
}

describe("Feishu native child host boundary", () => {
	let root: string;
	let agentHome: string;
	let snapshotPath: string;
	let previous: (string | undefined)[];
	beforeEach(() => {
		previous = envKeys.map((key) => process.env[key]);
		root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-child-"));
		agentHome = path.join(root, ".feishu-agent");
		fs.mkdirSync(agentHome);
		snapshotPath = path.join(agentHome, "first.json");
		fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, agentHome, projectRoot: root, skills: [], systemPrompt: "FEISHU_IDENTITY", approvedDestructive: false }));
		const hostPath = path.join(root, "host.mjs");
		fs.writeFileSync(hostPath, `export async function createFeishuSubagentResources({ snapshot }) {
			return { modelRuntime: {}, settingsManager: {}, resourceLoader: {
				async reload() {},
				getExtensions() { return { runtime: {}, errors: [], extensions: [] }; },
				getSystemPrompt() { return snapshot.systemPrompt + ':' + snapshot.approvedDestructive; },
			} };
		}`);
		process.env.FEISHU_SUBAGENT_HOST_MODULE = hostPath;
		process.env.FEISHU_SUBAGENT_CONTEXT = snapshotPath;
	});
	afterEach(() => {
		envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("uses only host-owned resources and pins the original turn across a later approval", async () => {
		const nextPath = path.join(agentHome, "second.json");
		fs.writeFileSync(nextPath, JSON.stringify({ version: 1, agentHome, projectRoot: root, skills: [], systemPrompt: "LATER_TURN", approvedDestructive: true }));
		const input = launch(root);
		input.runtime.feishuContextPath = snapshotPath;
		process.env.FEISHU_SUBAGENT_CONTEXT = nextPath;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakeSdk() });
		try {
			const child = await factory.create(input);
			assert.equal(child.messages[0]?.content, "FEISHU_IDENTITY:false");
		} finally { await factory.dispose(); }
	});

	it("keeps full skills enabled and pins nested runtime without ambient extension discovery", () => {
		const first = buildInProcessChildLaunch({ cwd: root, host: "parent", sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, childAgentName: "worker", childIndex: 0, waitToolEnabled: false });
		const inherited = inheritedChildRuntime(first.config);
		process.env.FEISHU_SUBAGENT_CONTEXT = path.join(root, "nonexistent-later-turn.json");
		const nested = buildInProcessChildLaunch({ cwd: root, host: "runner", sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, childAgentName: "worker", childIndex: 0, waitToolEnabled: false, inherited });
		assert.equal(nested.session.noSkills, false);
		assert.equal(nested.config.inheritSkills, true);
		assert.equal(nested.config.feishuContextPath, snapshotPath);
		assert.equal(nested.session.ambientExtensions, false);
	});

	it("fails closed when either host context or adapter is unavailable", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakeSdk() });
		delete process.env.FEISHU_SUBAGENT_CONTEXT;
		await assert.rejects(factory.create(launch(root)), /absolute snapshot path/);
		process.env.FEISHU_SUBAGENT_CONTEXT = snapshotPath;
		delete process.env.FEISHU_SUBAGENT_HOST_MODULE;
		await assert.rejects(factory.create(launch(root)), /FEISHU_SUBAGENT_HOST_MODULE/);
	});

	it("rejects session paths outside the private home before creating directories", async () => {
		const outside = path.join(root, "outside", "sessions");
		assert.throws(() => buildInProcessChildLaunch({ cwd: root, host: "parent", sessionEnabled: true, sessionDir: outside, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, childAgentName: "worker", childIndex: 0 }), /sessions must stay inside/);
		assert.equal(fs.existsSync(outside), false);
		fs.symlinkSync(root, path.join(agentHome, "escape"), "dir");
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakeSdk() });
		await assert.rejects(factory.create({ ...launch(root), storage: { kind: "file", sessionFile: path.join(agentHome, "escape", "session.jsonl") } }), /sessions must stay inside/);
	});

	it("rejects explicit extensions from other agent directories", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakeSdk() });
		await assert.rejects(factory.create({ ...launch(root), extensionPaths: [path.join(root, ".agents", "unsafe.ts")] }), /another agent's resource directories/);
	});

	it("rejects external runners and remote placement before process or provider work", async () => {
		assert.throws(() => runExternalCli({ command: "must-not-execute", cwd: root, prompt: "task", asyncDir: path.join(root, "external"), stepIndex: 0 }), /local native Pi runner/);
		await assert.rejects(runExternalJob({ provider: "must-not-contact", cwd: root, prompt: "task", asyncDir: path.join(root, "external"), stepIndex: 0, runId: "test", agent: "worker" }), /local native Pi runner/);
		assert.throws(() => resolveHerdrMachinePlacement({ machine: "remote", cwd: root, herdrBin: "must-not-execute" }), /local native Pi runner/);
		assert.equal(fs.existsSync(path.join(root, "external")), false);
	});
});
