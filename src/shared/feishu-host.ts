import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const FEISHU_HOST_MODULE_ENV = "FEISHU_SUBAGENT_HOST_MODULE";
export const FEISHU_CONTEXT_ENV = "FEISHU_SUBAGENT_CONTEXT";
const boundContext = new AsyncLocalStorage<string>();
const contextCache = new Map<string, FeishuHostContext>();

export function currentFeishuContextPath(): string | undefined {
	return boundContext.getStore() ?? process.env[FEISHU_CONTEXT_ENV];
}

export function withFeishuContext<T>(contextPath: string | undefined, fn: () => T): T {
	return contextPath ? boundContext.run(contextPath, fn) : fn();
}

export interface FeishuHostContext {
	version: 1;
	agentHome: string;
	projectRoot: string;
	skills: Skill[];
	systemPrompt: string;
	approvedDestructive: boolean;
}

export function isFeishuHost(): boolean {
	return Boolean(process.env[FEISHU_HOST_MODULE_ENV] || currentFeishuContextPath());
}

function absolutePath(value: unknown): value is string {
	return typeof value === "string" && path.isAbsolute(value);
}

function isSkill(value: unknown): value is Skill {
	if (!value || typeof value !== "object") return false;
	const skill = value as Partial<Skill>;
	return typeof skill.name === "string" && Boolean(skill.name)
		&& typeof skill.description === "string"
		&& absolutePath(skill.filePath) && absolutePath(skill.baseDir)
		&& Boolean(skill.sourceInfo && typeof skill.sourceInfo === "object")
		&& typeof skill.disableModelInvocation === "boolean";
}

/** The host writes immutable launch snapshots; never fall back to Pi discovery. */
export function readFeishuContext(contextPath?: string): FeishuHostContext | undefined {
	if (contextPath === undefined && !isFeishuHost()) return undefined;
	const filePath = contextPath ?? currentFeishuContextPath();
	if (!absolutePath(filePath)) throw new Error("Feishu subagent context requires an absolute snapshot path.");
	const cached = contextCache.get(filePath);
	if (cached) return cached;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		// Snapshot contents and filesystem diagnostics may contain host data.
		throw new Error("Feishu subagent context snapshot is unavailable.");
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// Do not echo snapshot contents in parser diagnostics.
		throw new Error("Feishu subagent context snapshot is invalid.");
	}
	const context = value as Partial<FeishuHostContext> | null;
	if (!context || context.version !== 1
		|| !absolutePath(context.agentHome) || !absolutePath(context.projectRoot)
		|| !Array.isArray(context.skills) || !context.skills.every(isSkill)
		|| typeof context.systemPrompt !== "string" || typeof context.approvedDestructive !== "boolean") {
		throw new Error("Feishu subagent context snapshot is invalid.");
	}
	const validated = context as FeishuHostContext;
	contextCache.set(filePath, validated);
	if (contextCache.size > 32) contextCache.delete(contextCache.keys().next().value!);
	return validated;
}

/** Explicit paths and symlinks must not reintroduce another agent's resources. */
export function isForeignAgentResource(filePath: string): boolean {
	const forbidden = /(?:^|[\\/])\.(?:pi|agents|codex|claude)(?:[\\/]|$)/i;
	if (forbidden.test(path.resolve(filePath))) return true;
	let canonical: string;
	try {
		canonical = fs.realpathSync(filePath);
	} catch {
		// Missing resource paths have no content to load; check their lexical path.
		return false;
	}
	return forbidden.test(canonical);
}
