/**
 * M2 — thinking folding.
 *
 * Pi renders a hidden thinking run as `Text(italic(thinkingText(label)))` inside a
 * `MouseRegion`, and it owns the visibility toggle (`Ctrl+T`, click). We do not
 * take that over: we only replace the text of the hidden row with a Claude
 * Code-style label, and leave the expanded `Markdown` untouched.
 *
 * Duration is measured in-process per assistant component. A run that is restored
 * from a session file never started while we were watching, so it shows `Thought`
 * without a fabricated duration.
 *
 * This is a private hook (`AssistantMessageComponent.prototype.updateContent`).
 * Everything is guarded: if the component's shape changes, decoration is skipped
 * and Pi's native thinking rendering stays in place.
 */

import { Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";

import type { FoldConfig } from "./config";
import { hostAssistantMessagePrototype } from "./host";
import { fg, italic } from "./palette";
import { installMethodPatch } from "./patch";

/** Used as the native fallback label, and shown while a run is open. */
export const THINKING_OPEN_LABEL = "✻ Thinking…";

interface ThinkingRun {
	text: string;
	/** True once something other than thinking follows the run. */
	closed: boolean;
}

interface ThinkingTiming {
	start?: number;
	end?: number;
}

const timings = new WeakMap<object, ThinkingTiming[]>();

interface PatchableAssistant {
	contentContainer?: { children?: unknown[] };
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	isStreaming?: boolean;
}

/**
 * The live config object, not a snapshot: `/yancyui thinking` mutates this same object,
 * so reading it here keeps runtime toggles effective without reinstalling the patch.
 */
let liveConfig: FoldConfig | undefined;

const diagnostics = {
	installed: false,
	updateContentCalls: 0,
	thinkingRuns: 0,
	decorated: 0,
};

/** Thinking time completed since the last {@link consumeThinkingMs} call. */
let pendingThinkingMs = 0;

export function consumeThinkingMs(): number {
	const value = pendingThinkingMs;
	pendingThinkingMs = 0;
	return value;
}

export function thinkingDiagnostics(): typeof diagnostics {
	return { ...diagnostics };
}

export function describeThinkingDiagnostics(): string {
	return `patch=${diagnostics.installed ? "yes" : "no"} updateContent=${diagnostics.updateContentCalls} runs=${diagnostics.thinkingRuns} decorated=${diagnostics.decorated}`;
}

function collectThinkingRuns(message: unknown): ThinkingRun[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];

	const runs: ThinkingRun[] = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index] as { type?: string } | undefined;
		if (block?.type !== "thinking") continue;

		const parts: string[] = [];
		while (index < content.length) {
			const next = content[index] as { type?: string; thinking?: unknown } | undefined;
			if (next?.type !== "thinking") break;
			if (typeof next.thinking === "string" && next.thinking.trim().length > 0) {
				parts.push(next.thinking.trim());
			}
			index++;
		}
		index--;

		if (parts.length === 0) continue;

		const closed = content.slice(index + 1).some((entry) => {
			const candidate = entry as { type?: string; text?: unknown } | undefined;
			if (candidate?.type === "toolCall") return true;
			return candidate?.type === "text" && typeof candidate.text === "string" && candidate.text.trim().length > 0;
		});

		runs.push({ text: parts.join("\n\n"), closed });
	}
	return runs;
}

function isThinkingRegion(value: unknown): boolean {
	if (value instanceof MouseRegion) return true;
	return !!value && typeof value === "object" && (value as { constructor?: { name?: string } }).constructor?.name === "MouseRegion";
}

function isHiddenRun(component: PatchableAssistant, index: number): boolean {
	const override = component.thinkingVisibilityOverrides?.get?.(index);
	if (override !== undefined) return override === true;
	return component.hideThinkingBlock === true;
}

function timingsFor(component: object, count: number): ThinkingTiming[] {
	let list = timings.get(component);
	if (!list) {
		list = [];
		timings.set(component, list);
	}
	while (list.length < count) list.push({});
	return list;
}

function updateTiming(entry: ThinkingTiming, isStreaming: boolean, run: ThinkingRun, now: number): void {
	if (entry.start === undefined && isStreaming) {
		// Only time runs that appeared while the message was streaming.
		entry.start = now;
	}
	if (entry.end === undefined && entry.start !== undefined && (run.closed || !isStreaming)) {
		entry.end = now;
		pendingThinkingMs += Math.max(0, entry.end - entry.start);
	}
}

function formatSeconds(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds >= 60) {
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
	}
	const rounded = Math.round(seconds * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

function labelFor(entry: ThinkingTiming): string {
	if (entry.start !== undefined && entry.end !== undefined) {
		const elapsed = entry.end - entry.start;
		// Sub-half-second runs read better without a fabricated "0s".
		if (elapsed >= 500) return `✻ Thought for ${formatSeconds(elapsed)}`;
		return "✻ Thought";
	}
	if (entry.start !== undefined) return THINKING_OPEN_LABEL;
	return "✻ Thought";
}

function decorate(instance: unknown, message: unknown): void {
	if (!liveConfig || !liveConfig.enabled || !liveConfig.thinking) return;

	const component = instance as PatchableAssistant;
	const container = component.contentContainer;
	if (!container || !Array.isArray(container.children)) return;

	const runs = collectThinkingRuns(message);
	diagnostics.thinkingRuns += runs.length;
	if (runs.length === 0) return;

	const isStreaming = component.isStreaming === true;
	const list = timingsFor(component, runs.length);
	const now = Date.now();

	let runIndex = 0;
	for (const child of [...container.children]) {
		if (!isThinkingRegion(child)) continue;
		const index = runIndex++;
		const run = runs[index];
		if (!run) break;

		const entry = list[index];
		if (!entry) continue;
		updateTiming(entry, isStreaming, run, now);

		if (!isHiddenRun(component, index)) continue;

		const inner = (child as { child?: unknown }).child;
		if (!inner || inner instanceof Markdown || typeof (inner as Text).setText !== "function") continue;
		try {
			(inner as Text).setText(italic(fg("thinkingText", labelFor(entry))));
			diagnostics.decorated++;
		} catch {
			// Fail open: the native label is already rendered.
		}
	}
}

/** Install (or reinstall) the patch. Returns an idempotent restore function. */
export function installThinkingPatch(config: FoldConfig): () => void {
	liveConfig = config;
	diagnostics.installed = false;
	const prototype = hostAssistantMessagePrototype();
	if (!prototype || typeof (prototype as { updateContent?: unknown }).updateContent !== "function") {
		return () => {};
	}
	const restore = installMethodPatch(prototype, "updateContent", (predecessor, receiver, args) => {
		diagnostics.updateContentCalls++;
		const result = predecessor.apply(receiver, args);
		try {
			decorate(receiver, args[0]);
		} catch {
			// Fail open: native content is already rendered.
		}
		return result;
	});
	diagnostics.installed = true;
	return () => {
		diagnostics.installed = false;
		restore();
	};
}

/**
 * Update the native fallback label and force every rendered assistant component to
 * run `updateContent` again, so already-rendered rows pick up a config change.
 * `setHiddenThinkingLabel` is the only public call that reaches all of them.
 */
export function refreshThinkingLabels(
	ctx: { mode?: string; ui?: { setHiddenThinkingLabel?: (label?: string) => void } },
	config: FoldConfig,
): void {
	if (ctx.mode !== "tui") return;
	const label = config.enabled && config.thinking ? THINKING_OPEN_LABEL : undefined;
	try {
		ctx.ui?.setHiddenThinkingLabel?.(label);
	} catch {
		// Cosmetic refresh only.
	}
}
