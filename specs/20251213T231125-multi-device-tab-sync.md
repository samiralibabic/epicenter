# Multi-Device Tab Sync

## Problem

The tab-manager extension currently syncs all tabs to a single Y.Doc with the workspace ID `'browser'`. If the same extension runs on multiple devices (laptop, desktop, etc.), several issues arise:

1. **ID Collisions**: Browser tab IDs are local integers. Laptop might have tab ID `123`, desktop might also have tab ID `123`. Both would overwrite each other in Y.Doc.

2. **Destructive Refetch**: The current refetch logic deletes any Y.Doc tabs not found in the browser. This would delete other devices' tabs.

3. **No Device Attribution**: There's no way to know which device a tab belongs to, preventing features like "view tabs from my laptop" or "send tab to desktop".

## Solution

Add device-scoped IDs and a devices table to enable multi-device sync while preventing collisions and preserving each device's data.

### Data Model Changes

#### 1. New `devices` Table

```typescript
// In browser.schema.ts
export const DEVICES_SCHEMA = {
  id: id(),           // NanoID, generated once on install via @wxt-dev/storage
  name: text(),       // User-editable: "Work Laptop", "Home Desktop"
  last_seen: text(),  // ISO timestamp, updated on each sync
  browser: text(),    // import.meta.env.BROWSER: 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
} as const;

export type Device = SerializedRow<typeof DEVICES_SCHEMA>;
```

#### 2. Schema Additions to Existing Tables

Add `device_id` and `tab_id`/`window_id`/`group_id` columns to tabs, windows, and tab_groups:

```typescript
// tabs
export const TABS_SCHEMA = {
  id: id(),                    // Composite: `${deviceId}_${tabId}`
  device_id: text(),           // Foreign key to devices table
  tab_id: integer(),           // Original browser tab ID for API calls
  // ... existing fields unchanged
} as const;

// windows
export const WINDOWS_SCHEMA = {
  id: id(),                    // Composite: `${deviceId}_${windowId}`
  device_id: text(),           // Foreign key to devices table
  window_id: integer(),        // Original browser window ID for API calls
  // ... existing fields unchanged
} as const;

// tab_groups (Chrome/Edge only, Firefox doesn't support tab groups)
export const TAB_GROUPS_SCHEMA = {
  id: id(),                    // Composite: `${deviceId}_${groupId}`
  device_id: text(),           // Foreign key to devices table
  group_id: integer(),         // Original browser group ID for API calls
  // ... existing fields unchanged
} as const;
```

#### 3. Composite ID Format

Use underscore `_` as the delimiter:

```
{deviceId}_{tabId}
abc123xyz789def_456
```

Why underscore:
- URL-safe (no encoding needed)
- Filename-safe (works on all file systems)
- Not used elsewhere in codebase for composite keys
- Easy to parse with `split('_')` or `indexOf('_')`

### Implementation

#### 1. Device ID Management (`src/lib/device-id.ts`)

Using `@wxt-dev/storage` for cleaner storage with auto-initialization:

