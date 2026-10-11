// Assertion-based self-test. Fails (exit 1) on any behavioural regression.
// Run: node.exe test.mjs
import { createJiti } from "jiti";
import { rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- harness ----
const tests = [];
let passed = 0;
const failures = [];
let current = "<none>";

function test(name, fn) {
	tests.push({ name, fn });
}

function fail(message) {
	throw new Error(message);
}
function assert(cond, message) {
	if (!cond) fail(message || "expected truthy");
}
function eq(actual, expected, message) {
	if (actual !== expected) {
		fail(`${message || "eq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}
function includes(haystack, needle, message) {
	if (typeof haystack !== "string" || !haystack.includes(needle)) {
		fail(`${message || "includes"}: ${JSON.stringify(needle)} not in ${JSON.stringify(haystack)}`);
	}
}
function excludes(haystack, needle, message) {
	if (typeof haystack === "string" && haystack.includes(needle)) {
		fail(`${message || "excludes"}: ${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(haystack)}`);
	}
}
function matches(haystack, re, message) {
	if (typeof haystack !== "string" || !re.test(haystack)) {
		fail(`${message || "matches"}: ${re} not in ${JSON.stringify(haystack)}`);
	}
}
function throws(fn, message) {
	try {
		fn();
	} catch {
		return;
	}
	fail(message || "expected a throw");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- fixtures ----
const agentDir = join(tmpdir(), `pi-fold-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;
rmSync(agentDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });

const identityTheme = new Proxy(
	{},
	{
		get(_t, prop) {
			if (prop === "colors") return {};
			if (prop === "appearance") return "dark";
			return (...args) => {
				const last = args[args.length - 1];
				return typeof last === "string" ? last : "";
			};
		},
	},
);
const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
globalThis[THEME_SYMBOL] = identityTheme;
globalThis[Symbol.for("@mariozechner/pi-coding-agent:theme")] = identityTheme;

const jiti = createJiti(import.meta.url);
const configMod = await jiti.import("./extensions/fold/config.ts", { default: false });
const toolFoldMod = await jiti.import("./extensions/fold/tool-fold.ts", { default: false });
const turnMod = await jiti.import("./extensions/fold/turn-summary.ts", { default: false });
const thinkingMod = await jiti.import("./extensions/fold/thinking-fold.ts", { default: false });
const recycleMod = await jiti.import("./extensions/fold/recycle.ts", { default: false });
const hostMod = await jiti.import("./extensions/fold/host.ts", { default: false });
const foldExtension = await jiti.import("./extensions/fold/index.ts", { default: true });
const piAgent = await jiti.import("@earendil-works/pi-coding-agent", { default: false });
const tui = await jiti.import("@earendil-works/pi-tui", { default: false });
const AssistantMessageComponent = piAgent.AssistantMessageComponent;
const Text = tui.Text;

const theme = identityTheme;

// ------------------------------------------------------------------ tools ----
function fakeBase(tool, shell, sink) {
	return {
		renderShell: shell,
		renderCall: (args, _theme, context) => {
			if (sink) sink.callLast = context?.lastComponent;
			const text = typeof context?.lastComponent?.setText === "function" ? context.lastComponent : new Text("", 0, 0);
			text.setText(`CALL:${tool}`);
			return text;
		},
		renderResult: (result, options, _theme, context) => {
			if (sink) sink.resultLast = context?.lastComponent;
			const text = typeof context?.lastComponent?.setText === "function" ? context.lastComponent : new Text("", 0, 0);
			text.setText(`NATIVE:${options.expanded ? "expanded" : "collapsed"}`);
			return text;
		},
	};
}

function toolSetup(overrides = {}) {
	// Classic two-line mode unless a test explicitly opts into compact mode.
	const config = { ...configMod.DEFAULT_CONFIG, compact: false, ...overrides };
	const resolvers = [];
	toolFoldMod.installToolFold({ registerToolRenderer: (r) => resolvers.push(r) }, config);
	return { config, resolvers };
}
function resolveTool(resolvers, tool, shell, sink) {
	return resolvers[0](tool, () => fakeBase(tool, shell, sink));
}
function textResult(text, details = {}) {
	return { content: [{ type: "text", text }], details };
}
function renderResultOf(resolvers, tool, options = {}) {
	const {
		args = {},
		result = textResult(""),
		shell,
		isError = false,
		durationMs,
		outputPad = 1,
		lastComponent,
		expanded = false,
		isPartial = false,
		sink,
	} = options;
	const renderers = resolveTool(resolvers, tool, shell, sink);
	const context = { args, outputPad, executionStarted: true, isError, state: {}, durationMs, lastComponent };
	return renderers.renderResult(result, { expanded, isPartial }, theme, context);
}
function flatten(component, width = 200) {
	return component.render(width).join("\n");
}
const lines = (text) => text.split("\n").filter((line) => line.trim().length > 0);

test("tool: renderShell is forced to self", () => {
	const { resolvers } = toolSetup();
	eq(resolveTool(resolvers, "read", "default").renderShell, "self");
	eq(resolveTool(resolvers, "edit", "self").renderShell, "self");
});

test("tool: a missing base renderer returns undefined", () => {
	const { resolvers } = toolSetup();
	eq(resolvers[0]("mcp__thing", () => undefined), undefined);
});

test("tool: a throwing base factor returns undefined", () => {
	const { resolvers } = toolSetup();
	eq(
		resolvers[0]("x", () => {
			throw new Error("boom");
		}),
		undefined,
	);
});

test("tool: call row is prefixed and padded for a default shell", () => {
	const { resolvers } = toolSetup();
	const renderers = resolveTool(resolvers, "read", "default");
	const row = renderers.renderCall({ path: "a" }, theme, { args: { path: "a" }, outputPad: 1 });
	const line = row.render(60)[0];
	assert(line.startsWith(" ⏺ "), `expected ' ⏺ ' prefix, got ${JSON.stringify(line)}`);
});

test("tool: a self-shell row is not double padded", () => {
	const { resolvers } = toolSetup();
	const renderers = resolveTool(resolvers, "edit", "self");
	const row = renderers.renderCall({ path: "a" }, theme, { args: { path: "a" }, outputPad: 1 });
	assert(row.render(60)[0].startsWith("⏺ "), "expected no leading pad");
});

test("tool: an expanded call row uses a triangle prefix, keeping status colours", () => {
	const { resolvers } = toolSetup();
	const renderers = resolveTool(resolvers, "read", "default");
	const base = { args: { path: "a" }, outputPad: 0, executionStarted: true };
	const expanded = renderers.renderCall({ path: "a" }, theme, { ...base, expanded: true });
	assert(expanded.render(60)[0].startsWith("▾ "), "expected a ▾ prefix when expanded");

	// Collapsed (and contexts without an expanded field) keep the dot.
	const collapsed = renderers.renderCall({ path: "a" }, theme, { ...base, expanded: false });
	assert(collapsed.render(60)[0].startsWith("⏺ "), "expected the dot while collapsed");

	// The triangle carries the status tone; the identity theme keeps the glyph only.
	const failed = renderers.renderCall({ path: "a" }, theme, { ...base, expanded: true, isError: true });
	assert(failed.render(60)[0].startsWith("▾ "), "failed expanded row keeps the triangle");
});

test("tool: the built-in always mutates its own component, never our wrapper", () => {
	const { resolvers } = toolSetup();
	const sink = {};
	const renderers = resolveTool(resolvers, "read", "default", sink);
	const first = renderers.renderCall({ path: "a" }, theme, { args: { path: "a" }, outputPad: 1 });
	assert(sink.callLast === undefined, "first call should see no lastComponent");
	const inner = recycleMod.innerOf(first);
	assert(inner, "wrapper should expose its inner component");
	const second = renderers.renderCall({ path: "a" }, theme, { args: { path: "a" }, outputPad: 1, lastComponent: first });
	assert(sink.callLast === inner, "base renderer must receive the inner component, not the wrapper");
	assert(second.inner === inner, "the inner component should be recycled");
});

test("tool: expanded results pass through to the built-in renderer", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "read", { expanded: true, result: textResult("hello") }));
	includes(out, "NATIVE:expanded");
	excludes(out, "⎿");
});

