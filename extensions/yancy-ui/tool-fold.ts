/**
 * M1 — tool folding, Claude Code style.
 *
 *   collapsed  ->  ● <native call row>
 *                  ⎿ <summary>
 *                    <first N lines of the result>
 *                    … N more lines (ctrl+o to expand)
 *   expanded   ->  ● <native call row>
 *                  <native result row, unchanged>
 *
 * Tool execution is untouched; only rendering is replaced, and the built-in
 * result renderer is reused verbatim when expanded.
 *
 * Previews are sliced before rendering and highlighted per slice, so a 3,000 line
 * `read` costs five highlighted lines, not a full-file highlight.
 */

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { configGeneration, type YancyUiConfig } from "./config";
import { hostHighlight, hostLanguageForPath } from "./host";
import { bold, fg, keyLabel, truncateToWidth } from "./palette";
import { Row, callBaseRenderer, emptyComponent, innerOf, withInner } from "./recycle";

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type CallContext = Parameters<CallRenderer>[2];
type ResultContext = Parameters<ResultRenderer>[3];
type ResultOptions = Parameters<ResultRenderer>[1];
type Theme = Parameters<CallRenderer>[1];
type RenderResult = Parameters<ResultRenderer>[0];

export function installToolFold(pi: ExtensionAPI, config: YancyUiConfig): void {
	try {
		pi.registerToolRenderer((toolName, next) => {
			let base: ToolRenderers | undefined;
			try {
				base = next();
			} catch {
				return undefined;
			}
			if (!base) return undefined;

			const baseRenderCall = base.renderCall;
			const baseRenderResult = base.renderResult;
			if (!baseRenderCall && !baseRenderResult) return undefined;

			// `renderShell` is resolved when the tool component is constructed, so flat rows
			// are the only mode: there is no per-row shell toggle.
			const baseShell: "default" | "self" = base.renderShell === "self" ? "self" : "default";
			const renderers: ToolRenderers = { renderShell: "self" };

			/**
			 * The built-in rows relied on Pi's `Box` for horizontal padding. Rows that always
			 * rendered themselves (`edit`) already pad.
			 */
			const padFor = (context: unknown): number => padForShell(baseShell, context);

			const prefixFor = (context: CallContext | undefined): string => fg(callTone(context), "● ");

			/**
			 * Expanded rows swap the dot for a triangle so the toggle state is visible at a
			 * glance, keeping the same status colours (red failed, accent running, green done).
			 */
			const expandedTone = (context: CallContext | undefined): string => {
				if (context?.isError) return "error";
				if (context?.isPartial === true) return "accent";
				return "success";
			};
			const prefixForExpanded = (context: CallContext | undefined): string => fg(expandedTone(context), "▾ ");

			renderers.renderCall = (args: unknown, theme: Theme, context: CallContext) => {
				// Compact collapsed rows hide the native call row; the result line carries the
				// tool, its arguments, and the outcome. `expanded` is part of ToolRenderContext,
				// so the native row comes back verbatim the moment the user expands.
				if (config.enabled && config.tools && config.compact && context?.expanded === false) {
					// Compact rows indent by outputPad regardless of the tool's own shell mode,
					// so a self-padded tool (`edit`) lines up with everything else.
					return compactCallRow(toolName, args, context, padForShell("default", context));
				}
				const inner = innerOf(context?.lastComponent);
				const child = callBaseRenderer(baseRenderCall, [args, theme], context, inner);
				return new Row(child ?? callFallback(toolName, args), {
					pad: padFor(context),
					prefix: context?.expanded === true ? prefixForExpanded(context) : prefixFor(context),
					signal: configGeneration,
				});
			};

			renderers.renderResult = (
				result: RenderResult,
				options: ResultOptions,
				theme: Theme,
				context: ResultContext,
			) => {
				const folding = config.enabled && config.tools;

				// Expanded, or folding disabled: hand off to the built-in renderer untouched.
				if (!folding || options.expanded) {
					const inner = innerOf(context?.lastComponent);
					const child = callBaseRenderer(baseRenderResult, [result, options, theme], context, inner);
					return new Row(child ?? emptyComponent(), {
						pad: padFor(context),
						signal: configGeneration,
					});
				}

				// Compact mode: one `● tool args · outcome` line replaces call + summary rows.
				if (config.compact) {
					return compactResultRow(toolName, result, options, context, config, padForShell("default", context));
				}

				if (!config.summary && !config.preview) {
					return emptyComponent();
				}

				const body = buildCollapsed(toolName, result, options, context, config);
				return body.length > 0 ? new Text(body.join("\n"), padFor(context) + 2, 0) : emptyComponent();
			};

			return renderers;
		});
	} catch {
		// Tool folding is optional; a failure here must not break the extension.
	}
}