```typescript
import { storage } from '@wxt-dev/storage';
import { generateId } from '@epicenter/workspace';

/**
 * Device ID storage item.
 * Auto-generates a NanoID on first access if not already set.
 */
const deviceIdItem = storage.defineItem<string>('local:device.id', {
  init: () => generateId(),
});

/**
 * Get the stable device ID for this browser installation.
 * Generated once on first install, persisted in storage.local.
 */
export async function getDeviceId(): Promise<string> {
  return deviceIdItem.getValue();
}

/**
 * Get the current browser name from WXT environment.
 */
export function getBrowserName(): string {
  return import.meta.env.BROWSER; // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
}

/**
 * Format OS name from platform info to human-readable string.
 */
function formatOsName(os: string): string {
  const osNames: Record<string, string> = {
    mac: 'macOS',
    win: 'Windows',
    linux: 'Linux',
    cros: 'ChromeOS',
    android: 'Android',
    openbsd: 'OpenBSD',
    fuchsia: 'Fuchsia',
  };
  return osNames[os] ?? os;
}

/**
 * Capitalize first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generate a default device name like "Chrome on macOS".
 */
export async function generateDefaultDeviceName(): Promise<string> {
  const browserName = capitalize(import.meta.env.BROWSER);
  const platformInfo = await browser.runtime.getPlatformInfo();
  const osName = formatOsName(platformInfo.os);
  return `${browserName} on ${osName}`;
}

type CompositeIdParts = {
  deviceId: string;
  id: number | string;
};

/**
 * Create a composite ID from device ID and browser's tab/window/group ID.
 */
export function createCompositeId({ deviceId, id }: CompositeIdParts): string {
  return `${deviceId}_${id}`;
}

/**
 * Parse a composite ID into its parts.
 * Returns null if the format is invalid.
 */
export function parseCompositeId(compositeId: string): { deviceId: string; id: number } | null {
  const idx = compositeId.indexOf('_');
  if (idx === -1) return null;

  const deviceId = compositeId.slice(0, idx);
  const id = Number.parseInt(compositeId.slice(idx + 1), 10);

  if (Number.isNaN(id)) return null;

  return { deviceId, id };
}
```

#### 2. Browser Helpers Update (`src/lib/browser-helpers.ts`)

Renamed from `chrome-helpers.ts` for browser-agnostic naming:

```typescript
import { createCompositeId } from './device-id';

type TabToRowParams = {
  tab: Browser.tabs.Tab;
  deviceId: string;
};

export function browserTabToRow({ tab, deviceId }: TabToRowParams): Tab {
  return {
    id: createCompositeId({ deviceId, id: tab.id! }),
    device_id: deviceId,
    tab_id: tab.id!,
    window_id: createCompositeId({ deviceId, id: tab.windowId! }),
    group_id: tab.groupId !== undefined && tab.groupId !== -1
      ? createCompositeId({ deviceId, id: tab.groupId })
      : null,
    opener_tab_id: tab.openerTabId !== undefined
      ? createCompositeId({ deviceId, id: tab.openerTabId })
      : null,
    // ... rest unchanged
  };
}

type WindowToRowParams = {
  window: Browser.windows.Window;
  deviceId: string;
};

export function browserWindowToRow({ window, deviceId }: WindowToRowParams): Window {
  return {
    id: createCompositeId({ deviceId, id: window.id! }),
    device_id: deviceId,
    window_id: window.id!,
    // ... rest unchanged
  };
}

type TabGroupToRowParams = {
  group: Browser.tabGroups.TabGroup;
  deviceId: string;
};

export function browserTabGroupToRow({ group, deviceId }: TabGroupToRowParams): TabGroup {
  return {
    id: createCompositeId({ deviceId, id: group.id }),
    device_id: deviceId,
    group_id: group.id,
    window_id: createCompositeId({ deviceId, id: group.windowId }),
    // ... rest unchanged
  };
}
```

#### 3. Background.ts Updates

##### Initialization

```typescript
import { getDeviceId, getBrowserName, generateDefaultDeviceName, createCompositeId, parseCompositeId } from '$lib/device-id';
import { browserTabToRow, browserWindowToRow, browserTabGroupToRow } from '$lib/browser-helpers';

export default defineBackground(() => {
  // Get device ID early (cached after first call)
  const deviceIdPromise = getDeviceId();

  // Register this device in the devices table
  const registerDevice = async () => {
    const deviceId = await deviceIdPromise;
    const existingDevice = tables.devices.get(deviceId);

    tables.devices.upsert({
      id: deviceId,
      // Keep existing name if set, otherwise generate default
      name: existingDevice?.name ?? await generateDefaultDeviceName(),
      last_seen: new Date().toISOString(),
      browser: getBrowserName(),
    });
  };

  // ... rest of initialization
});
```

##### Refetch Functions (Scoped to This Device)