// ------------------------------------------------------------- compact mode ----

test("compact: a finished tool renders one status line, no call or summary rows", () => {
	const { resolvers } = toolSetup({ compact: true });
	const out = flatten(
		renderResultOf(resolvers, "read", {
			args: { file_path: "D:/code/pi-ext/docs/ARCHITECTURE.md" },
			result: textResult("a\nb\nc"),
			durationMs: 2100,
		}),
	);
	excludes(out, "⏺");
	excludes(out, "⎿");
	matches(out, /● read ARCHITECTURE\.md · 3 lines · 2\.1s/);
});

test("compact: failures keep a red-lit line with the outcome", () => {
	const { resolvers } = toolSetup({ compact: true });
	const out = flatten(
		renderResultOf(resolvers, "bash", {
			args: { command: "npm test" },
			result: textResult("boom\nCommand exited with code 1."),
			isError: true,
		}),
	);
	matches(out, /● bash npm test · exit 1 · 1 line · boom/);
	excludes(out, "⎿");
});

test("compact: a streaming result shows the running line", () => {
	const { resolvers } = toolSetup({ compact: true });
	const out = flatten(
		renderResultOf(resolvers, "bash", { args: { command: "x" }, result: textResult(""), isPartial: true }),
	);
	matches(out, /● bash x · running…/);
});

test("compact: the call row stands down once a result exists, and shows running before it", () => {
	const { resolvers } = toolSetup({ compact: true });
	const renderers = resolveTool(resolvers, "read", "default");
	const context = { args: { file_path: "a.md" }, outputPad: 0, executionStarted: true, isError: false, state: {} };

	// Before any result: the call slot shows the running line.
	const running = renderers.renderCall({ file_path: "a.md" }, theme, { ...context, expanded: false });
	matches(flatten(running), /● read a\.md running…/);

	// First result render flips the shared state.
	renderers.renderResult(textResult("hello"), { expanded: false, isPartial: false }, theme, context);
	assert(context.state[Symbol.for("pi-fold.has-result")], "result render must set the shared state");

	// The call slot goes quiet on the next pass.
	const quiet = renderers.renderCall({ file_path: "a.md" }, theme, { ...context, expanded: false });
	eq(flatten(quiet).trim(), "");
});

test("compact: expanding restores the native call row verbatim", () => {
	const { resolvers } = toolSetup({ compact: true });
	const renderers = resolveTool(resolvers, "read", "default");
	const context = { args: { file_path: "a.md" }, outputPad: 0, executionStarted: true, isError: false, state: {} };
	const row = renderers.renderCall({ file_path: "a.md" }, theme, { ...context, expanded: true });
	includes(flatten(row), "CALL:read");
});

test("compact: a summary-less config still shows the tool digest", () => {
	const { resolvers } = toolSetup({ compact: true, summary: false, preview: false });
	const out = flatten(renderResultOf(resolvers, "grep", { args: { pattern: "fold" }, result: textResult("x") }));
	matches(out, /● grep fold/);
	excludes(out, "⎿");
});

