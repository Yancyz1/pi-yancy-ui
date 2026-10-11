/**
 * Compatibility shim for the host package.
 *
 * Pi loads extensions through jiti, and a missing named export usually becomes
 * `undefined` rather than a link error. A namespace import plus runtime reads makes
 * that explicit and keeps one missing export from taking the whole extension down
 * (for example `AssistantMessageComponent`, which has left the public entrypoints
 * before). Everything here fails soft.
 */

import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

interface HostApi {
	keyText?: (keybinding: string) => unknown;
	getLanguageFromPath?: (filePath: string) => unknown;
	highlightCode?: (code: string, language?: string) => unknown;
	getAgentDir?: () => unknown;
	AssistantMessageComponent?: { prototype?: unknown };
}

const host = PiCodingAgent as unknown as HostApi;

/** Human-readable key for a keybinding action, e.g. `ctrl+o`. */
export function hostKeyText(keybinding: string): string | undefined {
	try {
		const fn = host.keyText;
		if (typeof fn !== "function") return undefined;
		const value = fn(keybinding);
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function hostLanguageForPath(filePath: string): string | undefined {
	try {
		const fn = host.getLanguageFromPath;
		if (typeof fn !== "function") return undefined;
		const value = fn(filePath);
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export function hostHighlight(code: string, language: string | undefined): string[] | undefined {
	try {
		const fn = host.highlightCode;
		if (typeof fn !== "function") return undefined;
		const value = fn(code, language);
		return Array.isArray(value) && value.every((line) => typeof line === "string")
			? (value as string[])
			: undefined;
	} catch {
		return undefined;
	}
}

/** Pi's own agent config directory; respects the host's env override. */
export function hostAgentDir(): string | undefined {
	try {
		const fn = host.getAgentDir;
		if (typeof fn !== "function") return undefined;
		const value = fn();
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The assistant message renderer's prototype, when the host still exports it. */
export function hostAssistantMessagePrototype(): object | undefined {
	try {
		const prototype = host.AssistantMessageComponent?.prototype;
		return prototype && typeof prototype === "object" ? prototype : undefined;
	} catch {
		return undefined;
	}
}