```typescript
async refetchTabs() {
  const deviceId = await deviceIdPromise;
  const browserTabs = await browser.tabs.query({});
  const tabIds = new Set(
    browserTabs
      .filter((t) => t.id !== undefined)
      .map((t) => t.id!), // Keep as numbers for comparison
  );
  const existingYDocTabs = tables.tabs.getAllValid();

  tables.$transact(() => {
    // Upsert all browser tabs (with device-scoped IDs)
    for (const tab of browserTabs) {
      if (tab.id === undefined) continue;
      tables.tabs.upsert(browserTabToRow({ tab, deviceId }));
    }

    // Delete only THIS device's tabs that aren't in the browser
    for (const existing of existingYDocTabs) {
      if (existing.device_id !== deviceId) continue; // Skip other devices!
      if (!tabIds.has(existing.tab_id)) {
        tables.tabs.delete({ id: existing.id });
      }
    }
  });
}
```

##### Event Handlers

```typescript
// onRemoved - use device-scoped ID
browser.tabs.onRemoved.addListener(async (tabId) => {
  await initPromise;
  if (syncCoordination.isProcessingYDocChange) return;

  const deviceId = await deviceIdPromise;
  syncCoordination.isRefetching = true;
  tables.tabs.delete({ id: createCompositeId({ deviceId, id: tabId }) });
  syncCoordination.isRefetching = false;
});

// onActivated - use device-scoped IDs for filtering
browser.tabs.onActivated.addListener(async (activeInfo) => {
  await initPromise;
  if (syncCoordination.isProcessingYDocChange) return;

  const deviceId = await deviceIdPromise;
  syncCoordination.isRefetching = true;

  const deviceWindowId = createCompositeId({ deviceId, id: activeInfo.windowId });
  const deviceTabId = createCompositeId({ deviceId, id: activeInfo.tabId });

  // Find previously active tabs in this window ON THIS DEVICE
  const previouslyActiveTabs = tables.tabs
    .filter((t) => t.window_id === deviceWindowId && t.active)
    .filter((t) => t.id !== deviceTabId);

  for (const prevTab of previouslyActiveTabs) {
    tables.tabs.upsert({ ...prevTab, active: false });
  }

  await upsertTabById(activeInfo.tabId);
  syncCoordination.isRefetching = false;
});
```

##### Y.Doc Observers (Parse composite ID for API calls)

```typescript
client.tables.tabs.observe({
  onAdd: async (result, transaction) => {
    await initPromise;
    if (transaction.origin === null) return;
    if (result.error) return;

    const row = result.data;
    const deviceId = await deviceIdPromise;

    // Only process if this tab is meant for THIS device
    // (future: could add explicit "send to device" targeting)
    if (row.device_id !== deviceId) return;

    if (!row.url) return;

    syncCoordination.isProcessingYDocChange = true;
    await tryAsync({
      try: async () => {
        await browser.tabs.create({ url: row.url });
        syncCoordination.isRefetching = true;
        await client.refetchTabs();
        syncCoordination.isRefetching = false;
      },
      catch: (error) => {
        console.log(`[Background] Failed to create tab:`, error);
        return Ok(undefined);
      },
    });
    syncCoordination.isProcessingYDocChange = false;
  },

  onDelete: async (id, transaction) => {
    await initPromise;
    if (transaction.origin === null) return;

    const deviceId = await deviceIdPromise;
    const parsed = parseCompositeId(id);

    // Only close tabs that belong to THIS device
    if (!parsed || parsed.deviceId !== deviceId) return;

    syncCoordination.isProcessingYDocChange = true;
    await tryAsync({
      try: async () => {
        await browser.tabs.remove(parsed.id);
      },
      catch: (error) => {
        console.log(`[Background] Failed to close tab ${id}:`, error);
        return Ok(undefined);
      },
    });
    syncCoordination.isProcessingYDocChange = false;
  },
});
```

#### 4. UI Component Updates (`TabItem.svelte`)

```typescript
// Current
const tabId = $derived(Number(tab.id));

// New
import { parseCompositeId } from '$lib/device-id';
const tabId = $derived(parseCompositeId(tab.id)?.id ?? null);
```

### WXT-Specific Simplifications

