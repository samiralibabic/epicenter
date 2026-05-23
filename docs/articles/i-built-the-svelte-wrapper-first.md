# I Built the Svelte Wrapper First

**TL;DR**: **Build the imperative core first, then wrap it in Svelte.** If you're reaching for a framework adapter before the framework-free layer exists, the wrapper will be load-bearing:and you'll end up with two reactive layers touching at a seam.

---

I realized I had made a Svelte-specific version. I knew it was a smell, because I was calling `$effect` just to track `auth.token`:

```svelte
$effect(() => {
  auth.token;     // touched, not used:wake signal
  sync.reconnect();
});
```

The fact that I was touching a reactive value purely for its tracking side effect suggested to me that what I actually wanted was an imperative subscription:

```ts
auth.onTokenChange(() => sync.reconnect());
```

And the reason that API didn't exist was that I'd been building Svelte wrappers on top of Svelte getters:two framework-shaped layers stacked. The fix wasn't another Svelte layer. I needed an imperative core first, in plain JavaScript, with `onTokenChange`, `onSessionChange`, `onLogin`, `onLogout`. Then the Svelte version wraps that core in ten lines. You can't just go wrap the Svelte one immediately when the Svelte one is what caused the smell.

Here's how I got there.

## The original setup

`attachSync` has an imperative surface: `setToken(token)`, `reconnect()`, `goOffline()`. After you call it, you own the glue between your auth layer and these methods.

For the workspace sync, that glue lived in a Svelte component:

```ts
const sync = attachSync(ydoc, {
  url: (docId) => websocketUrl(`${APP_URLS.API}/workspaces/${docId}`),
  requiresToken: true,
});

$effect(() => {
  sync.setToken(auth.token);
  sync.reconnect();
});
```

That worked. Token changes, effect runs, connection restarts with fresh credentials.

Per-doc syncs never got this treatment. Each editor mounted a doc, called `attachSync`, and nobody wired up token rotation. The connection would use whatever token existed at mount time and coast from there. Fine for short sessions. Silent failure if you left a tab open across a token refresh.

The fix seemed obvious: add the same `$effect` to every per-doc call site. But having to remember to add three lines of token plumbing at every call site isn't a fix:it's a convention waiting to be forgotten.

## First sketch: a `AuthSource` config option

I drafted an API where `attachSync` would accept a `authSource` on the config:

```ts
type AuthSource = {
  get: () => string | null;
  subscribe: (fn: () => void) => () => void;
};

attachSync(ydoc, {
  url: (docId) => websocketUrl(`.../${docId}`),
  authSource: {
    get: () => auth.token,
    subscribe: (fn) => {
      return effect(() => { auth.token; fn(); });
    },
  },
});
```

The primitive would poll `get()` on each connect attempt and use `subscribe` as a wake signal when a new token arrived.

This was better than manual `setToken` call sites. But I'd just invented a mini observable interface:and immediately filled it with Svelte-specific implementation. I was writing a framework-agnostic type (`AuthSource`) and then leaking the framework in through the back door. The boundary between "framework-free config" and "Svelte plumbing" was already dissolving before I finished the first draft.

## The `AuthSource` dead-end

The deeper issue: `AuthSource` was a patch over the real problem. The real problem was that `auth` had no subscription API at all. Without `onTokenChange`, every consumer:sync, logger, analytics, whatever:would end up doing the same `auth.token;` bare-read trick inside their own `$effect`. Each one would invent a slightly different version of the same workaround.

`AuthSource` would have moved the symptom from call sites into config. It wouldn't have fixed the cause.

## Second sketch: collapse to a closure

I looked harder at what the supervisor loop inside `attachSync` actually does. On every connect iteration, it reads `currentToken`:a slot updated by `setToken`. The primitive was already re-reading the token on every reconnect. `setToken` wasn't teaching the internals anything new; it was just updating a variable.

If the primitive re-reads anyway, I don't need a push mechanism at all for the common case. I just need the URL factory to encode the current token:

