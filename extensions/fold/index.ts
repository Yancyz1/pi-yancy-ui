/**
 * pi-fold — Claude Code-style folding of Pi's thinking blocks and tool calls.
 *
 *   M1  tool rows fold to `⏺ call` + `⎿ summary`, expanded via Pi's own Ctrl+O.
 *   M2  thinking runs fold to `✻ Thinking…` / `✻ Thought for 3.2s`, expanded via
 *       Pi's own Ctrl+T.
 *
 * Load for development:
 *   pi --no-extensions -e ./extensions/fold/index.ts
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	bumpGeneration,
	describeConfig,
	loadConfig,
	saveConfig,
	setHideThinkingBlock,
	type FoldConfig,
} from "./config";
import { rememberTheme } from "./palette";
import { installThinkingPatch, describeThinkingDiagnostics, refreshThinkingLabels } from "./thinking-fold";
import { installToolFold } from "./tool-fold";
import { installTurnSummary } from "./turn-summary";

/** `/fold` options that change already-rendered tool rows. */
const TOOL_AFFECTING_OPTIONS = new Set(["", "toggle", "on", "off", "tools", "summary", "preview", "hints"]);
/** `/fold` options that change already-rendered thinking rows. */
const THINKING_AFFECTING_OPTIONS = new Set(["", "toggle", "on", "off", "thinking"]);

/**
 * Already-rendered tool rows keep the component the renderer returned last time, so a
 * config change only repaints them when Pi calls `updateDisplay()` again. Cycling the
 * global expansion state does exactly that (each `setExpanded` re-runs the renderers),
 * and we restore the user's state immediately after.
 */
function refreshToolRows(ctx: ExtensionCommandContext): void {
	if (ctx.mode !== "tui") return;
	try {
		const wasExpanded = ctx.ui.getToolsExpanded();
		ctx.ui.setToolsExpanded(!wasExpanded);
		ctx.ui.setToolsExpanded(wasExpanded);
	} catch {
		// Refreshing is cosmetic; new tool calls pick up the change regardless.
	}
}

export default function foldExtension(pi: ExtensionAPI): void {
	const config: FoldConfig = loadConfig();
	let restoreThinking = installThinkingPatch(config);

	pi.registerFlag("fold", {
		description: "Start with transcript folding enabled (overrides fold.json)",
		type: "boolean",
	});

	installToolFold(pi, config);
	installTurnSummary(pi, config);

	pi.registerCommand("fold", {
		description:
			"Fold thinking and tool output: /fold [on|off|tools|thinking|turn|summary|preview|hints|init|status]",
		handler: async (args, ctx) => {
			const option = args.trim().toLowerCase();
			let message: string;

			switch (option) {
				case "":
				case "toggle":
					config.enabled = !config.enabled;
					message = `folding ${config.enabled ? "on" : "off"}`;
					break;
				case "on":
					config.enabled = true;
					message = "folding on";
					break;
				case "off":
					config.enabled = false;
					message = "folding off";
					break;
				case "tools":
					config.tools = !config.tools;
					message = `tool folding ${config.tools ? "on" : "off"}`;
					break;
				case "thinking":
					config.thinking = !config.thinking;
					message = `thinking folding ${config.thinking ? "on" : "off"}`;
					break;
				case "turn":
					config.turnSummary = !config.turnSummary;
					message = `turn summary ${config.turnSummary ? "on" : "off"}`;
					break;
				case "summary":
					config.summary = !config.summary;
					message = `result summary ${config.summary ? "on" : "off"}`;
					break;
				case "preview":
					config.preview = !config.preview;
					message = `result preview ${config.preview ? "on" : "off"}`;
					break;
				case "hints":
					config.hints = !config.hints;
					message = `expand hints ${config.hints ? "on" : "off"}`;
					break;
				case "init": {
					const result = setHideThinkingBlock(true);
					if (!result.ok) {
						ctx.ui.notify(`fold: could not write settings: ${result.error ?? "unknown error"}`, "error");
						return;
					}
					bumpGeneration();
					saveConfig(config);
					refreshToolRows(ctx);
					refreshThinkingLabels(ctx, config);
					if (ctx.isIdle()) {
						ctx.ui.notify(`fold: hideThinkingBlock=true written to ${result.path}. Reloading…`, "info");
						await ctx.reload();
					} else {
						ctx.ui.notify(
							`fold: hideThinkingBlock=true written to ${result.path}. Run /reload or restart to apply.`,
							"info",
						);
					}
					return;
				}
				case "status":
					message = `${describeConfig(config)} | ${describeThinkingDiagnostics()}`;
					break;
				default:
					ctx.ui.notify(`fold: unknown option "${option}"`, "warning");
					return;
			}

			bumpGeneration();
			saveConfig(config);
			// Only repaint what the option actually changed: refreshing thinking walks every
			// assistant component in the transcript, which is not free.
			if (TOOL_AFFECTING_OPTIONS.has(option)) refreshToolRows(ctx);
			if (THINKING_AFFECTING_OPTIONS.has(option)) refreshThinkingLabels(ctx, config);
			ctx.ui.notify(`fold: ${message}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			const flag = pi.getFlag("fold");
			if (typeof flag === "boolean") {
				config.enabled = flag;
				bumpGeneration();
			}
			rememberTheme(ctx.ui.theme);
			if (ctx.mode === "tui" && config.enabled && config.tools) {
				ctx.ui.setToolsExpanded(false);
			}
			// Reinstall on every session: a previous session may have restored the patch
			// on shutdown, and a reload rebuilds the chat before this event fires.
			restoreThinking();
			restoreThinking = installThinkingPatch(config);
			refreshThinkingLabels(ctx, config);
		} catch {
			// Session bootstrap is best effort; defaults keep folding on.
		}
	});

	pi.on("session_shutdown", () => {
		try {
			restoreThinking();
		} catch {
			// Restoring is best effort; process exit discards the prototype anyway.
		}
		restoreThinking = () => {};
	});
}
