# Your Auth Gate Isn't a Security Boundary

I was staring at our extension's `AuthGate` component and something felt off. The entire app is guarded by a reactive variable: `authState.status === 'signed-in'`. A single `$state` value decides whether you see the dashboard or the login form. Anyone with DevTools could flip it.

Then I realized I was confusing two different things. The auth gate doesn't protect data (the server already has middleware for you). It hides UI that isn't relevant to you yet.

## The gate is just an `{#if}` block

Here's what the auth gate actually does:

```svelte
{#if authState.status === 'checking'}
  <Spinner />
{:else if authState.status === 'signed-out' || authState.status === 'signing-in'}
  <!-- login form -->
{:else}
  {@render children()}
{/if}
```

That's it. A conditional render on a reactive variable. If you're signed in, you see the app. If not, you see the login form. No cryptography, no token verification, no server round-trip. Just an `{#if}` block.

## Spoofing the gate gets you an empty room

Say you open DevTools and somehow set `authState.status` to `'signed-in'`. The `{#if}` block renders the children. You see the tab manager UI: navigation, tab list layout, empty tables. Now what?

Every piece of data in that UI comes from authenticated API calls. The sync extension fetches tabs through a WebSocket that requires a valid token:

```typescript
createSyncExtension({
  url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
  loadToken: async () => authState.token ?? '',
})
```

No token, no data. The WebSocket handshake fails. The tab list stays empty.

## The server is the actual lock

The real security boundary is one layer deeper. Every API request hits Hono middleware that validates the token before the route handler ever runs:

```typescript
return createMiddleware(async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization') ?? undefined);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const user = await validateSession(token);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  c.set('user', user);
  return next();
});
```

`validateSession` calls the hub's `/auth/get-session` endpoint with the bearer token. The hub checks it against the database. Invalid token? 401. Expired? 401. The route handler never executes.

This is the architecture:

```
Browser Extension                         Server
─────────────────                         ──────

  AuthGate                                  Hono Middleware
  (UI relevance filter)                     (security boundary)
       │                                         │
       │  status === 'signed-in'?                 │  valid bearer token?
       │  yes → show UI                           │  yes → route handler
       │  no  → show login form                   │  no  → 401 Unauthorized
       │                                         │
       │  What spoofing gets you:                 │  What spoofing gets you:
       │  empty tables, broken fetches            │  nothing. rejected.
```

The auth gate is a relevance filter. The server middleware is the security boundary. They serve different purposes and that's fine.

## The gate exists because signed-out UI is useless

The reason we don't show the dashboard to unauthenticated users isn't security. It's that the dashboard is useless without data. You'd see a tab manager with no tabs, a chat interface that can't send messages, sync status indicators stuck on "disconnected." Showing that UI would be confusing, not dangerous.

The auth gate makes the same decision a good receptionist makes: you don't need to see the conference room if you're not in the meeting. It's not locked because of secrets; it's closed because it's not relevant to you.

## The token does the real work

Our `checkSession` validates the cached token against the server on every mount:

```typescript
async checkSession() {
  const token = authToken.current;
  if (!token) {
    phase = { status: 'signed-out' };
    return Ok(null);
  }

  const { data, error: sessionError } = await client.getSession();

  if (sessionError) {
    const isAuthRejection = sessionError.status && sessionError.status < 500;
    if (!isAuthRejection) {
      // Network error or 5xx → trust cached user (offline-first)
      const cached = authUser.current;
      phase = cached ? { status: 'signed-in' } : { status: 'signed-out' };
      return Ok(cached);
    }
    // 4xx → server explicitly rejected the token
    await clearState();
    phase = { status: 'signed-out' };
    return Ok(null);
  }
  // ... validated, set signed-in
}
```

The token is stored in `chrome.storage.local` (extension-scoped, not accessible to web pages), attached as a Bearer header on every request, and validated server-side on every API call. The reactive `status` variable is just the UI's reflection of that validation. It's derived from real auth state, not the other way around.

## The mental model

Client-side auth gates in SPAs are UX, not security. They prevent flicker and hide irrelevant interfaces. The security lives at the API layer, where every request is validated against real credentials. If someone bypasses the gate, they get an empty shell and a wall of 401s. The data never leaves the server without a valid token.