```ts
attachSync(ydoc, {
  url: (docId) => {
    const token = auth.token;       // re-read on every connect attempt
    if (!token) return null;        // null = park, don't connect
    return websocketUrl(`.../${docId}?token=${token}`);
  },
});
```

Returning `null` from `url` tells the supervisor to park:stop retrying until something wakes it. No token, no connection, no noise in the logs.

Now workspace and per-doc sync are structurally identical:

```ts
// workspace sync
const sync = attachSync(ydoc, {
  url: (docId) => {
    const token = auth.token;
    if (!token) return null;
    return websocketUrl(`${APP_URLS.API}/workspaces/${docId}`);
  },
  waitFor: idb.whenReady,
  awareness: awareness.raw,
});

// per-doc sync:same pattern
const sync = attachSync(ydoc, {
  url: (docId) => {
    const token = auth.token;
    if (!token) return null;
    return websocketUrl(`${APP_URLS.API}/docs/${docId}`);
  },
  waitFor: idb.whenReady,
});
```

The asymmetry was gone. Both call sites read the token at connect time. Both park when the token is null.

But there was still one gap. If the token rotates while a connection is alive, the next reconnect picks up the new token:but only on the next reconnect. The workspace case wanted fast propagation: rotate token, drop the old connection, open a new one immediately. So I'd add one line:

```ts
$effect(() => {
  auth.token;
  sync.reconnect();
});
```

And I looked at that line and stopped. That's the same smell I started with. I hadn't solved it:I'd just moved it.

## The seam

`auth.token` on a line by itself, value thrown away, purely to tell the tracker to re-run. I was using reactivity as a notification channel.

The version I actually wanted was:

```ts
auth.onTokenChange(() => sync.reconnect());
```

Plain prose. Works in Node, a test, a CLI. No framework required. The intent is explicit.

`auth.onTokenChange` didn't exist. `auth` only exposed reactive getters:`token`, `session`, `isLoggedIn`. If you wanted to react to a change, you used a Svelte `$effect` and touched the getter to establish tracking.

I was building a Svelte adapter on top of a Svelte-shaped auth layer. Two reactive layers at a seam:

```
┌──────────────────────────────┐
│   Svelte-shaped auth layer   │  ← $state, $derived, reactive getters only
│   (auth.token, auth.session) │
└──────────────┬───────────────┘
               │
               │  ← seam: read auth.token to register tracking
               │
┌──────────────▼───────────────┐
│   Svelte-shaped sync glue    │  ← $effect(() => { auth.token; reconnect() })
└──────────────────────────────┘
```

A better adapter wouldn't fix this. Pushing framework-free semantics one level deeper would.

## The fix: an imperative core

What auth needed at its foundation was a plain event emitter:

```ts
type AuthCore = {
  loadToken: () => string | null;
  getSession: () => Session | null;
  onTokenChange: (fn: (next: string | null, prev: string | null) => void) => () => void;
  onSessionChange: (fn: (next: Session | null, prev: Session | null) => void) => () => void;
  onLogin: (fn: (session: Session) => void) => () => void;
  onLogout: (fn: () => void) => () => void;
};
```

No Svelte. No `$state`. Just: here's how you get the current value, here's how you subscribe to changes. Works anywhere.

The Svelte `createAuth()` becomes a thin wrapper:subscribe to core events, mirror values into `$state` boxes:

```ts
function createAuth(core: AuthCore) {
  let token = $state(core.loadToken());
  let session = $state(core.getSession());

  core.onTokenChange((next) => { token = next; });
  core.onSessionChange((next) => { session = next; });

  return {
    get token() { return token; },
    get session() { return session; },
    get isLoggedIn() { return session !== null; },
  };
}
```

About ten lines. The reactive getters are a projection of the core. The wrapper adds no logic.

Once the core is imperative, every consumer wires up directly:

