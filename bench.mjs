// Temporary benchmark: collapsed render cost vs native passthrough.
import { createJiti } from "jiti";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-fold-bench");

globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")] = new Proxy(
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

const jiti = createJiti(import.meta.url);
const factory = await jiti.import("./extensions/fold/index.ts", { default: true });
const reg = { toolRenderers: [] };
factory({
	registerToolRenderer: (r) => reg.toolRenderers.push(r),
	registerCommand: () => {},
	registerFlag: () => {},
	registerEntryRenderer: () => {},
	appendEntry: () => {},
	getFlag: () => undefined,
	on: () => {},
});

const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const resolver = reg.toolRenderers[0];
const fakeBase = {
	renderShell: undefined,
	renderCall: (args, _theme, ctx) => ctx?.lastComponent ?? new Text("read", 0, 0),
	renderResult: (result, options, _theme, ctx) => {
		const text = ctx?.lastComponent ?? new Text("", 0, 0);
		text.setText(result.content?.[0]?.text ?? "");
		return text;
	},
};

const files = {};
for (const lines of [50, 500, 2000, 10000]) {
	files[lines] = Array.from({ length: lines }, (_, i) => `const value${i} = compute(${i});`).join("\n");
}

function bench(label, fn, iterations) {
	fn();
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) fn();
	const ms = Number(process.hrtime.bigint() - start) / 1e6;
	console.log(`${label.padEnd(46)} ${(ms / iterations).toFixed(4)} ms/call`);
}

console.log("--- read result render (collapsed pi-fold vs native passthrough) ---");
for (const [lines, text] of Object.entries(files)) {
	const result = { content: [{ type: "text", text }], details: {} };
	const collapsed = resolver("read", () => fakeBase);
	const ctx = { args: { path: "src/x.ts" }, outputPad: 1, state: {}, isError: false, durationMs: 1200 };
	bench(`read ${lines} lines collapsed`, () => collapsed.renderResult(result, { expanded: false, isPartial: false }, theme, ctx).render(120), 200);
	bench(`read ${lines} lines native (expanded)`, () => {
		const child = fakeBase.renderResult(result, { expanded: true, isPartial: false }, theme, ctx);
		return child.render(120);
	}, 200);
}

console.log("\n--- bash streaming (partial) collapsed ---");
const bashResult = { content: [{ type: "text", text: files[2000] }], details: {} };
const bash = resolver("bash", () => fakeBase);
const bashCtx = { args: { command: "npm test" }, outputPad: 1, state: {}, isError: false };
bench("bash 2000 lines partial", () => bash.renderResult(bashResult, { expanded: false, isPartial: true }, theme, bashCtx).render(120), 500);
bench("bash 2000 lines final", () => bash.renderResult(bashResult, { expanded: false, isPartial: false }, theme, bashCtx).render(120), 500);
