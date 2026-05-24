# Vite HMR Is Not a Page Reload

I've talked before about true module singletons: you create the thing at module
evaluation time, export it once, and keep it alive for the whole time the
website is open. In a single page app, that means you often do not need to
dispose it at all. A real page reload already refreshes the whole JavaScript
context.

Vite hot module replacement is the exception because it is not a real page
reload. It can run the new copy of a module while the old copy's listeners,
observers, intervals, or sockets are still alive.

That means this can be fine for the page lifetime:

```typescript
function createBookmarkState() {
	const bookmarksMap = fromTable(workspace.tables.bookmarks);
	const bookmarks = $derived([...bookmarksMap.values()]);

	return {
		get bookmarks() {
			return bookmarks;
		},
	};
}

export const bookmarkState = createBookmarkState();
```

But during HMR, every updated module copy can add another table observer. The
page did not reload, so nothing automatically removed the previous one.

Make the singleton disposable:

```typescript
function createBookmarkState() {
	const bookmarksMap = fromTable(workspace.tables.bookmarks);
	const bookmarks = $derived([...bookmarksMap.values()]);

	return {
		[Symbol.dispose]() {
			bookmarksMap[Symbol.dispose]();
		},

		get bookmarks() {
			return bookmarks;
		},
	};
}

export const bookmarkState = createBookmarkState();

if (import.meta.hot) {
	import.meta.hot.dispose(() => bookmarkState[Symbol.dispose]());
}
```

This is not a `fromTable()` rule. `fromTable()` is just the example in front of
us. The more general rule is ownership: the module created a persistent side
effect, so the module owns the HMR teardown.

```txt
fromTable()
  owns one Yjs observer

createBookmarkState()
  owns the fromTable() map

bookmark-state.svelte.ts
  owns the module singleton during HMR
```

The same shape applies to a storage watcher, a browser event listener, an
interval, or a socket:

```typescript
function createSidebarState() {
	let width = $state(280);

	const unwatchStorage = watchStorage('sidebar-width', (nextWidth) => {
		width = nextWidth;
	});

	const interval = setInterval(() => {
		flushPendingMeasurements();
	}, 1000);

	return {
		[Symbol.dispose]() {
			unwatchStorage();
			clearInterval(interval);
		},

		get width() {
			return width;
		},
	};
}

export const sidebarState = createSidebarState();

if (import.meta.hot) {
	import.meta.hot.dispose(() => sidebarState[Symbol.dispose]());
}
```

Vite documents `hot.dispose(cb)` as the hook for persistent side effects created
by the old module copy. That is the exact situation here.

Do not put this cleanup in a random component. The component did not create the
module singleton. The module did.

Provider-owned state is different. If the state is created under a workspace
provider, let the provider call `[Symbol.dispose]()` when the workspace goes
away:

```svelte
<script lang="ts">
	import { onDestroy } from 'svelte';

	const workspace = openWorkspace(identity);
	const state = createWorkspaceState(workspace);

	onDestroy(() => {
		state[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});
</script>
```

The rule is not "always dispose module state." The rule is more specific: if a
module singleton creates a persistent side effect and Vite may hot-reload that
module, register `import.meta.hot.dispose()` in the same module.
