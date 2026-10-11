/**
 * Built-in tool renderers recycle the component the host hands them:
 *
 *     const text = context.lastComponent ?? new Text("", 0, 0);
 *     text.setText(...);
 *     return text;
 *
 * If we returned our own wrapper as `lastComponent`, the built-in would call
 * `wrapper.setText(...)` / `wrapper.clear()` on the next refresh and throw. Pi
 * catches that, falls back to its raw preview, and the row flips between our
 * layout and the fallback every frame.
 *
 * The fix: every wrapper we hand back remembers the component the built-in owns
 * under {@link INNER}, and the next call passes that component back through a
 * rebound `lastComponent`, so the built-in always mutates its own object.
 */

import { Text, type Component } from "@earendil-works/pi-tui";

import { safeWidth, truncateToWidth, visibleWidth } from "./palette";

const INNER = Symbol.for("pi-fold.inner");

export function isComponent(value: unknown): value is Component {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Component>;
	return typeof candidate.render === "function" && typeof candidate.invalidate === "function";
}

/** The component a wrapper owns, or undefined when the value is not one of ours. */
export function innerOf(value: unknown): Component | undefined {
	if (!value || typeof value !== "object") return undefined;
	const inner = (value as Record<PropertyKey, unknown>)[INNER];
	return isComponent(inner) ? inner : undefined;
}

function tag(wrapper: object, inner: Component | undefined): void {
	try {
		Object.defineProperty(wrapper, INNER, {
			value: inner,
			configurable: true,
			enumerable: false,
		});
	} catch {
		// A frozen component still renders; only transparent recycling is lost.
	}
}

/**
 * Attach a built-in component to one of our plain wrappers (e.g. a compact single-line
 * `Text`) so a later expanded render can recycle it via {@link innerOf}.
 */
export function withInner(wrapper: Component, inner: Component | undefined): Component {
	tag(wrapper, inner);
	return wrapper;
}

/**
 * Call a built-in renderer with the component it expects. Retries once without a
 * `lastComponent` so a stale or foreign component can never cost the user a row.
 */
export function callBaseRenderer(
	renderer: ((...args: never[]) => unknown) | undefined,
	rendererArgs: unknown[],
	context: unknown,
	inner: Component | undefined,
): Component | undefined {
	if (typeof renderer !== "function") return undefined;
	const base = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
	try {
		const result = (renderer as (...args: unknown[]) => unknown)(...rendererArgs, { ...base, lastComponent: inner });
		return isComponent(result) ? result : undefined;
	} catch {
		try {
			const result = (renderer as (...args: unknown[]) => unknown)(...rendererArgs, {
				...base,
				lastComponent: undefined,
			});
			return isComponent(result) ? result : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Wraps a built-in component to add left padding and an optional one-line prefix
 * (`● `). Memoized by width and `signal`; a memo hit never re-renders the child.
 */
export class Row implements Component {
	readonly inner: Component;
	private readonly pad: number;
	private readonly prefix: string;
	private readonly signal: (() => number) | undefined;
	private memo: { width: number; signal: number; lines: string[] } | undefined;

	constructor(inner: Component, options: { pad?: number; prefix?: string; signal?: () => number } = {}) {
		this.inner = inner;
		this.pad = Math.max(0, Math.floor(options.pad ?? 0));
		this.prefix = options.prefix ?? "";
		this.signal = options.signal;
		tag(this, inner);
	}

	invalidate(): void {
		this.memo = undefined;
		try {
			this.inner.invalidate();
		} catch {
			// A child that cannot invalidate is still rendered from its own state.
		}
	}

	render(width: number): string[] {
		const safe = safeWidth(width);
		const signal = this.signal ? this.signal() : 0;
		if (this.memo && this.memo.width === safe && this.memo.signal === signal) {
			return [...this.memo.lines];
		}

		const prefixWidth = this.prefix ? visibleWidth(this.prefix) : 0;
		const innerWidth = Math.max(1, safe - this.pad - prefixWidth);
		let body: string[] = [];
		try {
			const rendered = this.inner.render(innerWidth);
			if (Array.isArray(rendered)) body = rendered;
		} catch {
			body = [];
		}

		const lines = body.map((line, index) => {
			const lead = " ".repeat(this.pad) + (index === 0 && prefixWidth > 0 ? this.prefix : " ".repeat(prefixWidth));
			return truncateToWidth(lead + String(line), safe);
		});

		this.memo = { width: safe, signal, lines };
		return [...lines];
	}
}

/** A safe empty component; renderers must never return `undefined`. */
export function emptyComponent(): Component {
	return new Text("", 0, 0);
}
