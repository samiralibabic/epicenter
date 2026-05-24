# WhisperingError Refactor: Migrate to createTaggedError with .withContext()

## Overview

Refactor `WhisperingError` and `WhisperingErr` to use wellcrafted's `createTaggedError` with the fluent `.withContext()` API, replacing the current custom implementation. This brings consistency with how all other service errors are created while preserving the UI-specific fields (title, description, action, severity).

## Current State

### Current Implementation (`result.ts`)

```typescript
export type WhisperingError = Omit<
  TaggedError<'WhisperingError'>,
  'message' | 'cause' | 'context'
> &
  Omit<UnifiedNotificationOptions, 'variant'> & {
    severity: 'error' | 'warning';
  };

const WhisperingError = (args: WhisperingErrorInput): WhisperingError => ({
  name: 'WhisperingError',
  severity: 'error',
  ...normalizeInput(args),
});

export const WhisperingErr = (args: WhisperingErrorInput) => Err(WhisperingError(args));
```

### Problems with Current Approach

1. **Inconsistent with other errors**: All other service errors use `createTaggedError`, but `WhisperingError` is a custom factory
2. **No `message` field**: Standard `TaggedError` has a `message` field; `WhisperingError` omits it and uses `title`/`description` instead
3. **Awkward type gymnastics**: Uses `Omit<TaggedError<...>, 'message' | 'cause' | 'context'>` to reshape the type
4. **Two separate factories**: `WhisperingError` (error) and `WhisperingWarning` (warning) are duplicated logic

## Proposed Solution

Use `createTaggedError` with the **fluent `.withContext()` API** to define the UI-specific context shape:

```typescript
import { createTaggedError } from 'wellcrafted/error';
import type { NotificationAction } from '$lib/services/notifications/types';

// Define the context shape for UI errors
// Note: description is optional and defaults to `message` in display
type WhisperingErrorContext = {
  title: string;
  description?: string;  // Optional - falls back to `message` in UI display
  severity: 'error' | 'warning';
  action?: NotificationAction;
  id?: string;
  icon?: string;
  requireInteraction?: boolean;
  silent?: boolean;
  persist?: boolean;
};

// Create the error factory using .withContext() fluent API
export const { WhisperingError, WhisperingErr } = createTaggedError('WhisperingError')
  .withContext<WhisperingErrorContext>();

// Derive the type
export type WhisperingError = ReturnType<typeof WhisperingError>;
```

### The Fluent Builder API

wellcrafted's `createTaggedError` returns an `ErrorBuilder` with chainable methods:

```typescript
type ErrorBuilder<TName, TContext, TCause> = ErrorFactories<TName, TContext, TCause> & {
  withContext<T>(): ErrorBuilder<TName, T, TCause>;
  withCause<T>(): ErrorBuilder<TName, TContext, T>;
};
```

**Key behaviors:**
- `.withContext<T>()` - Makes `context` **required** with type `T`
- `.withContext<T | undefined>()` - Makes `context` **optional** but typed
- `.withContext()` (no generic) - Makes `context` optional with `Record<string, unknown>`

### New Usage Pattern

```typescript
// Before
WhisperingErr({
  title: '❌ Failed to start recording',
  description: 'Please check your microphone permissions',
  action: { type: 'more-details', error: serviceError },
});

// After (full form with explicit description)
WhisperingErr({
  message: 'Failed to start recording',  // Required by TaggedError
  context: {
    title: '❌ Failed to start recording',
    description: 'Please check your microphone permissions',
    severity: 'error',
    action: { type: 'more-details', error: serviceError },
  },
});

// After (short form - description falls back to message in UI)
WhisperingErr({
  message: 'Please check your microphone permissions',
  context: {
    title: '❌ Failed to start recording',
    severity: 'error',
    action: { type: 'more-details', error: serviceError },
  },
});
```

## Key Decisions

### 1. Keep `message` Required (Standard TaggedError)

The `message` field is required by `TaggedError`. This serves as a technical/logging message while `context.title` and `context.description` are for UI display.

**Option A (Recommended)**: Keep `message` for technical logging
- `message`: "Recording failed: microphone permission denied"
- `context.title`: "❌ Unable to start recording"
- `context.description`: "Please check your microphone permissions"

**Option B**: Make `message` a computed field from title
- Could add a helper that sets `message = title` if not provided
- Less flexible but backwards compatible

### 2. Optional `description` with Fallback to `message`

