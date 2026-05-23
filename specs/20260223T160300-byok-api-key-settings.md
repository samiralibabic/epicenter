# BYOK API Key Settings for Tab Manager

## Problem

The tab manager sidebar AI chat always routes through the hub proxy (`/proxy/:provider/*`), which requires server-side env vars like `ANTHROPIC_API_KEY`. When no env var is set, users get:

> 502 No API key configured for anthropic. Set ANTHROPIC_API_KEY environment variable.

The engine already supports BYOK mode (direct-to-provider with the user's own key), but `sendChatToBgsw()` in `chat.svelte.ts` never sets the `apiKey` field on `ChatRequest`. There's no UI to enter or store API keys.

## Solution

Add per-provider BYOK API key storage + a minimal settings UI in the sidebar. When a key is stored, it's sent as `apiKey` on `ChatRequest`: the engine uses BYOK mode (direct to provider, no hub proxy needed).

## Todo

- [ ] **1. Add API key storage**: `apps/tab-manager/src/lib/state/settings.ts`
  - Add `storage.defineItem<Record<string, string>>('local:provider.api.keys', { fallback: {} })` using wxt storage
  - Export `getApiKey(provider): Promise<string | undefined>` and `setApiKey(provider, key): Promise<void>`
  - Simple read/write: no versioning needed for v1

- [ ] **2. Wire apiKey into ChatRequest**: `apps/tab-manager/src/lib/state/chat.svelte.ts`
  - In `sendChatToBgsw()`, call `getApiKey(conv.provider)` before building the request
  - Set `apiKey` field on the `ChatRequest` if a key exists for the provider
  - If no BYOK key, fall through to hub proxy mode as before (no behavior change)

- [ ] **3. Add API Key settings UI**: New `ApiKeySettings.svelte` component
  - Small settings button (gear icon) in the AI chat controls area
  - Opens a Dialog with a single input for the current provider's API key
  - Reads/writes via `getApiKey`/`setApiKey` from settings.ts
  - Uses existing shadcn-svelte: `Dialog`, `Input`, `Button`, `Label` from `@epicenter/ui/*`

- [ ] **4. Mount settings button in AiChat.svelte**
  - Add a gear icon button next to the provider/model selects
  - Opens the ApiKeySettings dialog

## Env Var Fallback (No Code Change)

For hub/proxy mode, set the env var when starting the server:

```bash
ANTHROPIC_API_KEY=sk-ant-... bun run src/start-hub.ts
```

Or export it in your shell profile:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Files Changed

| File | Change |
|------|--------|
| `apps/tab-manager/src/lib/state/settings.ts` | Add API key storage functions |
| `apps/tab-manager/src/lib/state/chat.svelte.ts` | Read stored key, pass as `apiKey` on ChatRequest |
| `apps/tab-manager/src/lib/components/ApiKeySettings.svelte` | New: dialog for entering API keys |
| `apps/tab-manager/src/lib/components/AiChat.svelte` | Add gear button to open settings dialog |

## Review

_To be filled after implementation._
