// Smoke test: load the extension without Pi and drive its renderers.
// Run: node.exe smoke.mjs
import { createJiti } from "jiti";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";

// Keep the smoke test from touching the real agent config dir. Pi's own override
// is PI_CODING_AGENT_DIR (read by getAgentDir()).
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-fold-smoke");

// Pi initializes the theme when the TUI starts. AssistantMessageComponent reads it
// through a globalThis proxy, so install an identity theme for this headless test.
const identityTheme = new Proxy(
	{},
	{
		get(_target, prop) {
			if (prop === "colors") return {};
			if (prop === "appearance") return "dark";
			return (...args) => {
				const last = args[args.length - 1];
				return typeof last === "string" ? last : "";
			};
		},
	},
);
globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")] = identityTheme;
globalThis[Symbol.for("@mariozechner/pi-coding-agent:theme")] = identityTheme;

const jiti = createJiti(import.meta.url);
const factory = await jiti.import("./extensions/fold/index.ts", { default: true });

const reg = { toolRenderers: [], commands: [], flags: [], events: [], entryRenderers: [], entries: [] };
const pi = {
	registerToolRenderer: (r) => reg.toolRenderers.push(r),
	registerCommand: (name, opts) => reg.commands.push({ name, opts }),
	registerFlag: (name, opts) => reg.flags.push({ name, opts }),
	registerEntryRenderer: (type, renderer) => reg.entryRenderers.push({ type, renderer }),
	appendEntry: (type, data) => reg.entries.push({ type, data }),
	getFlag: () => undefined,
	on: (event, handler) => reg.events.push({ event, handler }),
};

factory(pi);
console.log("registered toolRenderers:", reg.toolRenderers.length);
console.log("registered commands:", reg.commands.map((c) => c.name).join(", "));
console.log("registered flags:", reg.flags.map((f) => f.name).join(", "));
console.log("registered events:", reg.events.map((e) => e.event).join(", "));

const theme = { fg: (_r, t) => t, bg: (_r, t) => t, bold: (t) => t, italic: (t) => t };

function fakeBase(toolName) {
	return {
		renderShell: toolName === "edit" ? "self" : undefined,
		renderCall: (args, _theme, ctx) => {
			const text = ctx?.lastComponent ?? new Text("", 0, 0);
			text.setText(`${toolName} ${JSON.stringify(args)}`);
			return text;
		},
		renderResult: (result, options, _theme, ctx) => {
			const text = ctx?.lastComponent ?? new Text("", 0, 0);
			text.setText(`RESULT(${options.expanded ? "expanded" : "collapsed"}): ${result.content?.[0]?.text ?? ""}`);
			return text;
		},
	};
}

const resolver = reg.toolRenderers[0];
const cases = [
	[
		"read",
		{ path: "src/x.ts" },
		{ content: [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9" }], details: {} },
	],
	["edit", { path: "src/x.ts" }, { content: [{ type: "text", text: "ok" }], details: { diff: "+1\n+2\n-3" } }],
	[
		"bash",
		{ command: "npm test" },
		{
			content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7\nexit code: 1" }],
			details: {},
		},
	],
	["grep", { pattern: "x" }, { content: [{ type: "text", text: "m1\nm2\nm3" }], details: {} }],
];

for (const [tool, args, result] of cases) {
	const renderers = resolver(tool, () => fakeBase(tool));
	const callCtx = { args, outputPad: 1, executionStarted: true, isError: false, state: {} };
	const call = renderers.renderCall(args, theme, callCtx);
	const collapsed = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, {
		...callCtx,
		isError: false,
		durationMs: 1200,
	});
	const expanded = renderers.renderResult(result, { expanded: true, isPartial: false }, theme, {
		...callCtx,
		isError: false,
		durationMs: 1200,
	});
	const w = 70;
	console.log(`\n--- ${tool} shell=${renderers.renderShell} ---`);
	console.log(call.render(w).join("\n"));
	console.log(collapsed.render(w).join("\n"));
	console.log(expanded.render(w).join("\n"));
}

// Error path
const errorRenderers = resolver("bash", () => fakeBase("bash"));
console.log("\n--- bash error ---");
console.log(
	errorRenderers
		.renderResult({ content: [{ type: "text", text: "boom: command not found" }], details: {} }, { expanded: false, isPartial: false }, theme, {
			...{ args: {}, outputPad: 1 },
			isError: true,
		})
		.render(70)
		.join("\n"),
);

// Missing-base path must return undefined (Pi's own fallback handles it).
console.log("\nmissing base ->", resolver("mcp__thing", () => undefined));

console.log("\n# P0 regression checks");
const check = (label, tool, args, result, isError = false) => {
	const renderers = resolver(tool, () => fakeBase(tool));
	const ctx = { args, outputPad: 1, executionStarted: true, isError, state: {} };
	const out = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx).render(80).join("\n");
	console.log(`--- ${label} ---`);
	console.log(out.trimEnd());
};
check("write 4 lines", "write", { path: "src/x.ts", content: "a\nb\nc\nd" }, {
	content: [{ type: "text", text: "Successfully wrote to src/x.ts" }],
	details: {},
});
check("grep no matches", "grep", { pattern: "zzz" }, {
	content: [{ type: "text", text: "No matches found" }],
	details: {},
});
check("find no files", "find", { pattern: "*.zzz" }, {
	content: [{ type: "text", text: "No files found matching pattern" }],
	details: {},
});
check("ls empty", "ls", { path: "." }, {
	content: [{ type: "text", text: "(empty directory)" }],
	details: {},
});
check("bash exit 127", "bash", { command: "false" }, {
	content: [{ type: "text", text: "oops\n\nCommand exited with code 127" }],
	details: {},
}, true);