test("compact: edit keeps its native call row (the diff preview lives there)", () => {
	const { resolvers } = toolSetup({ compact: true });
	const renderers = resolveTool(resolvers, "edit", "self");
	const context = { args: { path: "a.ts" }, outputPad: 0, executionStarted: true, isError: false, state: {}, expanded: false };
	const row = renderers.renderCall({ path: "a.ts" }, theme, context);
	includes(flatten(row), "CALL:edit");
	// The result line is still the compact status line.
	const out = flatten(renderers.renderResult(textResult("ok", { diff: "+a\n-b" }), { expanded: false, isPartial: false }, theme, context));
	matches(out, /● edit a\.ts · \+1 · -1/);
});

test("compact: other tools still hide the call row", () => {
	const { resolvers } = toolSetup({ compact: true });
	const renderers = resolveTool(resolvers, "read", "default");
	const row = renderers.renderCall({ path: "a.md" }, theme, { args: { path: "a.md" }, state: {}, expanded: false });
	excludes(flatten(row), "CALL:read");
});

test("compact: the edit call row is capped with a hint", () => {
	const { resolvers } = toolSetup({ compact: true, previewLines: 3 });
	const multilineBase = () => ({
		renderShell: "self",
		renderCall: () => new Text(Array.from({ length: 10 }, (_, i) => `diff line ${i + 1}`).join("\n"), 0, 0),
		renderResult: () => new Text("NATIVE", 0, 0),
	});
	const renderers = resolvers[0]("edit", multilineBase);
	const out = flatten(
		renderers.renderCall({ path: "a.ts" }, theme, { args: { path: "a.ts" }, outputPad: 0, state: {}, expanded: false }),
	);
	includes(out, "diff line 3");
	excludes(out, "diff line 4");
	matches(out, /… 7 more diff lines/);

	// limit <= 0 disables the cap.
	const { resolvers: uncapped } = toolSetup({ compact: true, previewLines: 0 });
	const renderers3 = uncapped[0]("edit", multilineBase);
	const out2 = flatten(
		renderers3.renderCall({ path: "a.ts" }, theme, { args: { path: "a.ts" }, outputPad: 0, state: {}, expanded: false }),
	);
	includes(out2, "diff line 10");
});

test("tool: disabled folding passes through", () => {
	const { resolvers } = toolSetup({ enabled: false });
	includes(flatten(renderResultOf(resolvers, "read", { result: textResult("hello") })), "NATIVE:collapsed");
});

test("tool: tools=false passes through", () => {
	const { resolvers } = toolSetup({ tools: false });
	includes(flatten(renderResultOf(resolvers, "read", { result: textResult("hello") })), "NATIVE:collapsed");
});

test("tool: summary=false, preview=false renders nothing", () => {
	const { resolvers } = toolSetup({ summary: false, preview: false });
	eq(flatten(renderResultOf(resolvers, "read", { result: textResult("hello") })).trim(), "");
});

test("tool: summary=false keeps the preview without the ⎿ row", () => {
	const { resolvers } = toolSetup({ summary: false, preview: true, previewLines: 2 });
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult("alpha\nbeta\ngamma") }));
	excludes(out, "⎿");
	includes(out, "alpha");
	includes(out, "beta");
	excludes(out, "gamma");
	includes(out, "… 1 more line");
});

test("read: summary line count, preview head, and expand hint", () => {
	const { resolvers } = toolSetup();
	const text = Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n");
	const out = flatten(renderResultOf(resolvers, "read", { args: { path: "a.ts" }, result: textResult(text), durationMs: 1200 }));
	includes(out, "⎿");
	includes(out, "9 lines");
	includes(out, "1.2s");
	includes(out, "l1");
	includes(out, "l5");
	excludes(out, "l6");
	includes(out, "… 4 more lines");
	includes(out, "ctrl+o to expand");
});

test("read: the gutter starts at offset and numbers each shown line", () => {
	const { resolvers } = toolSetup();
	const out = flatten(
		renderResultOf(resolvers, "read", { args: { path: "a.ts", offset: 100 }, result: textResult("a\nb\nc") }),
	);
	matches(out, /100\s+a/, "first line should be numbered 100");
	matches(out, /101\s+b/);
	matches(out, /102\s+c/);
});

test("read: truncation details drive the count and the truncated flag", () => {
	const { resolvers } = toolSetup();
	const result = textResult("a\nb", { truncation: { totalLines: 5000, truncated: true } });
	const out = flatten(renderResultOf(resolvers, "read", { result }));
	includes(out, "5000 lines");
	includes(out, "truncated");
});

test("read: images show as an image row with no preview", () => {
	const { resolvers } = toolSetup();
	const result = { content: [{ type: "image" }, { type: "text", text: "x" }], details: {} };
	const out = flatten(renderResultOf(resolvers, "read", { result }));
	includes(out, "image");
	eq(lines(out).length, 1);
});

test("write: line count comes from the input payload", () => {
	const { resolvers } = toolSetup();
	const cases = [
		["a\nb\nc\nd", "wrote 4 lines"],
		["a", "wrote 1 line"],
		["", "wrote 0 lines"],
		["a\n", "wrote 1 line"],
		["a\n\nb", "wrote 3 lines"],
	];
	for (const [content, expected] of cases) {
		const out = flatten(
			renderResultOf(resolvers, "write", {
				args: { path: "x.ts", content },
				result: textResult("Successfully wrote to x.ts"),
			}),
		);
		includes(out, expected, `content ${JSON.stringify(content)}`);
	}
});