1. **Browser Detection**: Use `import.meta.env.BROWSER` instead of manual UA sniffing
2. **Storage**: Use `@wxt-dev/storage` with `defineItem()` and `init` option for auto-generation
3. **Naming**: Use `browser` instead of `chrome` for cross-browser compatibility
4. **Manifest Version**: `import.meta.env.MANIFEST_VERSION` available if needed for MV2/MV3 differences

### Migration Strategy

Since tab data is ephemeral (destroyed on browser restart anyway), no data migration is needed:

1. Update schema to include new columns
2. Rename `chrome-helpers.ts` to `browser-helpers.ts`
3. Update all helpers and background.ts
4. On next browser restart, `refetchAll()` populates with new device-scoped IDs
5. Old data (if any) will be orphaned and eventually cleaned up

### Future Enhancements

Once device-scoping is in place, these features become possible:

1. **Device Picker UI**: Filter tabs by device in the sidebar
2. **Send Tab to Device**: Right-click menu to send a tab to another device
3. **Device Management**: Settings page to rename/remove devices
4. **Cross-Device Tab Search**: Search across all devices' tabs
5. **Device-Specific Sync**: Option to only sync certain tab groups across devices

## Todo Checklist

### Schema Changes
- [ ] Add `DEVICES_SCHEMA` to `browser.schema.ts`
- [ ] Add `device_id`, `tab_id` columns to `TABS_SCHEMA`
- [ ] Add `device_id`, `window_id` columns to `WINDOWS_SCHEMA`
- [ ] Add `device_id`, `group_id` columns to `TAB_GROUPS_SCHEMA`
- [ ] Update `BROWSER_SCHEMA` export to include devices table

### Device ID Module
- [ ] Install `@wxt-dev/storage` if not already present
- [ ] Create `src/lib/device-id.ts` with:
  - [ ] `deviceIdItem` storage definition with `init`
  - [ ] `getDeviceId()` function
  - [ ] `getBrowserName()` function
  - [ ] `generateDefaultDeviceName()` function (uses `browser.runtime.getPlatformInfo()`)
  - [ ] `createCompositeId()` function (single object argument)
  - [ ] `parseCompositeId()` function

### Helper Renames
- [ ] Rename `chrome-helpers.ts` to `browser-helpers.ts`
- [ ] Rename `chromeTabToRow` to `browserTabToRow`
- [ ] Rename `chromeWindowToRow` to `browserWindowToRow`
- [ ] Rename `chromeTabGroupToRow` to `browserTabGroupToRow`
- [ ] Update all helpers to accept single object argument with `{ tab/window/group, deviceId }`

### Background.ts Updates
- [ ] Update imports to use new module names
- [ ] Add `deviceIdPromise` initialization
- [ ] Add `registerDevice()` function
- [ ] Update `refetchTabs()` to scope deletions to this device
- [ ] Update `refetchWindows()` to scope deletions to this device
- [ ] Update `refetchTabGroups()` to scope deletions to this device
- [ ] Update `tabs.onRemoved` handler with device-scoped ID
- [ ] Update `windows.onRemoved` handler with device-scoped ID
- [ ] Update `tabGroups.onRemoved` handler with device-scoped ID
- [ ] Update `tabs.onActivated` handler with device-scoped filtering
- [ ] Update `windows.onFocusChanged` handler with device-scoped filtering
- [ ] Update Y.Doc `tabs.onDelete` observer to parse composite ID
- [ ] Update Y.Doc `windows.onDelete` observer to parse composite ID
- [ ] Update Y.Doc `tab_groups.onDelete` observer to parse composite ID
- [ ] Update Y.Doc `tabs.onAdd` observer to check device ownership

### UI Updates
- [ ] Update `TabItem.svelte` to use `parseCompositeId()`

### Testing
- [ ] Test: Single device still works correctly
- [ ] Test: Two devices see each other's tabs without collisions
- [ ] Test: Closing tab on device A doesn't affect device B's tabs
- [ ] Test: Firefox build works (no tab groups, browser detection)

## Review

(To be filled in after implementation)