The `description` field in context is **optional**. When displaying errors in the UI:

```typescript
// UI display logic (in toast/notification components)
const displayDescription = error.context.description ?? error.message;
```

This allows for concise error creation when title + message are sufficient:

```typescript
// Full form (explicit description)
WhisperingErr({
  message: 'Failed to parse response',
  context: {
    title: '❌ API Error',
    description: 'The server returned an unexpected response format.',
    severity: 'error',
  },
});

// Short form (description falls back to message)
WhisperingErr({
  message: 'The server returned an unexpected response format.',
  context: {
    title: '❌ API Error',
    severity: 'error',
  },
});
```

### 3. Action System with Factory Functions

The current action types are well-designed. To reduce boilerplate and improve ergonomics, we'll add factory functions:

#### Action Types (unchanged)

```typescript
type NotificationAction = LinkAction | ButtonAction | MoreDetailsAction;

type LinkAction = {
  type: 'link';
  label: string;
  href: `/${string}`;  // Must be local path (e.g., '/settings/transcription')
};

type ButtonAction = {
  type: 'button';
  label: string;
  onClick: () => void | Promise<void>;
};

type MoreDetailsAction = {
  type: 'more-details';
  error: unknown;  // The underlying error for debugging
};
```

#### Action Factory Functions (new)

```typescript
// Factory functions for cleaner action creation
export const Action = {
  /**
   * Show error details dialog with the underlying error
   * Most common action - used for debugging
   */
  moreDetails: (error: unknown): MoreDetailsAction => ({
    type: 'more-details',
    error,
  }),

  /**
   * Navigate to a settings page or other internal route
   * @param label - Button label (e.g., "Update API key")
   * @param href - Local path (e.g., "/settings/transcription")
   */
  link: (label: string, href: `/${string}`): LinkAction => ({
    type: 'link',
    label,
    href,
  }),

  /**
   * Custom callback button
   * @param label - Button label (e.g., "Copy to clipboard")
   * @param onClick - Callback function
   */
  button: (label: string, onClick: () => void | Promise<void>): ButtonAction => ({
    type: 'button',
    label,
    onClick,
  }),
} as const;
```

#### Usage Comparison

```typescript
// Before (verbose object literals)
WhisperingErr({
  message: 'API key invalid',
  context: {
    title: '🔑 Authentication Failed',
    severity: 'error',
    action: { type: 'link', label: 'Update API key', href: '/settings/transcription' },
  },
});

WhisperingErr({
  message: 'Transcription failed',
  context: {
    title: '❌ Error',
    severity: 'error',
    action: { type: 'more-details', error: serviceError },
  },
});

// After (clean factory functions)
WhisperingErr({
  message: 'API key invalid',
  context: {
    title: '🔑 Authentication Failed',
    severity: 'error',
    action: Action.link('Update API key', '/settings/transcription'),
  },
});

WhisperingErr({
  message: 'Transcription failed',
  context: {
    title: '❌ Error',
    severity: 'error',
    action: Action.moreDetails(serviceError),
  },
});
```

#### Benefits of Factory Functions

1. **Less boilerplate**: `Action.moreDetails(error)` vs `{ type: 'more-details', error }`
2. **Better autocomplete**: IDE shows available actions when typing `Action.`
3. **Type safety**: Factory functions enforce correct parameter types
4. **Discoverability**: All action types in one place with JSDoc comments
5. **Refactoring**: Change action shape in one place if needed

### 4. Handle `serviceError` Auto-Extraction

The current `normalizeInput` function has logic to auto-extract `message` from a `serviceError`. We should preserve this as a helper:

```typescript
// Helper to create WhisperingErr from a service error
export function fromServiceError(
  serviceError: TaggedError<string>,
  overrides?: Partial<WhisperingErrorContext>
): Err<WhisperingError> {
  return WhisperingErr({
    message: serviceError.message,  // Used as fallback description in UI
    context: {
      title: overrides?.title ?? '❌ An error occurred',
      severity: overrides?.severity ?? 'error',
      action: overrides?.action ?? Action.moreDetails(serviceError),
      ...overrides,  // Can override description if needed
    },
  });
}
```

### 5. Warning vs Error Severity

Instead of separate `WhisperingWarning`/`WhisperingWarningErr` factories, use `severity` in context:

```typescript
// Error (default)
WhisperingErr({
  message: 'Critical failure',
  context: { title: '❌ Error', description: '...', severity: 'error' },
});

// Warning
WhisperingErr({
  message: 'Non-critical issue',
  context: { title: '⚠️ Warning', description: '...', severity: 'warning' },
});
```

Or keep convenience helpers:

```typescript
export const WhisperingWarningErr = (args: {
  message: string;
  context: Omit<WhisperingErrorContext, 'severity'>;
}) => WhisperingErr({
  message: args.message,
  context: { ...args.context, severity: 'warning' },
});
```

## Migration Tasks

### Phase 1: Update Type Definitions and Factories

- [ ] Define `WhisperingErrorContext` type with all UI fields (description optional)
- [ ] Create `WhisperingError`/`WhisperingErr` using `createTaggedError('WhisperingError').withContext<WhisperingErrorContext>()`
- [ ] Export the derived type: `type WhisperingError = ReturnType<typeof WhisperingError>`
- [ ] Create `Action` factory object with `moreDetails()`, `link()`, `button()` methods
- [ ] Create `fromServiceError` helper function
- [ ] Optionally create `WhisperingWarningErr` convenience helper

### Phase 2: Update All Call Sites

Every place that calls `WhisperingErr` or `WhisperingWarningErr` needs updating:

**Before:**
```typescript
WhisperingErr({
  title: '❌ Error title',
  description: 'Error description',
  action: { type: 'more-details', error },
});
```

**After:**
```typescript
WhisperingErr({
  message: 'Error description',  // or a technical summary
  context: {
    title: '❌ Error title',
    severity: 'error',
    action: Action.moreDetails(error),
  },
});
```

### Phase 3: Update UI Consumption

Update components that consume `WhisperingError` to access fields via `context`, with description fallback to message:

**Before:**
```typescript
toast.error(error.title, { description: error.description });
```

**After:**
```typescript
// Use description if provided, otherwise fall back to message
const description = error.context.description ?? error.message;
toast.error(error.context.title, { description });
```

## Files to Update

### Core (`result.ts`)
- Complete rewrite of error factory

### Query Layer (transform service errors → UI errors)
- `apps/whispering/src/lib/query/transcription.ts`
- `apps/whispering/src/lib/query/actions.ts`
- `apps/whispering/src/lib/query/vad.svelte.ts`
- `apps/whispering/src/lib/query/recorder.ts`
- `apps/whispering/src/lib/query/transformer.ts`
- `apps/whispering/src/lib/query/delivery.ts`
- `apps/whispering/src/lib/query/download.ts`
- `apps/whispering/src/lib/query/ffmpeg.ts`
- `apps/whispering/src/lib/query/tray.ts`

### Services (where WhisperingErr is returned)
- `apps/whispering/src/lib/services/transcription/cloud/*.ts`
- `apps/whispering/src/lib/services/transcription/local/*.ts`
- `apps/whispering/src/lib/services/transcription/self-hosted/*.ts`
- `apps/whispering/src/lib/stores/settings.svelte.ts`

### UI Components (consuming WhisperingError)
- Any component that reads `.title`, `.description`, `.action` directly from error

## Alternative: Backwards-Compatible Wrapper

If the migration is too large, consider a backwards-compatible wrapper:

```typescript
// New internal implementation using fluent .withContext() API
const { _WhisperingError, _WhisperingErr } = createTaggedError('WhisperingError')
  .withContext<WhisperingErrorContext>();

// Backwards-compatible API
export const WhisperingErr = (args: WhisperingErrorInput) => {
  const normalized = normalizeInput(args);
  return _WhisperingErr({
    message: normalized.title,  // Use title as message for compat
    context: {
      ...normalized,
      severity: 'error',
    },
  });
};
```

This preserves the current API while using `createTaggedError` with `.withContext()` internally.

## Recommendation

**Start with the backwards-compatible wrapper approach**, then gradually migrate call sites to the new API. This allows:

1. Immediate consistency with wellcrafted's `createTaggedError`
2. No breaking changes to existing code
3. Gradual migration of call sites as they're touched
4. Full migration can happen over time

## Benefits of Migration

1. **Consistency**: All errors use `createTaggedError` pattern
2. **Type safety**: Fixed context shape is enforced by TypeScript
3. **Standard structure**: `message` field for logging, `context` for UI
4. **Chaining potential**: Future `withContext` additions would work seamlessly
5. **Debugging**: Standard `TaggedError` structure works with wellcrafted tooling