test("write: never repeats the payload as a preview", () => {
	const { resolvers } = toolSetup();
	const out = flatten(
		renderResultOf(resolvers, "write", {
			args: { path: "x.ts", content: "a\nb\nc\nd\ne\nf\ng" },
			result: textResult("Successfully wrote to x.ts"),
		}),
	);
	eq(lines(out).length, 1);
});

test("edit: diff stat and no duplicate preview", () => {
	const { resolvers } = toolSetup();
	const result = textResult("ok", { diff: "+++ b/x\n--- a/x\n+1\n+2\n-3" });
	const out = flatten(renderResultOf(resolvers, "edit", { result }));
	includes(out, "+2");
	includes(out, "-1");
	eq(lines(out).length, 1);
});

test("edit: no diff falls back to applied", () => {
	const { resolvers } = toolSetup();
	includes(flatten(renderResultOf(resolvers, "edit", { result: textResult("ok") })), "applied");
});

test("grep: empty, whitespace and populated results", () => {
	const { resolvers } = toolSetup();
	for (const text of ["No matches found", "No matches found\n"]) {
		const out = flatten(renderResultOf(resolvers, "grep", { result: textResult(text) }));
		includes(out, "no matches");
		eq(lines(out).length, 1, `no preview for ${JSON.stringify(text)}`);
	}
	const out = flatten(renderResultOf(resolvers, "grep", { result: textResult("m1\nm2\nm3") }));
	includes(out, "3 matches");
	includes(out, "m1");
});

test("find: empty and populated results", () => {
	const { resolvers } = toolSetup();
	const empty = flatten(renderResultOf(resolvers, "find", { result: textResult("No files found matching pattern") }));
	includes(empty, "no files");
	eq(lines(empty).length, 1);
	const populated = flatten(renderResultOf(resolvers, "find", { result: textResult("a.ts\nb.ts") }));
	includes(populated, "2 files");
});

test("ls: empty and populated results", () => {
	const { resolvers } = toolSetup();
	const empty = flatten(renderResultOf(resolvers, "ls", { result: textResult("(empty directory)") }));
	includes(empty, "empty");
	eq(lines(empty).length, 1);
	const populated = flatten(renderResultOf(resolvers, "ls", { result: textResult("a\nb\nc") }));
	includes(populated, "3 entries");
});

test("bash: success has no status line and shows exit 0", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "bash", { args: { command: "ls" }, result: textResult("1\n2\n3") }));
	includes(out, "exit 0");
	includes(out, "3 lines");
	includes(out, "1");
	includes(out, "3");
});

test("bash: failure shows the exit code and hides the status line", () => {
	const { resolvers } = toolSetup();
	const result = textResult("oops\n\nCommand exited with code 127");
	const out = flatten(renderResultOf(resolvers, "bash", { args: { command: "x" }, result, isError: true }));
	includes(out, "exit 127");
	includes(out, "1 line");
	includes(out, "oops");
	excludes(out, "Command exited");
});

test("bash: the exit status line is not counted as output", () => {
	const { resolvers } = toolSetup();
	const result = textResult("a\nb\n\nCommand exited with code 2");
	const out = flatten(renderResultOf(resolvers, "bash", { result, isError: true }));
	includes(out, "2 lines");
});

test("bash: a timeout is reported as failed", () => {
	const { resolvers } = toolSetup();
	const result = textResult("partial\n\nCommand timed out after 30s");
	const out = flatten(renderResultOf(resolvers, "bash", { result, isError: true }));
	includes(out, "failed");
	includes(out, "partial");
	excludes(out, "Command timed out");
});

test("powershell: uses the same shell handling", () => {
	const { resolvers } = toolSetup();
	const result = textResult("x\n\nCommand exited with code 5");
	const out = flatten(renderResultOf(resolvers, "powershell", { result, isError: true }));
	includes(out, "exit 5");
});

test("error: a non-shell failure shows only its first line", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult("boom\nsecond"), isError: true }));
	includes(out, "boom");
	excludes(out, "second");
	eq(lines(out).length, 1);
});

test("partial results short-circuit to a running header", () => {
	const { resolvers } = toolSetup();
	const out = flatten(
		renderResultOf(resolvers, "bash", { args: { command: "x" }, result: textResult("1\n2\n3\n4\n5"), isPartial: true }),
	);
	includes(out, "running…");
	excludes(out, "lines");
	excludes(out, "1");
	eq(lines(out).length, 1);
});

test("preview=false keeps the header only", () => {
	const { resolvers } = toolSetup({ preview: false });
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult("a\nb\nc") }));
	includes(out, "3 lines");
	excludes(out, "…");
	excludes(out, "ctrl+o");
	eq(lines(out).length, 1);
});

test("hints=false drops the expand hint but keeps the count", () => {
	const { resolvers } = toolSetup({ hints: false });
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult("a\nb\nc\nd\ne\nf\ng") }));
	includes(out, "… 2 more lines");
	excludes(out, "ctrl+o");
});

test("previewLines controls how much is shown", () => {
	const { resolvers } = toolSetup({ previewLines: 2 });
	const text = Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n");
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult(text) }));
	includes(out, "l2");
	excludes(out, "l3");
	includes(out, "… 7 more lines");
});

test("bash previews the tail, not the head", () => {
	const { resolvers } = toolSetup({ previewLines: 2 });
	const text = Array.from({ length: 8 }, (_, i) => `l${i + 1}`).join("\n");
	const out = flatten(renderResultOf(resolvers, "bash", { result: textResult(text) }));
	includes(out, "l7");
	includes(out, "l8");
	excludes(out, "l6");
	includes(out, "… 6 earlier lines");
});

test("an empty result shows the summary without a preview", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "read", { result: textResult("") }));
	includes(out, "0 lines");
	eq(lines(out).length, 1);
});