function callTone(context: CallContext | undefined): string {
	if (context?.isError) return "error";
	if (context?.executionStarted) return "accent";
	return "muted";
}

function padForShell(shell: "default" | "self", context: unknown): number {
	if (shell === "self") return 0;
	const pad = (context as { outputPad?: unknown } | undefined)?.outputPad;
	return typeof pad === "number" && Number.isFinite(pad) && pad > 0 ? Math.floor(pad) : 0;
}

// ------------------------------------------------------------- compact mode ----

/**
 * Compact mode collapses every finished tool call to a single line:
 *
 *   ● read ARCHITECTURE.md · 180 lines · 2.1s
 *   ● bash npm test · exit 1 · Command not found · 3.2s
 *
 * The leading dot doubles as the status light: accent while running, green on
 * success, red on failure. `ctrl+o` still expands to Pi's native two-row view.
 */

const COMPACT_ICON = "●";
const COMPACT_DIGEST_WIDTH = 48;

/** Set by {@link compactResultRow} once a result line has been rendered for this row. */
const HAS_RESULT = Symbol.for("pi-yancy-ui.has-result");

type CompactState = Record<PropertyKey, unknown> | undefined;

/** A short, human-readable digest of the tool arguments for the single-line title. */
function argDigest(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const raw =
		typeof record.file_path === "string"
			? record.file_path
			: typeof record.path === "string"
				? record.path
				: typeof record.command === "string"
					? record.command
					: typeof record.pattern === "string"
						? record.pattern
						: typeof record.query === "string"
							? record.query
							: typeof record.url === "string"
								? record.url
								: "";
	if (raw) return shorten(raw);
	// Unknown tools: fall back to the first non-empty string argument.
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim().length > 0) return shorten(value);
	}
	return "";
}

function shorten(value: string): string {
	const first = value
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) return "";
	// A bare path shows as its basename; anything else keeps its first line.
	const base = /[\\/]/.test(first) && !/\s/.test(first) ? (first.split(/[\\/]/).pop() ?? first) : first;
	return truncateToWidth(base, COMPACT_DIGEST_WIDTH);
}

function compactTitle(toolName: string, args: unknown): string {
	const digest = argDigest(args);
	const name = bold(fg("toolTitle", toolName));
	return digest ? `${name} ${fg("accent", digest)}` : name;
}

/**
 * The call slot in compact mode. It shows a running line only until the first
 * result render, then stands down so the result line is the single visible row.
 */
function compactCallRow(toolName: string, args: unknown, context: CallContext, pad: number): Component {
	const state = context?.state as CompactState;
	if (state && state[HAS_RESULT]) return emptyComponent();
	// Keep the built-in component reachable so a later expanded render recycles it.
	const inner = innerOf(context?.lastComponent);
	const line = `${fg("accent", COMPACT_ICON)} ${compactTitle(toolName, args)} ${fg("muted", "running…")}`;
	return withInner(new Text(line, pad, 0), inner);
}

