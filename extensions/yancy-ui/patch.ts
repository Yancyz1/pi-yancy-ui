/**
 * Minimal, idempotent prototype patching.
 *
 * Pi has no public renderer hook for assistant messages, so thinking folding has
 * to wrap `AssistantMessageComponent.prototype.updateContent`. This keeps that
 * safe:
 *
 *   - the registry lives on the prototype under a well-known symbol, keyed by
 *     method name, so a reloaded extension reuses the true predecessor instead of
 *     stacking wrappers;
 *   - a displaced owner is notified, and a wrapper that is no longer current
 *     forwards to the predecessor;
 *   - `restore()` puts the exact original property descriptor back.
 */

const REGISTRY = Symbol.for("pi-yancy-ui.prototype-patches");

type AnyFunction = (...args: unknown[]) => unknown;

interface PatchState {
	token: symbol;
	original: AnyFunction;
	wrapper: AnyFunction;
	onDisplaced?: () => void;
}

type Registry = Map<string, PatchState>;

function registryFor(target: object): Registry {
	const scope = target as Record<PropertyKey, unknown>;
	const existing = scope[REGISTRY];
	if (existing instanceof Map) return existing as Registry;
	const created: Registry = new Map();
	Object.defineProperty(target, REGISTRY, { value: created, configurable: true, enumerable: false });
	return created;
}

/**
 * Wrap `target[method]`. `behavior` receives the predecessor, the receiver, and
 * the arguments, and must return the predecessor's result. Returns a restore
 * function that is safe to call more than once.
 */
export function installMethodPatch(
	target: object,
	method: string,
	behavior: (predecessor: AnyFunction, receiver: unknown, args: unknown[]) => unknown,
): () => void {
	const scope = target as Record<PropertyKey, unknown>;
	const registry = registryFor(target);
	const descriptor = Object.getOwnPropertyDescriptor(target, method);
	const existing = registry.get(method);

	let original: AnyFunction | undefined;
	if (existing && descriptor?.value === existing.wrapper) {
		// Our wrapper is still installed: reuse the true predecessor.
		original = existing.original;
	} else if (typeof descriptor?.value === "function") {
		// Fresh method, or another owner patched after us: chain on top of it.
		original = descriptor.value as AnyFunction;
	}
	if (typeof original !== "function") return () => {};

	if (existing?.onDisplaced) {
		try {
			existing.onDisplaced();
		} catch {
			// A displaced owner must not block the newer one.
		}
	}

	const token = Symbol("pi-yancy-ui.patch");
	const wrapper = function (this: unknown, ...args: unknown[]): unknown {
		const current = registry.get(method);
		if (current?.token !== token) {
			// Displaced: keep the original behavior rather than folding twice.
			return original.apply(this, args);
		}
		return behavior(original, this, args);
	};

	registry.set(method, { token, original, wrapper });
	try {
		Object.defineProperty(target, method, {
			...(descriptor ?? { configurable: true, writable: true, enumerable: false }),
			value: wrapper,
		});
	} catch {
		registry.delete(method);
		return () => {};
	}

	return () => {
		const current = registry.get(method);
		if (current?.token !== token) return;
		registry.delete(method);
		if (scope[method] !== wrapper) return;
		try {
			if (descriptor) {
				Object.defineProperty(target, method, descriptor);
			} else {
				delete scope[method];
			}
		} catch {
			// A locked-down prototype simply keeps our wrapper; fail open above.
		}
	};
}