test("an unknown tool falls back to its first result line", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "custom_tool", { result: textResult("first\nsecond") }));
	includes(out, "first");
});

test("a very long single line does not break rendering", () => {
	const { resolvers } = toolSetup();
	const out = flatten(renderResultOf(resolvers, "bash", { result: textResult("x".repeat(200000)) }));
	includes(out, "1 line");
});

test("error tone: an errored call row uses the error colour", () => {
	const recorded = [];
	globalThis[THEME_SYMBOL] = {
		...identityTheme,
		fg: (role, text) => {
			recorded.push([role, text]);
			return text;
		},
		bg: (_r, t) => t,
		bold: (t) => t,
		italic: (t) => t,
	};
	try {
		const { resolvers } = toolSetup();
		const renderers = resolveTool(resolvers, "bash", "default");
		renderers.renderCall({ command: "x" }, theme, { args: { command: "x" }, outputPad: 1, isError: true });
		assert(
			recorded.some(([role, text]) => role === "error" && text.includes("⏺")),
			"expected an error-toned prefix",
		);
	} finally {
		globalThis[THEME_SYMBOL] = identityTheme;
	}
});

// -------------------------------------------------------------- thinking -----
function thinkingMessage(blocks, tail = []) {
	return {
		role: "assistant",
		content: [
			...blocks.map((thinking) => ({ type: "thinking", thinking })),
			...tail,
		],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const liveThinkingConfig = { ...configMod.DEFAULT_CONFIG };
const restoreThinking = thinkingMod.installThinkingPatch(liveThinkingConfig);
const thinkingText = (component) => component.render(60).join("\n").replace(/\x1b\][^\x07]*\x07/g, "");

test("thinking: the updateContent patch installs", () => {
	assert(thinkingMod.thinkingDiagnostics().installed, "patch should be installed");
	assert(hostMod.hostAssistantMessagePrototype(), "the host should expose AssistantMessageComponent");
});

test("thinking: a running block shows the open label", () => {
	const message = thinkingMessage(["step 1"]);
	const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, []);
	component.updateContent(message, true);
	includes(thinkingText(component), "✻ Thinking…");
});

test("thinking: a finished block shows its duration", async () => {
	thinkingMod.consumeThinkingMs();
	const open = thinkingMessage(["step 1"]);
	const closed = thinkingMessage(["step 1"], [{ type: "text", text: "Done." }]);
	const component = new AssistantMessageComponent(open, true, undefined, "Thinking...", 1, []);
	component.updateContent(open, true);
	await sleep(650);
	component.updateContent(closed, true);
	const out = thinkingText(component);
	matches(out, /✻ Thought for \d/, "expected a duration label");
	assert(thinkingMod.consumeThinkingMs() >= 500, "the elapsed time should be observable");
});

test("thinking: a restored block gets no fabricated duration", () => {
	const closed = thinkingMessage(["step 1"], [{ type: "text", text: "Done." }]);
	const component = new AssistantMessageComponent(closed, true, undefined, "Thinking...", 1, []);
	component.updateContent(closed, false);
	const out = thinkingText(component);
	includes(out, "✻ Thought");
	excludes(out, "Thought for");
});

test("thinking: thinking=false restores the native label", () => {
	liveThinkingConfig.thinking = false;
	try {
		const message = thinkingMessage(["step 1"]);
		const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, []);
		component.updateContent(message, true);
		const out = thinkingText(component);
		includes(out, "Thinking...");
		excludes(out, "✻");
	} finally {
		liveThinkingConfig.thinking = true;
	}
});

test("thinking: enabled=false restores the native label", () => {
	liveThinkingConfig.enabled = false;
	try {
		const message = thinkingMessage(["step 1"]);
		const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, []);
		component.updateContent(message, true);
		excludes(thinkingText(component), "✻");
	} finally {
		liveThinkingConfig.enabled = true;
	}
});

test("thinking: visible (unhidden) blocks are left to Pi", () => {
	const message = thinkingMessage(["step 1"]);
	const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, []);
	component.updateContent(message, false);
	excludes(thinkingText(component), "✻");
});

test("thinking: multiple runs are timed independently", () => {
	const message = {
		...thinkingMessage(["a"]),
		content: [
			{ type: "thinking", thinking: "a" },
			{ type: "text", text: "middle" },
			{ type: "thinking", thinking: "b" },
		],
	};
	const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, []);
	component.updateContent(message, false);
	const out = thinkingText(component);
	eq((out.match(/✻ Thought/g) || []).length, 2, "both runs should be labelled");
});

test("thinking: refreshThinkingLabels follows the live config", () => {
	const seen = [];
	const ctx = { mode: "tui", ui: { setHiddenThinkingLabel: (label) => seen.push(label) } };
	thinkingMod.refreshThinkingLabels(ctx, { ...liveThinkingConfig, enabled: true, thinking: true });
	thinkingMod.refreshThinkingLabels(ctx, { ...liveThinkingConfig, enabled: true, thinking: false });
	eq(seen[0], "✻ Thinking…");
	eq(seen[1], undefined);
});

test("thinking: restore returns Pi's own rendering", () => {
	const restore = thinkingMod.installThinkingPatch(liveThinkingConfig);
	restore();
	eq(thinkingMod.thinkingDiagnostics().installed, false);
	const message = thinkingMessage(["step 1"]);
	const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, []);
	component.updateContent(message, true);
	excludes(thinkingText(component), "✻");
	thinkingMod.installThinkingPatch(liveThinkingConfig);
});

