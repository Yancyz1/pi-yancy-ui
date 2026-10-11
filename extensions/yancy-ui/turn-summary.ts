/**
 * M3 — turn summary.
 *
 * Pi has no hook for inserting a transcript component, and reparenting the chat
 * container is not worth the fragile surface. Instead we append a durable custom
 * entry at the end of each turn and render it with the official entry renderer:
 *
 *     ✻ Worked for 12.3s · 3 tools · thought 4.1s
 *
 * Ctrl+O expands it into one line per tool with its duration. The entry is not
 * sent to the model and does not affect the agent loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { FoldConfig } from "./config";
import { fg } from "./palette";
import { consumeThinkingMs } from "./thinking-fold";

const ENTRY_TYPE = "yancyui-turn";

interface ToolRecord {
	name: string;
	durationMs?: number;
	isError?: boolean;
}

interface TurnSummaryData {
	durationMs: number;
	thinkingMs: number;
	tools: ToolRecord[];
	/** Absent on entries written before outcomes were recorded. */
	outcome?: "completed" | "aborted" | "error";
}

export function installTurnSummary(pi: ExtensionAPI, config: FoldConfig): void {
	pi.registerEntryRenderer<TurnSummaryData>(ENTRY_TYPE, (entry, options) => {
		const data = entry.data;
		if (!data) return undefined;

		const lines = [summaryLine(data)];
		if (options.expanded) {
			for (const tool of data.tools) {
				lines.push(toolLine(tool));
			}
		}
		return new Text(lines.join("\n"), 1, 0);
	});

	let startedAt = 0;
	let active = false;
	let outcome: TurnSummaryData["outcome"] = "completed";
	let tools: ToolRecord[] = [];
	let byId = new Map<string, ToolRecord>();

	pi.on("before_agent_start", () => {
		startedAt = Date.now();
		active = true;
		outcome = "completed";
		tools = [];
		byId = new Map();
	});

	pi.on("tool_execution_start", (event) => {
		if (!active || event.parentToolCallId) return;
		const record: ToolRecord = { name: event.toolName };
		tools.push(record);
		byId.set(event.toolCallId, record);
	});

	pi.on("tool_execution_end", (event) => {
		if (!active || event.parentToolCallId) return;
		const record = byId.get(event.toolCallId);
		if (!record) return;
		record.durationMs = event.durationMs;
		record.isError = event.isError;
		byId.delete(event.toolCallId);
	});

	// `agent_end` fires once per agent loop, including auto-retry and continuation
	// loops. Record the outcome here and finalize once, at settlement.
	pi.on("agent_end", (event) => {
		if (!active) return;
		outcome = outcomeOf(event.messages);
	});

	pi.on("agent_settled", (event, ctx: ExtensionContext) => {
		// Drain the thinking accumulator even when no summary is written, so time
		// from a disabled or non-TUI run never carries into a later one.
		const thinkingMs = consumeThinkingMs();
		// `agent_settled` fires once per turn, so consuming `active` is the whole guard.
		if (!active) return;
		active = false;

		if (!config.enabled || !config.turnSummary) return;
		if (ctx.mode !== "tui") return;

		const toolList = tools.slice();
		// Nothing worth summarizing for a plain text answer.
		if (toolList.length === 0 && thinkingMs < 500) return;

		try {
			pi.appendEntry<TurnSummaryData>(ENTRY_TYPE, {
				durationMs: Math.max(0, Date.now() - startedAt),
				thinkingMs,
				tools: toolList,
				outcome: event.aborted ? "aborted" : outcome,
			});
		} catch {
			// A summary is cosmetic; never break the turn over it.
		}
	});
}

function outcomeOf(messages: unknown): TurnSummaryData["outcome"] {
	if (!Array.isArray(messages)) return "completed";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; stopReason?: string } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "error";
		return "completed";
	}
	return "completed";
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds >= 60) {
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
	}
	const rounded = Math.round(seconds * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

function summaryLine(data: TurnSummaryData): string {
	const duration = formatDuration(data.durationMs);
	const outcome = data.outcome ?? "completed";
	const parts = [
		outcome === "aborted" ? `Stopped after ${duration}` : outcome === "error" ? `Failed after ${duration}` : `Worked for ${duration}`,
	];
	if (data.tools.length > 0) {
		const failed = data.tools.filter((tool) => tool.isError).length;
		const failedSuffix = failed > 0 ? ` (${failed} failed)` : "";
		parts.push(`${data.tools.length} tool${data.tools.length === 1 ? "" : "s"}${failedSuffix}`);
	}
	if (data.thinkingMs >= 500) {
		parts.push(`thought ${formatDuration(data.thinkingMs)}`);
	}
	const tone = outcome === "error" ? "error" : outcome === "aborted" ? "warning" : "muted";
	return `${fg("dim", "✻ ")}${fg(tone, parts.join(" · "))}`;
}

function toolLine(tool: ToolRecord): string {
	const status = tool.isError ? fg("error", "✗") : fg("success", "✓");
	const duration = tool.durationMs !== undefined ? fg("muted", ` ${formatDuration(tool.durationMs)}`) : "";
	return `  ${status} ${fg("toolTitle", tool.name)}${duration}`;
}