// --- M2: thinking folding -------------------------------------------------
// The factory above already installed the updateContent patch.
const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");

const baseMessage = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "step 1\nstep 2\nstep 3" }],
	api: "test",
	provider: "test",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: Date.now(),
};

const thinking = new AssistantMessageComponent(baseMessage, true, undefined, "Thinking...", 1, []);
thinking.updateContent(baseMessage, true);
console.log("\n--- thinking (open, streaming) ---");
console.log(thinking.render(60).join("\n"));

const closedMessage = {
	...baseMessage,
	content: [{ type: "thinking", thinking: "step 1\nstep 2\nstep 3" }, { type: "text", text: "Done." }],
};
thinking.updateContent(closedMessage, true);
thinking.updateContent(closedMessage, false);
console.log("\n--- thinking (closed) ---");
console.log(thinking.render(60).join("\n"));

thinking.setHideThinkingBlock(false);
console.log("\n--- thinking (expanded, native markdown) ---");
console.log(thinking.render(60).join("\n"));

// A restored message never started while we watched: no fabricated duration.
const restored = new AssistantMessageComponent(closedMessage, true, undefined, "Thinking...", 1, []);
restored.updateContent(closedMessage, false);
console.log("\n--- thinking (restored) ---");
console.log(restored.render(60).join("\n"));

// Runtime toggle: mutating the live config must change the rendered label.
const { installThinkingPatch } = await jiti.import("./extensions/fold/thinking-fold.ts");
const liveConfig = { enabled: true, tools: true, thinking: true, preview: true, previewLines: 5, summary: true, turnSummary: true, hints: true };
const restoreToggle = installThinkingPatch(liveConfig);
const toggle = new AssistantMessageComponent(baseMessage, true, undefined, "Thinking...", 1, []);
toggle.updateContent(baseMessage, true);
console.log("\n--- toggle thinking=true ---");
console.log(toggle.render(60).join("\n").replace(/\x1b\][^\x07]*\x07/g, ""));
liveConfig.thinking = false;
toggle.updateContent(baseMessage, true);
console.log("--- toggle thinking=false (native label) ---");
console.log(toggle.render(60).join("\n").replace(/\x1b\][^\x07]*\x07/g, ""));
liveConfig.thinking = true;
toggle.updateContent(baseMessage, true);
console.log("--- toggle thinking=true again ---");
console.log(toggle.render(60).join("\n").replace(/\x1b\][^\x07]*\x07/g, ""));
restoreToggle();

// /fold status wires config + diagnostics together.
const folderCommand = reg.commands.find((entry) => entry.name === "fold");
await folderCommand.opts.handler("status", {
	mode: "tui",
	isIdle: () => true,
	ui: {
		notify: (message) => console.log("\n/fold status ->", message),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		setHiddenThinkingLabel: () => {},
	},
});

// --- M3: turn summary -----------------------------------------------------
const runEvent = async (name, event = {}) => {
	for (const handler of reg.events.filter((entry) => entry.event === name)) {
		await handler.handler(event, { mode: "tui" });
	}
};

await runEvent("before_agent_start");
await runEvent("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
await runEvent("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "t1",
	toolName: "read",
	result: {},
	isError: false,
	durationMs: 1200,
});
await runEvent("tool_execution_start", { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
await runEvent("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "t2",
	toolName: "bash",
	result: {},
	isError: true,
	durationMs: 800,
});
await runEvent("agent_end", { type: "agent_end", messages: [] });
await runEvent("agent_settled", { type: "agent_settled", aborted: false });

// A second, aborted run.
await runEvent("before_agent_start");
await runEvent("tool_execution_start", { type: "tool_execution_start", toolCallId: "t3", toolName: "grep", args: {} });
await runEvent("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "t3",
	toolName: "grep",
	result: {},
	isError: false,
	durationMs: 300,
});
await runEvent("agent_end", {
	type: "agent_end",
	messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
});
await runEvent("agent_settled", { type: "agent_settled", aborted: true });

console.log("\nappended entries:", JSON.stringify(reg.entries));
const turnRenderer = reg.entryRenderers.find((entry) => entry.type === "fold-turn")?.renderer;
if (turnRenderer && reg.entries[0]) {
	for (const [index, appended] of reg.entries.entries()) {
		const entry = { customType: "fold-turn", data: appended.data };
		console.log(`--- turn summary #${index} (collapsed) ---`);
		console.log(turnRenderer(entry, { expanded: false }, identityTheme).render(60).join("\n"));
		console.log(`--- turn summary #${index} (expanded) ---`);
		console.log(turnRenderer(entry, { expanded: true }, identityTheme).render(60).join("\n"));
	}
}