// ------------------------------------------------------------ turn summary ---
function turnSetup(overrides = {}) {
	const config = { ...configMod.DEFAULT_CONFIG, ...overrides };
	const listeners = new Map();
	const entries = [];
	const renderers = [];
	const pi = {
		on: (event, handler) => {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
		},
		appendEntry: (type, data) => entries.push({ type, data }),
		registerEntryRenderer: (type, renderer) => renderers.push({ type, renderer }),
	};
	turnMod.installTurnSummary(pi, config);
	const fire = async (event, payload = {}, ctx = { mode: "tui" }) => {
		for (const handler of listeners.get(event) ?? []) await handler(payload, ctx);
	};
	return { config, entries, renderers, fire, listeners };
}

async function runTurn(setup, { tools = [], stopReason, aborted = false, mode = "tui" } = {}) {
	await setup.fire("before_agent_start");
	for (const [index, tool] of tools.entries()) {
		const id = `t${index}`;
		await setup.fire("tool_execution_start", { toolCallId: id, toolName: tool.name, parentToolCallId: tool.parent });
		await setup.fire("tool_execution_end", {
			toolCallId: id,
			toolName: tool.name,
			result: {},
			isError: !!tool.isError,
			durationMs: tool.durationMs,
		});
	}
	await setup.fire("agent_end", { messages: stopReason ? [{ role: "assistant", stopReason, content: [] }] : [] });
	await setup.fire("agent_settled", { aborted }, { mode });
}

test("turn: an entry renderer is registered", () => {
	const setup = turnSetup();
	eq(setup.renderers[0]?.type, "fold-turn");
	assert(typeof setup.renderers[0]?.renderer === "function");
});

test("turn: nothing is appended before settlement", async () => {
	const setup = turnSetup();
	await setup.fire("before_agent_start");
	await setup.fire("tool_execution_start", { toolCallId: "t1", toolName: "read" });
	await setup.fire("tool_execution_end", { toolCallId: "t1", durationMs: 10 });
	await setup.fire("agent_end", { messages: [] });
	eq(setup.entries.length, 0);
});

test("turn: a settled turn appends exactly one summary", async () => {
	const setup = turnSetup();
	await runTurn(setup, { tools: [{ name: "read", durationMs: 1200 }] });
	eq(setup.entries.length, 1);
	eq(setup.entries[0].type, "fold-turn");
	eq(setup.entries[0].data.tools.length, 1);
	eq(setup.entries[0].data.outcome, "completed");
});

test("turn: a repeated settle does not double append", async () => {
	const setup = turnSetup();
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }] });
	await setup.fire("agent_settled", { aborted: false });
	eq(setup.entries.length, 1);
});

test("turn: an aborted turn is marked as stopped", async () => {
	const setup = turnSetup();
	await runTurn(setup, { tools: [{ name: "grep", durationMs: 300 }], aborted: true });
	eq(setup.entries[0].data.outcome, "aborted");
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data: setup.entries[0].data }, { expanded: false }, theme));
	includes(out, "Stopped after");
});

test("turn: an errored assistant message is marked as failed", async () => {
	const setup = turnSetup();
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }], stopReason: "error" });
	eq(setup.entries[0].data.outcome, "error");
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data: setup.entries[0].data }, { expanded: false }, theme));
	includes(out, "Failed after");
});

test("turn: failed tools are counted", async () => {
	const setup = turnSetup();
	await runTurn(setup, {
		tools: [
			{ name: "read", durationMs: 100 },
			{ name: "bash", durationMs: 200, isError: true },
		],
	});
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data: setup.entries[0].data }, { expanded: false }, theme));
	includes(out, "2 tools (1 failed)");
});

test("turn: sub-agent tool events are ignored", async () => {
	const setup = turnSetup();
	await runTurn(setup, {
		tools: [
			{ name: "read", durationMs: 100 },
			{ name: "task", durationMs: 500, parent: "t0" },
		],
	});
	eq(setup.entries[0].data.tools.length, 1);
});

test("turn: a plain answer with no tools is not summarised", async () => {
	const setup = turnSetup();
	await runTurn(setup, {});
	eq(setup.entries.length, 0);
});

test("turn: turnSummary=false appends nothing", async () => {
	const setup = turnSetup({ turnSummary: false });
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }] });
	eq(setup.entries.length, 0);
});

test("turn: enabled=false appends nothing", async () => {
	const setup = turnSetup({ enabled: false });
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }] });
	eq(setup.entries.length, 0);
});

test("turn: a non-TUI mode appends nothing", async () => {
	const setup = turnSetup();
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }], mode: "print" });
	eq(setup.entries.length, 0);
});

test("turn: thinking time is drained even when the summary is off", async () => {
	const setup = turnSetup({ turnSummary: false });
	thinkingMod.consumeThinkingMs();
	const open = thinkingMessage(["step 1"]);
	const closed = thinkingMessage(["step 1"], [{ type: "text", text: "done" }]);
	const component = new AssistantMessageComponent(open, true, undefined, "Thinking...", 1, []);
	component.updateContent(open, true);
	await sleep(650);
	component.updateContent(closed, true);
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }] });
	eq(setup.entries.length, 0);
	eq(thinkingMod.consumeThinkingMs(), 0, "the accumulator must not leak into the next turn");
});

test("turn: thinking time reaches the summary label", async () => {
	const setup = turnSetup();
	thinkingMod.consumeThinkingMs();
	const open = thinkingMessage(["step 1"]);
	const closed = thinkingMessage(["step 1"], [{ type: "text", text: "done" }]);
	const component = new AssistantMessageComponent(open, true, undefined, "Thinking...", 1, []);
	component.updateContent(open, true);
	await sleep(650);
	component.updateContent(closed, true);
	await runTurn(setup, { tools: [{ name: "read", durationMs: 10 }] });
	eq(setup.entries.length, 1);
	assert(setup.entries[0].data.thinkingMs >= 500, "thinking time should be recorded");
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data: setup.entries[0].data }, { expanded: false }, theme));
	includes(out, "thought");
});

