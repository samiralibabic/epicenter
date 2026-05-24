# Your SPA Singleton Doesn't Need $effect Cleanup

If you're building a single-page application in Svelte 5, you can often skip
`$effect` cleanup for true module singletons. You create the thing at module
evaluation time, export it once, and keep it alive for the whole time the
website is open. In a single page app, that means you often do not need to
dispose it at all. A real page reload already refreshes the whole JavaScript
context.

Here's a real storage wrapper from a browser extension. It calls `item.watch()`
to sync state from other tabs, with no `$effect`, no `onDestroy`, and no cleanup
function.

```typescript
export function createStorageState<T, TSchema extends StandardSchemaV1>(
	key: StorageItemKey,
	{ fallback, schema }: { fallback: T; schema: TSchema },
) {
	let value = $state<T>(fallback);

	void item.getValue().then((persisted) => {
		value = validate(persisted) ?? fallback;
	});

	item.watch((newValue) => {
		value = validate(newValue) ?? fallback;
	});

	return {
		get current(): T {
			return value;
		},
		set current(newValue: T) {
			value = newValue;
			void item.setValue(newValue);
		},
	};
}
```

Called once at module scope, exported as a constant:

```typescript
export const serverUrl = createStorageState('local:server.url', {
	fallback: 'https://api.epicenter.so',
	schema: type('string'),
});
```

That `item.watch()` listener never gets removed. It doesn't need to. The module
loads once, the singleton lives for the entire session, and when the user closes
the tab, the JavaScript context dies and takes everything with it.

The instinct to reach for `$effect` here hits a wall. Svelte 5 throws an
`effect_orphan` error if you call `$effect` outside a component's initialization:

```typescript
// This throws: effect_orphan
export function createStorageState(...) {
	$effect(() => {
		const unwatch = item.watch(...);
		return unwatch;
	});
}
```

You could reach for `$effect.root`, but then you are back to tracking a manual
destroy function for something that was already supposed to live forever.

The same pattern works with plain DOM events. `createPersistedState` does this
with `window.addEventListener`: two listeners, no cleanup.

```typescript
export function createPersistedState({ key, schema, onParseError }) {
	let value = $state(parseValueFromStorage(localStorage.getItem(key)));

	window.addEventListener('storage', (event) => {
		if (event.key !== key) return;
		value = parseValueFromStorage(event.newValue);
	});

	window.addEventListener('focus', () => {
		value = parseValueFromStorage(localStorage.getItem(key));
	});

	return {
		get value() {
			return value;
		},
		set value(newValue) {
			value = newValue;
			localStorage.setItem(key, JSON.stringify(newValue));
		},
	};
}
```

`storage` and `focus` events on `window` for a singleton that never unmounts.
The listeners are intentionally immortal because the thing they serve is
immortal.

It is not just DOM events. Subscription APIs work the same way. Here's how
workspace settings can sync Yjs CRDT changes into a reactive `SvelteMap`:

```typescript
function createWorkspaceSettings() {
	const map = new SvelteMap<string, unknown>();

	for (const key of Object.keys(KV_DEFINITIONS) as KvKey[]) {
		map.set(key, workspace.kv.get(key));
	}

	workspace.kv.observeAll((changes) => {
		for (const [key, change] of changes) {
			if (change.type === 'set') {
				map.set(key, change.value);
			} else if (change.type === 'delete') {
				map.set(key, workspace.kv.get(key));
			}
		}
	});

	return {
		get(key) {
			return map.get(key);
		},
		set(key, value) {
			workspace.kv.set(key, value);
		},
	};
}

export const settings = createWorkspaceSettings();
```

`observeAll` returns an unsubscribe function. In this specific singleton shape,
you can ignore it. The observer feeds the `SvelteMap`, the `SvelteMap` feeds
components, and the whole chain lives exactly as long as the app does. The three
patterns are structurally identical: subscribe once, never unsubscribe, let the
page lifecycle handle teardown.

This breaks if you call the factory from a component that mounts and unmounts.
Each mount adds listeners that never get removed. The fix is simple: only use
this pattern for true module singletons. If a component owns the resource, use
component teardown. If a provider owns the resource, dispose it from the
provider.

Vite hot module replacement is the one extra development wrinkle. HMR is not a
real page reload, so module-owned side effects can survive across updates unless
the module closes them. For that narrower rule, see
[Vite HMR Is Not a Page Reload](./vite-hmr-is-not-a-page-reload.md).
