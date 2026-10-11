// Verify the host shim under Pi's real loader path (virtualModules), not plain
// node resolution. Uses the installed bundle's own VIRTUAL_MODULES map.
import { createJiti } from "jiti";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-fold-verify");

const chunksDir = "./node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks";
const virtualModulesFile = readdirSync(chunksDir).find(
	(name) => name.startsWith("virtual-modules-") && name.endsWith(".js"),
);
if (!virtualModulesFile) throw new Error("virtual-modules chunk not found");

const { VIRTUAL_MODULES } = await import(`${chunksDir}/${virtualModulesFile}`);
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false });

const host = await jiti.import("./extensions/fold/host.ts", { default: false });
console.log("AssistantMessageComponent prototype:", host.hostAssistantMessagePrototype() ? "yes" : "no");
console.log("getAgentDir():", host.hostAgentDir());
console.log("hostLanguageForPath(a.ts):", host.hostLanguageForPath("a.ts"));
console.log("hostHighlight lines:", host.hostHighlight("const a = 1;", "typescript")?.length ?? 0);
console.log("hostKeyText(app.tools.expand):", host.hostKeyText("app.tools.expand"));

const thinking = await jiti.import("./extensions/fold/thinking-fold.ts", { default: false });
const factory = await jiti.import("./extensions/fold/index.ts", { default: true });
factory({
	registerToolRenderer() {},
	registerCommand() {},
	registerFlag() {},
	registerEntryRenderer() {},
	appendEntry() {},
	getFlag: () => undefined,
	on() {},
});
console.log("thinking patch installed:", thinking.describeThinkingDiagnostics());