function compactResultRow(
	toolName: string,
	result: RenderResult,
	options: ResultOptions,
	context: ResultContext,
	config: YancyUiConfig,
	pad: number,
): Component {
	const state = context?.state as CompactState;
	if (state && !state[HAS_RESULT]) {
		state[HAS_RESULT] = true;
		// The call slot rendered its running row earlier in this same updateDisplay
		// pass, before any result existed. Stand it down on the next pass; calling
		// invalidate() synchronously would re-enter Pi mid-rebuild.
		const invalidate = context?.invalidate;
		if (typeof invalidate === "function") {
			const owner = context;
			queueMicrotask(() => {
				try {
					(invalidate as () => void).call(owner);
				} catch {
					// Cosmetic only; the stale running line is harmless.
				}
			});
		}
	}

	const icon = options.isPartial
		? fg("accent", COMPACT_ICON)
		: context?.isError
			? fg("error", COMPACT_ICON)
			: fg("success", COMPACT_ICON);

	let parts: string[] = [];
	const text = contentText(result);
	const lines = splitLines(isShellTool(toolName) ? shellOutput(text) : text);
	if (config.summary) {
		parts = summarizeParts(toolName, result, context, text, lines);
	}
	// The shell branch of summarizeParts reports only the exit code; a compact row has
	// no preview beneath it, so surface the first output line as the failure reason.
	if (context?.isError && isShellTool(toolName)) {
		const reason = firstOf(lines);
		if (reason) parts.push(fg("error", truncateToWidth(reason, COMPACT_DIGEST_WIDTH)));
	}
	if (options.isPartial) {
		parts = [fg("muted", "running…")];
	}

	const separator = fg("muted", " · ");
	const body = parts.length > 0 ? `${separator}${parts.join(separator)}` : "";
	const rows = [`${icon} ${compactTitle(toolName, context?.args)}${body}`];

	// The edit diff is the payload people actually read; append a changed-lines-first
	// preview under the status line. Sliced from details.diff before colouring, so a
	// huge diff costs budget rows, not the whole file.
	if (toolName === "edit" && config.editDiff && !options.isPartial) {
		const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string" && diff.length > 0) {
			const budget = config.previewLines > 0 ? config.previewLines + 2 : 0;
			const { rows: picked, hidden } = selectDiffRows(parseDiffEntries(diff), budget);
			for (const entry of picked) {
				rows.push(`  ${colorDiffRow(entry)}`);
			}
			if (hidden > 0) {
				const hint = config.hints
					? `${fg("muted", " (")}${fg("muted", keyLabel("app.tools.expand", "ctrl+o"))}${fg("muted", " to expand)")}`
					: "";
				rows.push(`  ${fg("muted", `… ${plural(hidden, "more diff line")}`)}${hint}`);
			}
		}
	}

	return new Text(rows.join("\n"), pad, 0);
}

function callFallback(toolName: string, args: unknown): Text {
	let detail = "";
	if (args && typeof args === "object") {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim().length > 0) {
				detail = value.trim().split("\n")[0] ?? "";
				break;
			}
		}
	}
	const title = bold(fg("toolTitle", toolName));
	return new Text(detail ? `${title} ${fg("accent", detail)}` : title, 0, 0);
}

function contentText(result: RenderResult): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const parts: string[] = [];
	for (const block of content) {
		if (block && block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length === 1 ? (parts[0] ?? "") : parts.join("\n");
}

function contentHasImage(result: RenderResult): boolean {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content.some((block) => !!block && block.type === "image");
}

function splitLines(text: string): string[] {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed.length === 0 ? [] : trimmed.split("\n");
}

/** Line count without allocating the split array; a single trailing newline is ignored. */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) count++;
	}
	if (text.charCodeAt(text.length - 1) === 10) count--;
	return Math.max(0, count);
}

function firstOf(lines: string[]): string {
	const line = lines.find((entry) => entry.trim().length > 0);
	return line ? line.trim() : "";
}

