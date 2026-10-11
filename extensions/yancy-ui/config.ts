/**
 * yancy-ui.json configuration.
 *
 * Kept deliberately small. Every value is a boolean so a malformed file can only
 * fall back to the default, never produce an invalid state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { hostAgentDir } from "./host";

export interface YancyUiConfig {
	/** Master switch. When off, every renderer passes through to the built-in one. */
	enabled: boolean;
	/** Fold tool result bodies down to a single summary row. */
	tools: boolean;
	/** Render each collapsed tool call as one `● tool args · result` line. */
	compact: boolean;
	/** Fold thinking blocks to a single label (thinking-fold module). */
	thinking: boolean;
	/** Render the `⎿ summary` row under a collapsed tool call. */
	summary: boolean;
	/** Show a truncated preview of the result under the summary. */
	preview: boolean;
	/** Preview rows before the `… N more lines` hint. */
	previewLines: number;
	/** Append a one-line `✻ Worked for …` entry at the end of each turn. */
	turnSummary: boolean;
	/** Show the changed-lines diff preview under a compact `edit` row. */
	editDiff: boolean;
	/** Append a `ctrl+o` hint to collapsed rows that hide content. */
	hints: boolean;
}

export const DEFAULT_CONFIG: YancyUiConfig = {
	enabled: true,
	tools: true,
	compact: true,
	thinking: true,
	summary: true,
	preview: true,
	previewLines: 5,
	turnSummary: true,
	editDiff: true,
	hints: true,
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof YancyUiConfig)[];

/**
 * Bumped whenever the live config object changes. Renderers include it in their
 * memo keys so a `/fold` toggle repaints the transcript on the next render.
 */
let generation = 0;

export function configGeneration(): number {
	return generation;
}

export function bumpGeneration(): void {
	generation++;
}

export function configDir(): string {
	// Prefer Pi's own resolution: it honours `PI_CODING_AGENT_DIR` and the host's
	// config dir name, so this follows Pi across platforms and forks.
	const fromHost = hostAgentDir();
	if (fromHost) return fromHost;
	return join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(configDir(), "yancy-ui.json");
}

export function loadConfig(): YancyUiConfig {
	const config: YancyUiConfig = { ...DEFAULT_CONFIG };
	try {
		const path = configPath();
		if (!existsSync(path)) {
			return config;
		}
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object") {
			return config;
		}
		for (const key of CONFIG_KEYS) {
			const value = (raw as Record<string, unknown>)[key];
			if (key === "previewLines") {
				if (typeof value === "number" && Number.isFinite(value)) {
					config.previewLines = Math.max(0, Math.min(50, Math.floor(value)));
				}
				continue;
			}
			if (typeof value === "boolean") {
				config[key] = value;
			}
		}
	} catch {
		// A broken config must never break startup.
	}
	return config;
}

export function saveConfig(config: YancyUiConfig): void {
	try {
		const path = configPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Best effort; an unwritable config only costs persistence.
	}
}

export function describeConfig(config: YancyUiConfig): string {
	return [
		`enabled=${config.enabled}`,
		`tools=${config.tools}`,
		`compact=${config.compact}`,
		`thinking=${config.thinking}`,
		`summary=${config.summary}`,
		`preview=${config.preview}/${config.previewLines}`,
		`turn=${config.turnSummary}`,
		`editDiff=${config.editDiff}`,
		`hints=${config.hints}`,
	].join(" ");
}

export interface SettingsWriteResult {
	ok: boolean;
	path: string;
	error?: string;
}

/**
 * Write `hideThinkingBlock` into Pi's own settings file. Pi reads this once at
 * startup, so the caller must reload for it to take effect.
 */
export function setHideThinkingBlock(value: boolean): SettingsWriteResult {
	const path = join(configDir(), "settings.json");
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				data = { ...(raw as Record<string, unknown>) };
			}
		}
		data.hideThinkingBlock = value;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		return { ok: true, path };
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	}
}