```ts
// ❌ before: framework plumbing pretending to be code
$effect(() => {
  auth.token;
  sync.reconnect();
});

// ✅ after: reads like prose
authCore.onTokenChange(() => sync.reconnect());
```

```ts
// ❌ before: manual prev-value tracking
let prevSession: Session | null = null;
$effect(() => {
  const next = auth.session;
  if (next?.id !== prevSession?.id) {
    handleSessionChange(next, prevSession);
  }
  prevSession = next;
});

// ✅ after: subscription carries prev for you
authCore.onSessionChange((next, prev) => {
  handleSessionChange(next, prev);
});
```

The previous-value boilerplate disappears because the subscription passes `prev`. The reactive-touch pattern disappears because there's nothing to track:just a callback.

The final layering looks like this:

```
┌────────────────────────────────┐
│      Framework-free core       │  ← loadToken(), onTokenChange(), onLogin()
│      (plain event emitter)     │
└──────────┬─────────────────────┘
           │
     ┌─────┴──────────────┐
     │                    │
     ▼                    ▼
┌─────────────┐     ┌───────────────────────┐
│ Svelte wrap │     │   attachSync, logger,  │
│ (~10 lines) │     │   analytics, tests     │
│ $state boxes│     │   (all imperative)     │
└─────────────┘     └───────────────────────┘
```

## Where `attachSync` lands

The `url` closure handles the token-at-connect case. The imperative core handles fast rotation. The `attachSync` API itself doesn't change:

```ts
// workspace sync:url closure for token-at-connect
const sync = attachSync(ydoc, {
  url: (docId) => {
    const token = authCore.loadToken();
    if (!token) return null;
    return websocketUrl(`${APP_URLS.API}/workspaces/${docId}`);
  },
  waitFor: idb.whenReady,
  awareness: awareness.raw,
});

// fast rotation for workspaces:one explicit line
authCore.onTokenChange(() => sync.reconnect());

// per-doc sync:identical url pattern, no extra wiring
const sync = attachSync(ydoc, {
  url: (docId) => {
    const token = authCore.loadToken();
    if (!token) return null;
    return websocketUrl(`${APP_URLS.API}/docs/${docId}`);
  },
  waitFor: idb.whenReady,
});
```

Workspace and per-doc are now structurally identical. The one behavioral difference:workspaces reconnect fast on token change:is a single line of explicit wiring, not a hidden convention.

## Trade-offs

| Approach | Works without Svelte | Carries prev value | Call-site ceremony |
|---|---|---|---|
| `$effect` touch-to-track | No | No:manual `prevSession` | Low |
| `AuthSource` wrapper | Depends on impl | No | Medium |
| Imperative core + Svelte wrapper | Yes | Yes | Low |

The imperative core costs a bit more upfront:you're writing an event emitter instead of just exposing `$state`. That pays back immediately in every non-Svelte consumer: tests, Node scripts, the CLI, anything that needs to react to auth state without a component tree.

The one thing you give up is Svelte's automatic dependency tracking for complex derived values. If you have a computed value that chains three reactive sources, `$derived` expresses that more cleanly than manually subscribing to three events. My rule: reactive getters for UI consumption, imperative callbacks for cross-cutting effects. Auth state qualifies as a cross-cutting effect.

## The pattern generalizes

When you reach for a framework-specific adapter and the code looks wrong, run this check:

1. Is the layer I'm adapting also framework-specific?
2. If so:does it need to be?

Two framework-shaped layers at a seam usually means one of them is carrying framework-specific concerns it doesn't actually own. Auth doesn't need to be Svelte-native. It needs to be correct. Svelte is a delivery mechanism. The core can be vanilla; the wrapper handles the delivery.

> **The Golden Rule**: Make the core imperative. Make the Svelte layer a projection. If you're reading a value purely to register tracking, you've found the seam where a subscription belongs.

---

*The `attachSync` redesign is tracked in the codebase. The sibling article in this directory covers the reactive-touch smell in more detail.*