function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function plural(count: number, one: string, many?: string): string {
	return `${count} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

interface TruncationLike {
	totalLines?: unknown;
	truncated?: unknown;
}

/** Pi reports "nothing found" as the result text, not as an empty list. */
function isNoMatches(text: string): boolean {
	return /^no matches found$/i.test(text.trim());
}

function isNoFiles(text: string): boolean {
	return /^no files found/i.test(text.trim());
}

function isEmptyDirectory(text: string): boolean {
	return text.trim() === "(empty directory)";
}

function isStatusText(toolName: string, text: string): boolean {
	if (toolName === "grep") return isNoMatches(text);
	if (toolName === "find") return isNoFiles(text);
	if (toolName === "ls") return isEmptyDirectory(text);
	return false;
}

/** Pi appends a status line to shell failures; it is not payload. */
const SHELL_STATUS = /\n*Command (?:exited with code \d+|timed out after .*|aborted|terminated without an exit code)\.?\s*$/i;

function isShellTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "powershell";
}

function shellOutput(text: string): string {
	return text.replace(SHELL_STATUS, "").replace(/\n+$/, "");
}

/** The styled `⎿ …` header parts for a collapsed row. */
function summarizeParts(
	toolName: string,
	result: RenderResult,
	context: ResultContext,
	text: string,
	lines: string[],
): string[] {
	const muted = (value: string) => fg("muted", value);
	const ok = (value: string) => fg("success", value);
	const bad = (value: string) => fg("error", value);
	const parts: string[] = [];

	if (isShellTool(toolName)) {
		// Pi writes "Command exited with code N" and only for failures, so the exit
		// code must be read from the original text, not the stripped payload.
		const match = text.match(/exited with code\s+(\d+)/i) ?? text.match(/exit code:?\s*(\d+)/i);
		if (match) {
			const code = Number(match[1]);
			parts.push(code === 0 ? ok("exit 0") : bad(`exit ${code}`));
		} else {
			parts.push(context.isError ? bad("failed") : ok("exit 0"));
		}
		if (lines.length > 0) parts.push(plural(lines.length, "line"));
	} else if (context.isError) {
		parts.push(bad(firstOf(lines) || "failed"));
	} else {
		switch (toolName) {
			case "read": {
				if (contentHasImage(result)) {
					parts.push("image");
					break;
				}
				const truncation = (result?.details as { truncation?: TruncationLike } | undefined)?.truncation;
				const total =
					typeof truncation?.totalLines === "number" && Number.isFinite(truncation.totalLines)
						? Math.max(0, Math.floor(truncation.totalLines))
						: lines.length;
				parts.push(plural(total, "line"));
				if (truncation?.truncated === true) parts.push(muted("truncated"));
				break;
			}
			case "write": {
				// The result text is "Successfully wrote to <path>"; the payload is the input.
				const args = context?.args as { content?: unknown } | undefined;
				const content = typeof args?.content === "string" ? args.content : "";
				parts.push(`wrote ${plural(countLines(content), "line")}`);
				break;
			}
			case "edit": {
				const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
				if (typeof diff === "string" && diff.length > 0) {
					const { added, removed } = countDiff(diff);
					parts.push(ok(`+${added}`));
					parts.push(bad(`-${removed}`));
				} else {
					parts.push("applied");
				}
				break;
			}
			case "grep":
				parts.push(isNoMatches(text) ? "no matches" : plural(lines.length, "match", "matches"));
				break;
			case "find":
				parts.push(isNoFiles(text) ? "no files" : plural(lines.length, "file"));
				break;
			case "ls":
				parts.push(isEmptyDirectory(text) ? "empty" : plural(lines.length, "entry", "entries"));
				break;
			default:
				parts.push(firstOf(lines) || "done");
				break;
		}
	}

	if (typeof context.durationMs === "number" && context.durationMs >= 1000) {
		parts.push(muted(formatDuration(context.durationMs)));
	}
	return parts;
}

interface PreviewSource {
	lines: string[];
	/** `bash` shows the tail; everything else shows the head. */
	tail: boolean;
	highlightLanguage?: string;
	/** 1-indexed first line number, for a `read` gutter. */
	startLine?: number;
}

function readPath(context: ResultContext): string | undefined {
	const args = context?.args as { file_path?: unknown; path?: unknown } | undefined;
	const value = args?.file_path ?? args?.path;
	return typeof value === "string" ? value : undefined;
}

/**
 * Tools whose call row already previews the interesting payload (`write` shows the
 * content, `edit` shows the diff) do not repeat it in the result.
 */
function previewSource(
	toolName: string,
	result: RenderResult,
	context: ResultContext,
	text: string,
	lines: string[],
): PreviewSource | undefined {
	if (toolName === "write" || toolName === "edit") return undefined;
	if (toolName === "read" && contentHasImage(result)) return undefined;
	if (isStatusText(toolName, text)) return undefined;
	if (lines.length === 0) return undefined;

	if (toolName === "bash" || toolName === "powershell") {
		return { lines, tail: true };
	}
	if (toolName === "read") {
		const args = context?.args as { offset?: unknown } | undefined;
		const offset =
			typeof args?.offset === "number" && Number.isFinite(args.offset) && args.offset > 0
				? Math.floor(args.offset)
				: 1;
		return {
			lines,
			tail: false,
			highlightLanguage: hostLanguageForPath(readPath(context) ?? ""),
			startLine: offset,
		};
	}
	return { lines, tail: false };
}

function highlight(lines: string[], language: string | undefined): string[] {
	if (language && lines.length > 0) {
		const rendered = hostHighlight(lines.join("\n"), language);
		if (rendered && rendered.length > 0) return rendered;
	}
	return lines.map((line) => fg("toolOutput", line));
}

function buildCollapsed(
	toolName: string,
	result: RenderResult,
	options: ResultOptions,
	context: ResultContext,
	config: YancyUiConfig,
): string[] {
	const separator = fg("muted", " · ");
	const headerPrefix = fg("dim", "⎿");
	const rows: string[] = [];

	// A streaming result only ever shows the running header. Skipping the text pass here
	// keeps a growing `bash` output from being re-split on every update.
	if (options.isPartial) {
		const parts = [fg("muted", "running…")];
		if (typeof context.durationMs === "number" && context.durationMs >= 1000) {
			parts.push(fg("muted", formatDuration(context.durationMs)));
		}
		rows.push(`${headerPrefix}  ${parts.join(separator)}`);
		return rows;
	}

	const text = contentText(result);
	// Shell failures carry a trailing status line; count and preview only the payload.
	const lines = splitLines(isShellTool(toolName) ? shellOutput(text) : text);

	// `summary` toggles the `⎿` row on its own; the preview can then stand alone.
	if (config.summary) {
		const parts = summarizeParts(toolName, result, context, text, lines);
		if (parts.length > 0) rows.push(`${headerPrefix}  ${parts.join(separator)}`);
	}

	// Shell failures carry the useful output, so they keep their preview.
	const previewAllowed =
		config.preview && config.previewLines > 0 && (!context.isError || isShellTool(toolName));
	if (!previewAllowed) return rows;

	const source = previewSource(toolName, result, context, text, lines);
	if (!source) return rows;

	const limit = Math.max(1, config.previewLines);
	const shown =
		source.lines.length > limit ? (source.tail ? source.lines.slice(-limit) : source.lines.slice(0, limit)) : source.lines;
	const hidden = source.lines.length - shown.length;

	// Align under the summary text, which starts two columns after `⎿`.
	const indent = "   ";
	const rendered = highlight(shown, source.highlightLanguage);
	const gutter = source.startLine !== undefined ? String(source.startLine + shown.length - 1).length : 0;
	const codeIndent = gutter > 0 ? `${indent}${" ".repeat(gutter)}  ` : indent;

	for (let index = 0; index < shown.length; index++) {
		const code = rendered[index] ?? fg("toolOutput", shown[index] ?? "");
		if (gutter > 0 && source.startLine !== undefined) {
			rows.push(`${indent}${fg("dim", String(source.startLine + index).padStart(gutter))}  ${code}`);
		} else {
			rows.push(`${indent}${code}`);
		}
	}

	if (hidden > 0) {
		const hint = config.hints
			? `${fg("muted", " (")}${fg("muted", keyLabel("app.tools.expand", "ctrl+o"))}${fg("muted", " to expand)")}`
			: "";
		const label = source.tail ? plural(hidden, "earlier line") : plural(hidden, "more line");
		rows.push(`${codeIndent}${fg("muted", `… ${label}`)}${hint}`);
	}
	return rows;
}

/**
 * Compact diff preview for `edit`: sliced from the raw diff text before any
 * colouring, changed lines (`-`/`+`) first, with one context line on each side
 * of a change. This keeps the preview meaningful even for diffs whose first
 * rendered rows would be pure context — the failure mode of slicing Pi's
 * rendered diff from the top.
 */

interface DiffEntry {
	prefix: string;
	text: string;
	changed: boolean;
}

/** Same line shape Pi's own renderDiff parses: `+123 content` / ` 123 content`. */
function parseDiffEntries(diff: string): DiffEntry[] {
	return diff.split("\n").map((line) => {
		const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
		return {
			prefix: match ? match[1] : " ",
			text: line,
			changed: !!match && (match[1] === "+" || match[1] === "-"),
		};
	});
}

function selectDiffRows(entries: DiffEntry[], budget: number): { rows: DiffEntry[]; hidden: number } {
	if (budget <= 0 || entries.length === 0) return { rows: [], hidden: entries.length };
	const changedAt = entries.map((entry, index) => (entry.changed ? index : -1)).filter((index) => index >= 0);

	// Nothing changed in this diff: show its head rather than an empty preview.
	if (changedAt.length === 0) {
		return { rows: entries.slice(0, budget), hidden: Math.max(0, entries.length - budget) };
	}

	// Seed each change with one context line on each side, then shed context rows
	// from the outside in until the selection fits the budget.
	const keep = new Set<number>();
	for (const index of changedAt) {
		keep.add(index - 1);
		keep.add(index);
		keep.add(index + 1);
	}
	let indices = [...keep].filter((i) => i >= 0 && i < entries.length).sort((a, b) => a - b);
	while (indices.length > budget) {
		const contextIndex = indices.find((i) => !entries[i]?.changed);
		if (contextIndex === undefined) break;
		indices = indices.filter((i) => i !== contextIndex);
	}
	if (indices.length > budget) indices = indices.slice(0, budget);
	return { rows: indices.map((i) => entries[i] as DiffEntry), hidden: entries.length - indices.length };
}

function colorDiffRow(entry: DiffEntry): string {
	const tone = entry.changed ? (entry.prefix === "+" ? "toolDiffAdded" : "toolDiffRemoved") : "toolDiffContext";
	return fg(tone, entry.text);
}