test("turn: expanded output lists one line per tool", async () => {
	const setup = turnSetup();
	await runTurn(setup, {
		tools: [
			{ name: "read", durationMs: 1200 },
			{ name: "bash", durationMs: 800, isError: true },
		],
	});
	const data = setup.entries[0].data;
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data }, { expanded: true }, theme));
	includes(out, "✓ read");
	includes(out, "1.2s");
	includes(out, "✗ bash");
	includes(out, "0.8s");
});

test("turn: long durations use minutes", () => {
	const setup = turnSetup();
	const data = { durationMs: 150000, thinkingMs: 0, tools: [{ name: "read", durationMs: 10 }], outcome: "completed" };
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data }, { expanded: false }, theme));
	includes(out, "Worked for 2m 30s");
});

test("turn: a single tool is not pluralised", () => {
	const setup = turnSetup();
	const data = { durationMs: 1000, thinkingMs: 0, tools: [{ name: "read", durationMs: 10 }], outcome: "completed" };
	const out = flatten(setup.renderers[0].renderer({ customType: "fold-turn", data }, { expanded: false }, theme));
	includes(out, "1 tool ");
});

test("turn: a missing payload renders nothing", () => {
	const setup = turnSetup();
	eq(setup.renderers[0].renderer({ customType: "fold-turn", data: undefined }, { expanded: false }, theme), undefined);
});

// ----------------------------------------------------------------- config ----
const configPath = configMod.configPath();

test("config: defaults when the file is missing", () => {
	rmSync(configPath, { force: true });
	const config = configMod.loadConfig();
	for (const [key, value] of Object.entries(configMod.DEFAULT_CONFIG)) {
		eq(config[key], value, `default ${key}`);
	}
});

test("config: save/load round trips", () => {
	const config = { ...configMod.DEFAULT_CONFIG, enabled: false, previewLines: 7, turnSummary: false };
	configMod.saveConfig(config);
	const loaded = configMod.loadConfig();
	eq(loaded.enabled, false);
	eq(loaded.previewLines, 7);
	eq(loaded.turnSummary, false);
});

test("config: unknown and stale keys are ignored", () => {
	writeFileSync(configPath, JSON.stringify({ enabled: false, flatRows: true, mystery: 42, previewLines: 3 }), "utf-8");
	const loaded = configMod.loadConfig();
	eq(loaded.enabled, false);
	eq(loaded.previewLines, 3);
	eq(loaded.flatRows, undefined, "flatRows was removed and must not survive");
	eq("mystery" in loaded, false);
});

test("config: previewLines is clamped and type-checked", () => {
	const cases = [
		[-5, 0],
		[999, 50],
		[3.7, 3],
		["x", 5],
		[null, 5],
	];
	for (const [input, expected] of cases) {
		writeFileSync(configPath, JSON.stringify({ previewLines: input }), "utf-8");
		eq(configMod.loadConfig().previewLines, expected, `previewLines=${JSON.stringify(input)}`);
	}
});

test("config: non-boolean switches fall back to defaults", () => {
	writeFileSync(configPath, JSON.stringify({ enabled: "yes", tools: 1, thinking: null }), "utf-8");
	const loaded = configMod.loadConfig();
	eq(loaded.enabled, true);
	eq(loaded.tools, true);
	eq(loaded.thinking, true);
});

test("config: broken JSON falls back to defaults", () => {
	writeFileSync(configPath, "{ not json", "utf-8");
	eq(configMod.loadConfig().enabled, true);
});

test("config: the directory follows PI_CODING_AGENT_DIR", () => {
	eq(configMod.configDir(), agentDir);
	eq(configMod.configPath(), join(agentDir, "fold.json"));
});

test("config: describeConfig reports every switch", () => {
	const description = configMod.describeConfig(configMod.DEFAULT_CONFIG);
	for (const key of ["enabled", "tools", "thinking", "summary", "preview", "turn", "hints"]) {
		includes(description, `${key}=`);
	}
});

test("config: the generation counter advances", () => {
	const before = configMod.configGeneration();
	configMod.bumpGeneration();
	eq(configMod.configGeneration(), before + 1);
});

test("config: setHideThinkingBlock preserves other settings", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf-8");
	const result = configMod.setHideThinkingBlock(true);
	assert(result.ok, "write should succeed");
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
	eq(settings.hideThinkingBlock, true);
	eq(settings.theme, "dark");
});

// ------------------------------------------------------------ integration ----
function factorySetup() {
	const registered = { toolRenderers: [], commands: [], flags: [], events: [], entryRenderers: [] };
	let flag;
	const pi = {
		registerToolRenderer: (r) => registered.toolRenderers.push(r),
		registerCommand: (name, opts) => registered.commands.push({ name, opts }),
		registerFlag: (name, opts) => registered.flags.push({ name, opts }),
		registerEntryRenderer: (type, renderer) => registered.entryRenderers.push({ type, renderer }),
		appendEntry: () => {},
		getFlag: () => flag,
		on: (event, handler) => registered.events.push({ event, handler }),
	};
	return { pi, registered, setFlag: (value) => (flag = value) };
}

