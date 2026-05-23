/**
 * Reactive saved tab state for the side panel.
 *
 * Read-only reactive layer backed by `fromTable()`: provides granular
 * per-row reactivity via `SvelteMap`. All write operations are delegated
 * to workspace actions owned by the signed-in session.
 *
 * The public API exposes a `$derived` sorted array since the access
 * pattern is always "render the full sorted list."
 *
 * @example
 * Components read this through `workspace.state.savedTabs`.
 */

import { fromTable } from '@epicenter/svelte';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';
import type { SavedTab, SavedTabId } from '$lib/workspace';

export function createSavedTabState(tabManager: TabManagerBrowser) {
	const tabsMap = fromTable(tabManager.tables.savedTabs);

	/** All saved tabs, sorted by most recently saved first. Cached via $derived. */
	const tabs = $derived(
		[...tabsMap.values()].sort((a, b) => b.savedAt - a.savedAt),
	);

	return {
		[Symbol.dispose]() {
			tabsMap[Symbol.dispose]();
		},

		get tabs() {
			return tabs;
		},

		/**
		 * Save a tab: snapshot its metadata to Y.Doc and close the browser tab.
		 *
		 * Delegates to the `saved_tabs_save` workspace action. Silently no-ops
		 * for tabs without a URL. The action's Result envelope flows through
		 * to callers; today the action's Err channel is `never` because
		 * browser-API failures during the close step are intentionally
		 * swallowed inside the handler.
		 */
		async save(tab: BrowserTab) {
			if (!tab.url) return;
			return tabManager.actions.saved_tabs_save({
				browserTabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned,
			});
		},

		/**
		 * Restore a saved tab: re-open in browser and delete the record.
		 *
		 * The action returns `Result<{ restored }, BrowserApiFailed>`: the
		 * saved record is preserved on `tabs.create` failure so the user
		 * doesn't lose the URL.
		 */
		async restore(savedTab: SavedTab) {
			return tabManager.actions.saved_tabs_restore({
				id: savedTab.id,
				url: savedTab.url,
				pinned: savedTab.pinned,
			});
		},

		/** Restore all saved tabs at once. */
		async restoreAll() {
			return tabManager.actions.saved_tabs_restore_all();
		},

		/** Delete a saved tab without restoring it. Synchronous CRDT delete. */
		remove(id: SavedTabId) {
			return tabManager.actions.saved_tabs_remove({ id });
		},

		/** Delete all saved tabs without restoring them. Synchronous CRDT batch delete. */
		removeAll() {
			return tabManager.actions.saved_tabs_remove_all();
		},
	};
}

export type SavedTabState = ReturnType<typeof createSavedTabState>;
