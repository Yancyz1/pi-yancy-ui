/**
 * Theme, key-label, and width helpers.
 *
 * Pi stores the live theme on globalThis under a well-known symbol. Reading it
 * there (with a captured fallback) keeps theme hot-reload working: a renderer
 * that captured a `Theme` at session start would keep painting the old palette.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { hostKeyText } from "./host";

export interface Palette {
	fg(role: string, text: string): string;
	bg(role: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

const THEME_KEYS: symbol[] = [
	Symbol.for("@earendil-works/pi-coding-agent:theme"),
	Symbol.for("@mariozechner/pi-coding-agent:theme"),
];

let fallbackTheme: Palette | undefined;

function isPalette(value: unknown): value is Palette {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Palette;
	return typeof candidate.fg === "function" && typeof candidate.bg === "function";
}

/** Record the theme passed to a session callback as a fallback for the global lookup. */
export function rememberTheme(theme: unknown): void {
	if (isPalette(theme)) {
		fallbackTheme = theme;
	}
}

export function liveTheme(): Palette | undefined {
	try {
		const scope = globalThis as unknown as Record<PropertyKey, unknown>;
		for (const key of THEME_KEYS) {
			const value = scope[key];
			if (isPalette(value)) return value;
		}
	} catch {
		// fall through to the captured palette
	}
	return fallbackTheme;
}

function apply(method: keyof Palette, role: string, text: string): string {
	const theme = liveTheme();
	if (!theme) return text;
	try {
		const fn = theme[method];
		return typeof fn === "function" ? (fn as (r: string, t: string) => string).call(theme, role, text) : text;
	} catch {
		return text;
	}
}

export function fg(role: string, text: string): string {
	return apply("fg", role, text);
}

export function bg(role: string, text: string): string {
	return apply("bg", role, text);
}

export function bold(text: string): string {
	const theme = liveTheme();
	if (!theme) return text;
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

export function italic(text: string): string {
	const theme = liveTheme();
	if (!theme) return text;
	try {
		return theme.italic(text);
	} catch {
		return text;
	}
}

export function safeWidth(width: unknown, fallbackWidth = 80): number {
	const value = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : fallbackWidth;
	return value > 0 ? value : fallbackWidth;
}

/** Human-readable key for a keybinding action, e.g. `ctrl+o`. */
export function keyLabel(keybinding: string, fallbackLabel: string): string {
	return hostKeyText(keybinding) ?? fallbackLabel;
}

export { truncateToWidth, visibleWidth };