function commandCtx(options = {}) {
	const calls = { notify: [], setToolsExpanded: [], setHiddenThinkingLabel: [], reload: 0 };
	const ctx = {
		mode: options.mode ?? "tui",
		isIdle: () => options.idle ?? true,
		ui: {
			theme,
			notify: (message, tone) => calls.notify.push({ message, tone }),
			getToolsExpanded: () => options.expanded ?? false,
			setToolsExpanded: (value) => calls.setToolsExpanded.push(value),
			setHiddenThinkingLabel: (label) => calls.setHiddenThinkingLabel.push(label),
		},
		reload: async () => {
			calls.reload++;
		},
	};
	return { ctx, calls };
}

test("integration: the factory registers its surface", () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	eq(registered.toolRenderers.length, 1);
	eq(registered.commands.filter((c) => c.name === "fold").length, 1);
	eq(registered.flags.filter((f) => f.name === "fold").length, 1);
	eq(registered.entryRenderers.filter((e) => e.type === "fold-turn").length, 1);
	const events = new Set(registered.events.map((e) => e.event));
	for (const event of ["before_agent_start", "tool_execution_start", "tool_execution_end", "agent_end", "agent_settled", "session_start", "session_shutdown"]) {
		assert(events.has(event), `missing event ${event}`);
	}
	eq(registered.events.filter((e) => e.event === "agent_settled").length, 1, "the summary must settle once");
});

test("integration: /fold status reports the live config", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx();
	await command.opts.handler("status", ctx);
	includes(calls.notify.at(-1).message, "enabled=");
	includes(calls.notify.at(-1).message, "patch=");
});

test("integration: /fold toggle flips and persists", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx();
	await command.opts.handler("", ctx);
	eq(calls.notify.at(-1).message, "fold: folding off");
	eq(configMod.loadConfig().enabled, false);
	await command.opts.handler("on", ctx);
	eq(configMod.loadConfig().enabled, true);
});

test("integration: an unknown option warns and saves nothing", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx();
	await command.opts.handler("bogus", ctx);
	eq(calls.notify.at(-1).tone, "warning");
	eq(existsSync(configPath), false);
});

test("integration: tool options refresh tool rows, others do not", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");

	const toolRun = commandCtx();
	await command.opts.handler("tools", toolRun.ctx);
	eq(toolRun.calls.setToolsExpanded.length, 2, "a tool option cycles the expansion state");

	const turnRun = commandCtx();
	await command.opts.handler("turn", turnRun.ctx);
	eq(turnRun.calls.setToolsExpanded.length, 0, "a turn option must not repaint tool rows");
	eq(turnRun.calls.setHiddenThinkingLabel.length, 0, "a turn option must not repaint thinking");
});

test("integration: thinking options refresh thinking labels", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx();
	await command.opts.handler("thinking", ctx);
	eq(calls.setHiddenThinkingLabel.length, 1);
	eq(calls.setHiddenThinkingLabel[0], undefined, "thinking is now off, so the native label returns");
});

test("integration: /fold init writes settings and reloads when idle", async () => {
	rmSync(configPath, { force: true });
	rmSync(join(agentDir, "settings.json"), { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx({ idle: true });
	await command.opts.handler("init", ctx);
	eq(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).hideThinkingBlock, true);
	eq(calls.reload, 1);
});

test("integration: /fold init defers the reload while busy", async () => {
	rmSync(join(agentDir, "settings.json"), { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx({ idle: false });
	await command.opts.handler("init", ctx);
	eq(calls.reload, 0);
	includes(calls.notify.at(-1).message, "reload");
});

test("integration: a non-TUI command never touches the UI", async () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const command = registered.commands.find((c) => c.name === "fold");
	const { ctx, calls } = commandCtx({ mode: "print" });
	await command.opts.handler("tools", ctx);
	eq(calls.setToolsExpanded.length, 0);
	eq(calls.setHiddenThinkingLabel.length, 0);
});

test("integration: session_start honours the --fold flag", () => {
	rmSync(configPath, { force: true });
	const { pi, registered, setFlag } = factorySetup();
	foldExtension(pi);
	setFlag(false);
	const { ctx, calls } = commandCtx();
	for (const handler of registered.events.filter((e) => e.event === "session_start")) handler.handler({}, ctx);
	eq(calls.setToolsExpanded.length, 0, "folding is off, so tool rows are untouched");
});

test("integration: session_start collapses tool rows when folding is on", () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	const { ctx, calls } = commandCtx();
	for (const handler of registered.events.filter((e) => e.event === "session_start")) handler.handler({}, ctx);
	eq(calls.setToolsExpanded.at(-1), false);
});

test("integration: session_shutdown restores the thinking patch", () => {
	rmSync(configPath, { force: true });
	const { pi, registered } = factorySetup();
	foldExtension(pi);
	for (const handler of registered.events.filter((e) => e.event === "session_start")) handler.handler({}, commandCtx().ctx);
	assert(thinkingMod.thinkingDiagnostics().installed, "patch should be installed after start");
	for (const handler of registered.events.filter((e) => e.event === "session_shutdown")) handler.handler({}, {});
	eq(thinkingMod.thinkingDiagnostics().installed, false);
	thinkingMod.installThinkingPatch(liveThinkingConfig);
});

// -------------------------------------------------------------------- run ----
for (const { name, fn } of tests) {
	current = name;
	try {
		await fn();
		passed++;
		process.stdout.write(".");
	} catch (error) {
		failures.push({ name, error });
		process.stdout.write("x");
	}
}

process.stdout.write("\n");
for (const { name, error } of failures) {
	process.stdout.write(`\nFAIL ${name}\n  ${error?.message ?? error}\n`);
}
process.stdout.write(`\n${passed}/${tests.length} passed\n`);
if (failures.length > 0) process.exit(1);
