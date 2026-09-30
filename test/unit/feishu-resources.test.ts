import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearAgentDiscoveryCache, discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearSkillCache, discoverAvailableSkills, resolveSkillsWithFallback } from "../../src/agents/skills.ts";
import { getProjectSubagentsDir } from "../../src/shared/artifacts.ts";
import { getAgentDir, getConfigDirName } from "../../src/shared/utils.ts";
import { createScheduledRunManager } from "../../src/runs/background/scheduled-runs.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAgentMemoryInjection } from "../../src/agents/agent-memory.ts";
import { getWatchdogProjectSettingsPath, resolveWatchdogConfigStrict } from "../../src/watchdog/settings.ts";

const envKeys = ["HOME", "USERPROFILE", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENT_EXTRA_AGENT_DIRS", "FEISHU_SUBAGENT_HOST_MODULE", "FEISHU_SUBAGENT_CONTEXT"] as const;
let previous: Record<string, string | undefined>;
let root: string;
let home: string;
let project: string;
let agentHome: string;
let snapshot: string;

function write(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function skill(dir: string, name: string, body: string): string {
	return write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`);
}

function agent(dir: string, name: string): void {
	write(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} description\n---\n${name} instructions`);
}

describe("Feishu resource isolation", () => {
	beforeEach(() => {
		previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-subagents-resources-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		agentHome = path.join(home, ".feishu-agent");
		fs.mkdirSync(project, { recursive: true });
		const selected = skill(path.join(project, ".feishu-agent", "skills"), "same-name", "host selected body");
		snapshot = write(path.join(agentHome, "subagents", "context.json"), JSON.stringify({
			version: 1, agentHome, projectRoot: project, systemPrompt: "Feishu identity", approvedDestructive: false,
			skills: [{ name: "same-name", description: "host selected description", filePath: selected, baseDir: path.dirname(selected), sourceInfo: { path: selected, source: "project", scope: "project", origin: "top-level" }, disableModelInvocation: false }],
		}));
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = agentHome;
		process.env.FEISHU_SUBAGENT_HOST_MODULE = path.join(root, "host.js");
		process.env.FEISHU_SUBAGENT_CONTEXT = snapshot;
		delete process.env.PI_OFFLINE;
		const npm = write(path.join(root, "bin", "npm"), `#!/bin/sh\necho invoked > '${root}/npm-invoked'\nprintf '%s\\n' '${root}/global-packages'\n`);
		fs.chmodSync(npm, 0o755);
		process.env.PATH = `${path.dirname(npm)}${path.delimiter}${previous.PATH ?? ""}`;
		clearSkillCache();
		clearAgentDiscoveryCache();
	});

	afterEach(() => {
		for (const key of envKeys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		clearSkillCache();
		clearAgentDiscoveryCache();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("uses exactly the host skill catalog, even with local overrides and a fallback cwd", () => {
		for (const dir of [path.join(home, ".agents", "skills"), path.join(project, ".agents", "skills"), path.join(project, ".pi", "skills")]) {
			skill(dir, "foreign-only", "foreign body");
			skill(dir, "same-name", "foreign shadow body");
		}
		skill(path.join(agentHome, "skills"), "unselected", "not selected by host");
		const local = path.join(project, "local-skills");
		skill(local, "same-name", "local shadow body");
		skill(local, "foreign-only", "local foreign body");
		assert.deepEqual(discoverAvailableSkills(project).map(({ name }) => name), ["same-name"]);
		const result = resolveSkillsWithFallback(["same-name", "foreign-only"], path.join(project, "child"), project, [local]);
		assert.deepEqual(result.missing, ["foreign-only"]);
		assert.equal(result.resolved[0]?.content, "host selected body");
		assert.equal(fs.existsSync(path.join(root, "npm-invoked")), false);
	});

	it("discovers private Feishu agents and builtins without legacy directories or ambient packages", () => {
		agent(path.join(agentHome, "agents"), "feishu-user");
		agent(path.join(project, ".feishu-agent", "agents"), "feishu-project");
		for (const dir of [path.join(home, ".agents"), path.join(project, ".agents"), path.join(project, ".pi", "agents")]) agent(dir, "foreign-agent");
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = path.join(home, ".agents");
		write(path.join(agentHome, "settings.json"), JSON.stringify({ subagents: { agentScanDirs: [path.join(home, ".agents")] } }));
		write(path.join(project, "package.json"), JSON.stringify({ name: "ambient", "pi-subagents": { agents: [".agents"] } }));
		for (const scope of ["both", "user", "project"] as const) {
			const result = discoverAgents(project, scope);
			assert.equal(result.agents.some(({ name }) => name === "foreign-agent"), false);
			assert.equal(result.agents.some(({ name }) => name === "delegate"), true);
			assert.equal(result.agents.some(({ name }) => name === "feishu-user"), scope !== "project");
			assert.equal(result.agents.some(({ name }) => name === "feishu-project"), scope !== "user");
		}
		const all = discoverAgentsAll(project);
		assert.equal(all.userDir, path.join(agentHome, "agents"));
		assert.equal(all.projectDir, path.join(project, ".feishu-agent", "agents"));
		assert.equal(fs.existsSync(path.join(root, "npm-invoked")), false);
	});

	it("keeps default config and project runtime state in Feishu storage", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(getConfigDirName(), ".feishu-agent");
		assert.equal(getAgentDir(), agentHome);
		const artifactDir = getProjectSubagentsDir(project);
		assert.equal(path.relative(agentHome, artifactDir).startsWith(`subagents${path.sep}projects${path.sep}`), true);
		assert.notEqual(artifactDir, getProjectSubagentsDir(path.join(root, "other-project")));
	});

	it("fails closed when the host snapshot is unavailable or malformed", () => {
		fs.rmSync(snapshot);
		assert.throws(() => discoverAvailableSkills(project), /Feishu.*context/i);
		write(snapshot, JSON.stringify({ version: 1, skills: [] }));
		assert.throws(() => discoverAvailableSkills(project), /Feishu.*context/i);
	});

	it("keeps MCP discovery inside Feishu config and ignores foreign imports", async () => {
		const { computeMcpServerHash, resolveMcpDirectToolResolution } = await import("../../src/runs/shared/mcp-direct-tool-allowlist.ts");
		const definition = { command: "fixture-mcp" };
		write(path.join(home, ".config", "mcp", "mcp.json"), JSON.stringify({ mcpServers: { generic: definition } }));
		write(path.join(home, ".claude", "mcp.json"), JSON.stringify({ mcpServers: { claude: definition } }));
		write(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { ambient: definition } }));
		write(path.join(agentHome, "mcp-adapter.json"), JSON.stringify({ imports: ["claude-code"], mcpServers: { feishu: definition } }));
		write(path.join(agentHome, "mcp-cache.json"), JSON.stringify({ version: 1, servers: Object.fromEntries(
			["generic", "claude", "ambient", "feishu"].map((name) => [name, { configHash: computeMcpServerHash(definition), tools: [{ name: "lookup" }], cachedAt: Date.now() }]),
		) }));
		const result = resolveMcpDirectToolResolution(["generic/lookup", "claude/lookup", "ambient/lookup", "feishu/lookup"], project);
		assert.deepEqual(result.selections.map(({ selector }) => selector), ["feishu/lookup"]);
		assert.deepEqual(result.unresolvedSelectors, ["generic/lookup", "claude/lookup", "ambient/lookup"]);
	});

	it("accepts private schedule storage and rejects a symlink outside Feishu home", () => {
		const context = { cwd: project, sessionManager: { getSessionId: () => "fixture", getSessionFile: () => path.join(agentHome, "sessions", "fixture.jsonl") } } as ExtensionContext;
		const createManager = () => createScheduledRunManager({
			config: { scheduledRuns: { enabled: true } },
			launch: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "management", results: [] } }),
		});
		const manager = createManager();
		assert.doesNotThrow(() => manager.bindSession(context));
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside);
		const schedules = path.join(getProjectSubagentsDir(project), "schedules");
		fs.mkdirSync(path.dirname(schedules), { recursive: true });
		fs.rmSync(schedules, { recursive: true, force: true });
		fs.symlinkSync(outside, schedules, process.platform === "win32" ? "junction" : "dir");
		manager.stop();
		const reloaded = createManager();
		assert.throws(() => reloaded.bindSession(context), /resolves outside/);
		reloaded.stop();
	});

	it("uses the host project for watchdog settings even from a nested or detached cwd", () => {
		const hostSettings = path.join(project, ".feishu-agent", "settings.json");
		write(hostSettings, JSON.stringify({ subagents: { watchdog: { stalemateRepeats: 7 } } }));
		const nested = path.join(project, "nested");
		fs.mkdirSync(path.join(nested, ".agents"), { recursive: true });
		write(path.join(nested, ".feishu-agent", "settings.json"), JSON.stringify({ subagents: { watchdog: { stalemateRepeats: 9 } } }));
		assert.equal(resolveWatchdogConfigStrict(nested).stalemateRepeats, 7);
		assert.equal(resolveWatchdogConfigStrict(path.join(root, "detached-worktree")).stalemateRepeats, 7);
		assert.equal(getWatchdogProjectSettingsPath(nested), hostSettings);
	});

	it("keeps project agent memory in private home and separates host project identities", () => {
		const role = discoverAgents(project, "both").agents.find(({ name }) => name === "delegate")!;
		role.memory = { scope: "project", path: "researcher" };
		role.tools = ["read", "write"];
		const memoryFile = path.join(getProjectSubagentsDir(project), "agent-memory", "researcher", "MEMORY.md");
		write(memoryFile, "private project recollection");
		write(path.join(project, ".feishu-agent", "agent-memory", "researcher", "MEMORY.md"), "unselected project recollection");
		const injection = buildAgentMemoryInjection(role, path.join(project, "child-worktree"));
		assert.ok(injection.includes(`Memory file: ${memoryFile}`));
		assert.ok(injection.includes("private project recollection"));
		assert.ok(!injection.includes("unselected project recollection"));
		const other = path.join(root, "other-project");
		const next = JSON.parse(fs.readFileSync(snapshot, "utf8"));
		next.projectRoot = other;
		process.env.FEISHU_SUBAGENT_CONTEXT = write(path.join(agentHome, "subagents", "other-context.json"), JSON.stringify(next));
		const otherMemoryFile = path.join(getProjectSubagentsDir(other), "agent-memory", "researcher", "MEMORY.md");
		const otherInjection = buildAgentMemoryInjection(role, other);
		assert.ok(otherInjection.includes(`Memory file: ${otherMemoryFile}`));
		assert.ok(!otherInjection.includes("private project recollection"));
		assert.notEqual(otherMemoryFile, memoryFile);
	});
});
