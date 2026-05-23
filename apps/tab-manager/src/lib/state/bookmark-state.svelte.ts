/**
 * Reactive bookmark state for the side panel.
 *
 * Read-only reactive layer backed by `fromTable()`: provides granular
 * per-row reactivity via `SvelteMap`. All write operations are delegated
 * to workspace actions owned by the signed-in session.
 *
 * The public API exposes a `$derived` sorted array (access pattern is
 * always "render the full sorted list") plus a URL lookup set for O(1)
 * bookmark checks.
 *
 * Components read this through `workspace.state.bookmarks`.
 */

import { fromTable } from '@epicenter/svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';
import type { Bookmark, BookmarkId } from '$lib/workspace';

export function createBookmarkState(tabManager: TabManagerBrowser) {
	const bookmarksMap = fromTable(tabManager.tables.bookmarks);

	/** All bookmarks, sorted by most recently created first. Cached via $derived. */
	const bookmarks = $derived(
		[...bookmarksMap.values()].sort((a, b) => b.createdAt - a.createdAt),
	);

	/**
	 * Reactive set of bookmarked URLs for O(1) lookup.
	 *
	 * Uses `SvelteSet` so `.has()` is a tracked reactive read: Svelte 5
	 * re-renders any component that calls `isUrlBookmarked` when the set changes.
	 */
	const bookmarkedUrls = $derived(
		new SvelteSet(bookmarksMap.values().map((b) => b.url)),
	);

	return {
		[Symbol.dispose]() {
			bookmarksMap[Symbol.dispose]();
		},

		get bookmarks() {
			return bookmarks;
		},

		/**
		 * Check whether a URL is currently bookmarked.
		 *
		 * O(1) lookup via `SvelteSet.has()`, which is a tracked reactive
		 * read in Svelte 5: safe to call per-row in a list render.
		 */
		isUrlBookmarked(url: string | undefined): boolean {
			if (!url) return false;
			return bookmarkedUrls.has(url);
		},

		/**
		 * Toggle a bookmark for a tab: add if not bookmarked, remove if already
		 * bookmarked. Silently no-ops for tabs without a URL.
		 */
		async toggle(tab: BrowserTab) {
			if (!tab.url) return;
			return tabManager.actions.bookmarks_toggle({
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
			});
		},

		/** Open a bookmark in a new browser tab without removing the bookmark. */
		async open(bookmark: Bookmark) {
			return tabManager.actions.bookmarks_open({
				url: bookmark.url,
			});
		},

		/** Delete a bookmark by ID. Synchronous CRDT delete. */
		remove(id: BookmarkId) {
			return tabManager.actions.bookmarks_remove({ id });
		},

		/** Delete all bookmarks. Synchronous CRDT batch delete. */
		removeAll() {
			return tabManager.actions.bookmarks_remove_all();
		},
	};
}

export type BookmarkState = ReturnType<typeof createBookmarkState>;
