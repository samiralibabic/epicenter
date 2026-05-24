# @epicenter/workspace/ai

`@epicenter/workspace/ai` turns Epicenter workspace actions into LLM-callable tools. It exists because the browser owns the real action handlers, while the chat server only sees JSON over the wire. Apps use this bridge to keep execution local, send tool definitions to the server, and let the model call workspace actions without hardcoding every tool twice.

## Quick usage

This is the pattern from workspace clients:

```typescript
import { actionsToAiTools } from '@epicenter/workspace/ai';

export const workspaceAiTools = actionsToAiTools(workspace.actions);
```

Under the hood, that split is the whole point:

```text
workspace.actions
  └─ actionsToAiTools(...)
       ├─ tools        -> client tools with execute()
       └─ definitions  -> JSON payload for the server
```

The first result stays in the browser. The second goes into the request body so the server can tell TanStack AI which tools exist.

## How the bridge works

Workspace actions are a flat `ActionRegistry` keyed by snake_case ASCII strings. `actionsToAiTools()` reads each entry with `Object.entries(actions)` and returns TanStack AI client tools plus wire-safe definitions. The AI tool name is the action key verbatim; there is no projection.

Queries become ordinary client tools. Mutations automatically get `needsApproval: true`, which is how the UI knows not to run destructive actions silently.

The `definitions` array omits runtime-only fields like `execute` and `__toolSide`. What survives is the wire-safe shape the server needs: tool name, description, schema, approval flag, and title.

One detail matters more than it looks. Input schemas are normalized so `properties` and `required` are always present. The source calls out Anthropic here because some providers reject schemas that omit those keys.

## API overview

### `actionsToAiTools(source)`

Converts an action registry into TanStack AI client tools and JSON definitions. The tool name is the action key, which is already snake_case ASCII (e.g. an action keyed `tabs_close` produces a tool named `tabs_close`).

### `ToolDefinition`

The wire-safe tool shape for the HTTP request body.

### `ActionNames<T>`

Type-level helper that turns an `ActionRegistry` into a string union of tool names.

```typescript
type Names = ActionNames<typeof workspace.actions>;
// "tabs_search" | "tabs_close" | ...
```

## Relationship to the monorepo

`@epicenter/workspace/ai` sits between `@epicenter/workspace` and chat clients built on `@tanstack/ai`.

- `@epicenter/workspace` defines actions and exposes `defineActions` / `defineQuery` / `defineMutation`.
- `@epicenter/workspace/ai` adapts those actions into client tools and wire payloads.
- Apps like `apps/opensidian` feed the client tools into local chat execution and send the stripped definitions to the API.

If you already have a workspace with actions, this package gives you the missing adapter layer. Nothing more.

## Source entry point

The workspace package exposes these symbols from its AI entry point:

```typescript
export {
	type ActionNames,
	actionsToAiTools,
	type ToolDefinition,
} from '@epicenter/workspace/ai';
```

## License

MIT
