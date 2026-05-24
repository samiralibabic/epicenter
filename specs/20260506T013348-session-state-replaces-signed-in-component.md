# Session state replaces the `<SignedIn>` component

> Apps consume one read API: `session.current`. A shared `createSession`
> factory owns lifecycle, refuses live user switching, and lets each app
> define what its signed-in payload is.

**Date**: 2026-05-06
**Status**: Implemented; descendant access superseded by `20260507T080000-drop-context-module-helper.md`
**Author**: AI-assisted, grounded against DeepWiki (Svelte 5, Better Auth), existing specs in `specs/`, and codebase articles in `docs/articles/`.
**Generalizes**: `20260506T010807-signed-in-owns-the-workspace.md` (fuji-only) into a pattern that lands across fuji, honeycrisp, zhongwen via a shared factory.
**Current shape**: `createSession` and `session.current` remain the canonical lifecycle model. The per-app `SignedInSessionProvider`, `createContext`, `setSignedInSession`, and `FujiSignedInSession` details below are historical. Current code exposes a module-level `getSignedInSession()` helper from each app's `session.svelte.ts`, and the signed-in payload owns app-specific reactive views directly.
**Branch**: feat/encrypted-local-workspace-storage

## One-sentence thesis

```txt
Each app exports one `session` whose `.current` is a discriminated union;
the signed-in variant carries identity and an app-defined payload (workspace
plus anything else attached to identity); live user switching is refused
with a hard reload.
```

## Why this draft exists

First draft proposed passing the live `$state` proxy through context. Two
grills found that breaks the unmount race defense. Second draft fixed that
with a prop boundary. Third pass replaced the prop-d.v reliance with a
plain const capture inside the Provider (see "Capture pattern"); the prop
still exists for narrowing, but no read of it survives past mount. Three
more collapses emerged along the way:

1. **The cell wrapper was an implementation detail leaking through.**
   `session.session.status` was bad. `session.current.status` is the right
   shape.

2. **Re-exposing `signOut` on the session was redundant.** Actions live on
   `auth`. Session is read-only.

3. **Live user-switching costs more than it pays.** Refuse it: dispose old
   workspace, `location.reload()`. Local-first encrypted apps want this
   anyway, because mixing two users' decrypted state is exactly the bug
   class encryption defends against.

The result is one shared factory, one read API, and per-app session
modules that are config objects.

## What is wrong today

Three near-identical files repeat the same compensating dance:

```txt
apps/fuji/src/routes/(signed-in)/components/SignedIn.svelte
apps/honeycrisp/src/routes/(signed-in)/components/SignedIn.svelte
apps/zhongwen/src/routes/(signed-in)/components/SignedIn.svelte
```

Each does five things:

```ts
// 1. Type-narrow with a runtime throw the parent layout makes unreachable.
if (auth.state.status !== 'signed-in') throw new Error('...');

// 2. Snapshot identity into local $state to survive the unmount frame.
const initialIdentity = auth.state.identity;
let identity = $state(initialIdentity);

// 3. Construct workspace eagerly with the snapshotted identity.
const fuji = openFuji({ identity: initialIdentity, peer, bearerToken });

// 4. Mirror auth.state.identity into the snapshot AND apply rotated keys.
$effect(() => {
  if (auth.state.status === 'signed-in') {
    identity = auth.state.identity;
    fuji.encryption.applyKeys(auth.state.identity.encryptionKeys);
  }
});

// 5. Set context with stable getters.
setSignedIn({ get identity() { return identity }, get fuji() { return fuji } });
```

Three mirror cells. One source of truth (auth.state). The mirrors only exist
because the layout cannot prove to TypeScript that the workspace exists
exactly when the user is signed in.

## Is this just renaming `<SignedIn>` to `<SignedInSessionProvider>`?

Reasonable question. Structurally, the new Provider is still a wrapper
component that captures workspace state and exposes it via context. The
file even has roughly the same shape. But the jobs it owns are different:

```txt
JOB                           OLD <SignedIn>             NEW <SignedInSessionProvider>
─────────────────────────     ─────────────────────      ─────────────────────────────
1. runtime auth.state check   yes (throw on mismatch)    no (layout {#if} narrows)
2. snapshot identity          yes ($state mirror cell)   no (plain const capture)
3. build workspace            yes (openFuji at mount)    no (createSession.build)
4. mirror auth → snapshot     yes ($effect)              no (createSession transition)
5. apply rotated keys         yes (in $effect)           no (reload on identity change)
6. set context                yes (setSignedIn)          yes (setSignedInSession)
7. derive reactive views      no (lived in state/*.ts)   yes ($derived in component)
```

Five jobs become two. Lifecycle moves out of components and into a
module-level state machine. Narrowing moves to the layout. The Provider's
remaining responsibilities are: capture the prop, derive views, set
context. That's it.

You could ask "why not keep `<SignedIn>` and just split out createSession?"
The answer: nothing technical stops you. The renames (SignedIn →
SignedInSessionProvider, signed-in.ts → signed-in-session.ts) are
ergonomic, not architectural. They signal that this component no longer
owns lifecycle. If you prefer to keep the old name, you'd ship the same
behavior with worse vocabulary.

## One-sentence test

Today:

```txt
"In Fuji, the workspace exists exactly when a user is signed in,
 OR a parent component happens to be mounted."
```

After this spec:

```txt
"In Fuji, the workspace is a field of session.current's signed-in variant."
```

No "or."

## Architecture (one factory, one read API)

```txt
   auth (better-auth, @epicenter/auth)
        │  emits AuthState via onStateChange
        ▼
┌────────────────────────────────────────────────────────────┐
│  createSession (shared, @epicenter/svelte)                 │
│                                                            │
│  Inputs (per app):                                         │
│    auth        the AuthClient                              │
│    build       (identity) → SignedIn payload               │
│                                                            │
│  Owns:                                                     │
│    - one $state cell of Session<TSignedIn>                 │
│    - the auth.onStateChange subscription                   │
│    - initial-state replay after subscribe                  │
│    - atomic transition writes                              │
│    - the identity-change refusal (location.reload)         │
│                                                            │
│  Exposes:                                                  │
│    get current(): Session<TSignedIn>                       │
│    [Symbol.dispose](): void                                │
└────────────────────────────────────────────────────────────┘
        │  per-app config
        ▼
┌────────────────────────────────────────────────────────────┐
│  apps/<app>/src/lib/session.svelte.ts                      │
│                                                            │
│  ~10 lines:                                                │
│    type AppSignedIn = { identity, fuji, [Symbol.dispose] } │
│    export const session = createSession<AppSignedIn>({     │
│      auth,                                                 │
│      build: (identity) => buildAppSignedIn(identity),      │
│    });                                                     │
└────────────────────────────────────────────────────────────┘
        │  session.current
        ▼  (read in template scope)
┌────────────────────────────────────────────────────────────┐
│  routes/+layout.svelte    NARROWING POINT                  │
│                                                            │
│  {#if session.current.status === 'pending'}  <Loading />   │
│  {:else if signed-out}    <SignInPage />                   │
│  {:else}                                                   │
│    <WorkspaceGate pending={signedIn.fuji.idb.whenLoaded}>  │
│      <SignedInSessionProvider signedIn={current.signedIn}>    │
│        {@render children?.()}                              │
│      </SignedInSessionProvider>                               │
│    </WorkspaceGate>                                        │
│  {/if}                                                     │
└────────────────────────────────────────────────────────────┘
        │  signedIn passed as prop (PROP BOUNDARY)
        ▼
┌────────────────────────────────────────────────────────────┐
│  SignedInSessionProvider     SNAPSHOT OWNER (per app)         │
│                                                            │
│  let { signedIn, children } = $props();                    │
│  const captured = signedIn;  // read prop ONCE, plain JS   │
│                                                            │
│  // App-specific reactive views.                           │
│  // $derived works in component scope.                     │
│  const entriesMap = fromTable(captured.fuji.tables.entries)│
│  const active  = $derived([...entriesMap.values()]         │
│    .filter(e => e.deletedAt === undefined));               │
│                                                            │
│  setSignedInSession({                                      │
│    ...captured,                                            │
│    entries: { get active() { return active }, ... },       │
│  });                                                       │
└────────────────────────────────────────────────────────────┘
        │  context lookup
        ▼
┌────────────────────────────────────────────────────────────┐
│  descendants                                               │
│                                                            │
│  const signedIn = getSignedInSession();                    │
│  {#each signedIn.entries.active as entry (entry.id)}...    │
└────────────────────────────────────────────────────────────┘
```

Each layer answers one question:

```txt
createSession           when does signed-in exist? (lifecycle)
session.svelte.ts       what is the signed-in payload for this app?
+layout.svelte          can TypeScript prove it right now? (narrowing)
SignedInSessionProvider    capture stability across destroy + add reactive views
descendants             what does the user see?
```

## Capture pattern (the actual race defense)

The race we have to defend against:

```txt
T0  signedIn mutates to undefined (auth flips to 'signed-out')
T1  layout {#if} flips, Provider begins unmounting
T2  during teardown frame, descendants may read getSignedInSession()
T3  Provider fully unmounted; SignInPage mounts
```

Between T1 and T3, descendants must not throw or see undefined.

The defense is a **plain JavaScript const inside the Provider**. Not a
prop signal, not `$state.snapshot`, just a captured reference:

```svelte
<script>
  let { signedIn, children } = $props()
  const captured = signedIn          // plain JS variable
  setSignedInSession({               // context closes over `captured`
    ...captured,
    entries: { ... }                 // $derived reads `captured`, not the prop
  })
</script>
```

Why this works:

- `signedIn` is read exactly once, at Provider mount, into a const.
- The context value closes over `captured`, which is a plain variable.
- Descendants reading `getSignedInSession()` walk a closure, not a signal.
- No prop signal participates in any read after the first line.

This sidesteps Svelte's teardown semantics entirely. The spec's earlier
draft relied on Svelte 5 caching prop reads during destroy
(`packages/svelte/src/internal/client/reactivity/props.js`, returning
`d.v` when `is_destroying_effect` is set). That behavior is real and
deliberate, but it's an implementation detail without an API guarantee.
Plain capture removes the dependency.

Mutation lives in the module-level `signedIn` $state cell inside
`createSession`. The captured reference is plain data below it. The
two are decoupled at the moment the const is assigned.

### Why not `$state.snapshot`?

Tempting, but wrong tool. `$state.snapshot` uses `structuredClone`
under the hood. The signed-in payload contains:

```txt
fuji {
  actions          // functions
  encryption       // class instance
  idb              // Y.IndexedDB handle
  tables           // SvelteMap / Y.Map
  [Symbol.dispose] // function
}
```

`structuredClone` cannot clone any of these; it preserves references and
emits `state_snapshot_uncloneable` warnings in dev. We don't want a clone
anyway: the workspace is the live thing we're trying to expose.

Plain const capture is what we want: keep the same object reference,
freeze who points at it (this Provider scope), let descendants reach it
through a closure.

## Asymmetric refusals

```txt
Refusal 1: per-app SignedIn.svelte wrappers
  Deletes:
    apps/fuji/src/routes/(signed-in)/components/SignedIn.svelte         (~50 LOC)
    apps/honeycrisp/src/routes/(signed-in)/components/SignedIn.svelte   (~60 LOC)
    apps/zhongwen/src/routes/(signed-in)/components/SignedIn.svelte     (~50 LOC)
  Replaces:
    one shared createSession factory (~70 LOC) plus per-app config
    (~10 LOC) plus thin per-app SignedInSessionProvider (~25 LOC).
  Net: ~160 LOC out, ~165 LOC in, but the in is one factory shared across
  three apps; the out was three copies of the same dance.

Refusal 2: per-app signed-in.ts ad-hoc context
  Deletes:
    apps/{fuji,honeycrisp,zhongwen}/src/routes/(signed-in)/signed-in.ts (~33 LOC)
  Replaces:
    Per-app context defined inside SignedInSessionProvider; type extends the
    shared SignedInBase contract.

Refusal 3: per-app reactive-views modules
  Deletes (where they exist):
    apps/fuji/src/routes/(signed-in)/state/entries.svelte.ts
    apps/honeycrisp/src/routes/(signed-in)/state/folders.svelte.ts
    apps/honeycrisp/src/routes/(signed-in)/state/notes.svelte.ts
    apps/honeycrisp/src/routes/(signed-in)/state/index.ts
  Replaces:
    Reactive views move into the per-app SignedInSessionProvider (component
    scope provides $derived tracking; views' lifetime equals the scope's).
  User loss: createEntry() bundle splits into two lines at click site
            (fuji.actions.entries.create() + goto()).

Refusal 4: identity snapshot dance
  Deletes:
    let initialIdentity = auth.state.identity
    let identity = $state(initialIdentity)
    $effect(() => { ... mirror ... })
  Replaces:
    Plain const capture inside SignedInSessionProvider:
      const captured = signedIn
    The const is fixed for the lifetime of the Provider mount.
    No mirroring is needed because identity changes mid-session reload
    the page (see Refusal 5), so the captured reference is always
    current for the lifetime of the Provider mount.

Refusal 5: in-place identity mutation (the asymmetric win)
  Deletes:
    - The applyKeys hook on createSession.
    - The same-user-rotation branch in next()/reconcile.
    - Per-app applyKeys config in every session module.
    - fuji.encryption.applyKeys() (no remaining caller after the factory
      drops it; verified during Wave 0).
  Replaces:
    One reconcile rule: any identity change after open = dispose + reload.
  User loss: A mid-session identity mutation (user switch, key rotation,
            or future profile edit) is now ~1 second of full page reload
            instead of an in-place update. For local-first encrypted apps
            this is the desired behavior anyway: it guarantees no stale
            handles, no leaked state, no decrypted-A bytes lingering near
            decrypted-B bytes.
  Justification: this is the dominant SPA pattern. Clerk uses
            <Fragment key={sessionId}> to remount the entire subtree
            on session change; Supabase recommends storage cleanup on
            SIGNED_OUT and treats new SIGN_IN as a clean slate; BFF
            stacks reload by construction. No major SPA provider
            recommends in-place identity mutation. See "Why we don't
            apply keys in place" below.
  Note: this refusal is BAKED INTO createSession. Apps that need live
        identity mutation cannot use this factory. That is a feature:
        the constraint is visible at the import site.

Refusal 6: re-exposing auth.signOut on the session
  Deletes:
    Any session.signOut() method.
  Replaces:
    Components import auth directly for actions (auth.signOut(), etc.).
    Session is purely a read API.
  User loss: components that need both must import both. Acceptable;
            naming the dependency in the import is honesty.
```

## Why we don't apply keys in place

A previous draft of this spec carried an `applyKeys` hook so that same-user
key rotation could update the workspace without remounting. We removed it.
This section records why.

### What an earlier version did

```ts
// REMOVED. See Refusal 5.
applyKeys: (signedIn, identity) =>
  signedIn.fuji.encryption.applyKeys(identity.encryptionKeys);
```

The factory branched on `prev.signedIn.identity.user.id === a.identity.user.id`
and, on match, called `applyKeys` and reassigned `signedIn` with the new
identity but the same `fuji` reference. The intent was to avoid a flicker
on key rotation.

### Why the branch never legitimately fires today

Better Auth's nanostore (`packages/auth/src/create-auth.ts:143`) short-circuits
benign re-emits via `sessionsEqual`, which compares both `user.id` and
`encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)`. The
`onStateChange` listener is only invoked when the session response actually
differs. Same-user key rotation would fire it, but in practice Better Auth
does not rotate keys mid-session today. The branch is defensive design for
a hypothetical, not a path the code currently exercises.

That alone would not justify deletion. What does justify it is the next
section.

### What the SPA ecosystem recommends

Across every major auth provider in 2026, the pattern for downstream
resources tied to an auth identity is the same: do not mutate them in
place when the identity changes. Either lazily re-read the token at point
of use (Supabase, Auth0 SPA SDK, Better Auth's nanostore consumers), or
remount the resource subtree (Clerk's `<MultisessionAppSupport>` wraps the
app in `<Fragment key={session?.id ?? 'no-users'}>` and forces React to
discard and rebuild on session change). BFF stacks reload by construction.

```txt
PROVIDER          KEY ROTATION (same user)         IDENTITY CHANGE (different user)
─────────         ──────────────────────────       ─────────────────────────────────
Clerk             do nothing; lazy read token      <Fragment key={sessionId}> remount
Supabase          background refresh; lazy read    SIGNED_OUT cleanup, fresh SIGN_IN
Better Auth       sessionsEqual short-circuits     downstream consumers re-read
WorkOS / BFF      cookie refresh transparent       redirect / page reload
Auth0 SPA         silent refresh in getToken       new client OR full reload
```

Sources: Clerk's MultisessionAppSupport docs; Supabase `onAuthStateChange`
guide; Better Auth session-management concepts; WorkOS AuthKit sessions;
Auth0 SPA SDK examples. None of them recommend an `applyKeys`-style
in-place mutation on a sibling resource.

### The deeper invariant

`applyKeys` was a defensive mechanism compensating for a missing invariant
one layer up. The missing invariant is: **identity is owned by the auth
client; downstream resources observe it, they do not store rotated copies
of it.** With that invariant, the entire same-user-rotation branch is
unnecessary; consumers either read identity lazily or get rebuilt on
identity change. With it absent, every long-lived resource that holds a
captured copy of identity needs its own `applyX` hook to stay in sync.
That is exactly the kind of repeated-defensive-check the
cohesive-clean-breaks principle says belongs at the boundary, not at every
downstream use.

The boundary that owns identity is `auth-svelte`. The factory does not
need to mediate identity updates for downstream resources; it only needs
to decide when those resources exist at all.

### What we do instead

One rule: identity changes mid-session reload the page. The reconcile
function has three cases (signed-out, no-scope-yet, scope-exists), and
the third compares identities and either no-ops on benign re-emits or
disposes and reloads on any mutation.

```ts
function reconcile(a: AuthState) {
  if (a.status !== 'signed-in') {
    if (signedIn) { signedIn[Symbol.dispose](); signedIn = undefined; }
    return;
  }
  if (!signedIn) { signedIn = build(a.identity); return; }
  if (identitiesEqual(signedIn.identity, a.identity)) return;
  signedIn[Symbol.dispose]();
  location.reload();
  throw new Error('unreachable: reload pending');
}
```

That is the entire transition logic. No applyKeys, no per-app
mutation hook, no parallel "is this a same-user update or a
different-user update?" branch.

### What this costs

If Better Auth ever does rotate encryption keys mid-session in a future
version (or if a profile edit emits a new identity for the same user),
that triggers a full reload instead of an in-place update. Acceptable
because:

1. It happens rarely.
2. It matches what every major SPA provider does on equivalent events.
3. The reload is ~1 second on local-first apps because IDB is already
   warm; the user reappears on the same URL with their workspace open.
4. The alternative is an `applyX` hook for every downstream resource
   that holds captured identity, which is exactly the design we're
   refusing.

If a future feature genuinely needs in-place identity mutation
(say, displayName changing in the header without reload), the right
answer is to make that one field a lazy read on `auth.identity`, not to
reintroduce a generic `applyKeys` hook.

## The `createSession` factory

```ts
// packages/svelte-utils/src/session.svelte.ts (NEW)
import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';
import { identitiesEqual } from '@epicenter/auth';

export type Session<TSignedIn> =
  | Exclude<AuthState, { status: 'signed-in' }>
  | { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
  readonly identity: AuthIdentity;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
  auth,
  build,
}: {
  auth: AuthClient;
  build: (identity: AuthIdentity) => TSignedIn;
}) {
  let signedIn = $state<TSignedIn | undefined>(undefined);

  function reconcile(a: AuthState) {
    if (a.status !== 'signed-in') {
      if (signedIn) {
        signedIn[Symbol.dispose]();
        signedIn = undefined;
      }
      return;
    }
    if (!signedIn) {
      signedIn = build(a.identity);
      return;
    }
    // Benign re-emit (auth refetched, identity unchanged): no-op.
    if (identitiesEqual(signedIn.identity, a.identity)) return;
    // Anything else (different user, rotated keys, any identity mutation):
    // dispose and reload. See "Why we don't apply keys in place."
    signedIn[Symbol.dispose]();
    location.reload();
    throw new Error('unreachable: reload pending');
  }

  const unsubscribe = auth.onStateChange(reconcile);
  // Initial replay: auth's atom may have already settled before this
  // listener registered. Synchronously seed from current state.
  reconcile(auth.state);

  return {
    get current(): Session<TSignedIn> {
      const a = auth.state;
      if (a.status !== 'signed-in') return a;
      // Invariant: reconcile runs synchronously inside onStateChange, so
      // signedIn is always set when auth is signed-in. Defensive fallback
      // keeps the type honest without an `!`.
      if (!signedIn) return { status: 'pending' };
      return { status: 'signed-in', signedIn };
    },
    [Symbol.dispose]() {
      unsubscribe();
      signedIn?.[Symbol.dispose]();
    },
  };
}
```

Four properties this provides:

1. **One owner**: status comes from `auth.state`; the factory holds only the signed-in payload.
2. **Initial replay**: handler runs once after subscribe with current auth state.
3. **One reconcile rule**: identity changes mid-session reload. No in-place mutation.
4. **Reactive projection**: `current` reads `auth.state` and `signedIn`; both are tracked, so consumers' `$derived(session.current)` re-runs on either.

## Per-app session module

```ts
// apps/fuji/src/lib/session.svelte.ts
import { createContext } from 'svelte';
import type { AuthIdentity } from '@epicenter/auth';
import { createSession, type SignedInBase } from '@epicenter/svelte/session';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from './auth';
import { openFuji, type Fuji } from '../routes/(signed-in)/fuji/browser';

export type FujiSignedIn = SignedInBase & {
  readonly fuji: Fuji;
};

function buildFujiSignedIn(identity: AuthIdentity): FujiSignedIn {
  const fuji = openFuji({
    identity,
    peer: {
      id: getOrCreateInstallationId(localStorage),
      name: 'Fuji',
      platform: 'web',
    },
    bearerToken: () => auth.bearerToken,
  });
  return {
    identity,
    fuji,
    [Symbol.dispose]() { fuji[Symbol.dispose](); },
  };
}

export const session = createSession<FujiSignedIn>({
  auth,
  build: buildFujiSignedIn,
});

if (import.meta.hot) {
  // Just dispose. Without an accept anywhere along the import chain, Vite
  // does a full page reload when auth.ts changes, which re-evaluates this
  // module cleanly. Adding hot.accept(['./auth'], () => {}) would be wrong:
  // it stops propagation but does NOT re-run this module, so the old
  // unsubscribe stays bound to the disposed auth client and the new auth
  // gets no listener.
  import.meta.hot.dispose(() => session[Symbol.dispose]());
}
```

About 25 lines. The signed-in payload is one type. The build hook is one
function. No subscription handling, no transition table, no HMR ceremony
beyond the two-line dispose+accept pair.

If a future feature needs to attach more than fuji to the signed-in scope
(billing, telemetry, an onboarding channel), it composes inside `build`:

```ts
function buildFujiSignedIn(identity: AuthIdentity): FujiSignedIn {
  const fuji = openFuji({ identity, ... });
  const billing = openBilling({ identity });
  return {
    identity,
    fuji,
    billing,
    [Symbol.dispose]() {
      billing[Symbol.dispose]();
      fuji[Symbol.dispose]();
    },
  };
}
```

`createSession` does not change. Each new attachment adds three lines:
declare it in the type, build it, dispose it. The factory is generic over
whatever the app needs alongside identity.

## Per-app `SignedInSessionProvider`

```svelte
<!-- apps/fuji/src/lib/components/SignedInSessionProvider.svelte -->
<script lang="ts">
  import { fromTable } from '@epicenter/svelte';
  import { onDestroy, type Snippet } from 'svelte';
  import type { FujiSignedIn } from '$lib/session.svelte';
  import { setSignedInSession } from '$lib/signed-in-session';

  let {
    signedIn,
    children,
  }: {
    signedIn: FujiSignedIn;
    children: Snippet;
  } = $props();

  // Plain const capture. Read the prop exactly once. Everything below
  // reads `captured`, never `signedIn`. See "Capture pattern" section.
  const captured = signedIn;

  // App-specific reactive views; $derived is legal in component scope.
  const entriesMap = fromTable(captured.fuji.tables.entries);
  const entriesActive = $derived(
    [...entriesMap.values()].filter((e) => e.deletedAt === undefined),
  );
  const entriesDeleted = $derived(
    [...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
  );

  setSignedInSession({
    ...captured,
    entries: {
      get: (id) => entriesMap.get(id),
      get active() { return entriesActive; },
      get deleted() { return entriesDeleted; },
    },
  });

  onDestroy(() => entriesMap[Symbol.dispose]());
</script>

{@render children()}
```

The context value spreads the signedIn payload and adds the reactive views.
Descendants bind once and dot-access:

```ts
const signedIn = getSignedInSession();
signedIn.identity.user.email;
signedIn.fuji.tables.entries;
signedIn.entries.active;
```

Don't destructure the return of `getSignedInSession()` (or any reactive
getter-backed object); destructuring freezes a snapshot at read time and
breaks reactivity for any later read in the same scope.

```ts
// apps/fuji/src/lib/signed-in-session.ts
import { createContext } from 'svelte';
import type { Entry, EntryId } from '../routes/(signed-in)/fuji/workspace';
import type { FujiSignedIn } from './session.svelte';

export type FujiSignedInSession = FujiSignedIn & {
  entries: {
    get: (id: EntryId) => Entry | undefined;
    readonly active: Entry[];
    readonly deleted: Entry[];
  };
};

const [getSignedInSessionRaw, setSignedInSessionInternal] =
  createContext<FujiSignedInSession>();

export const setSignedInSession = setSignedInSessionInternal;

export function getSignedInSession(): FujiSignedInSession {
  const session = getSignedInSessionRaw();
  if (!session) {
    throw new Error(
      '[fuji] getSignedInSession() called outside <SignedInSessionProvider>. ' +
      'This route must mount under the signed-in branch of the root layout.',
    );
  }
  return session;
}
```

The wrapper around `createContext` produces a useful error when consumers
mount outside the Provider (e.g., a route accidentally added outside the
signed-in branch). The grill flagged Svelte's default `missing_context`
error as too generic; this fixes it.

## Layout

```svelte
<!-- apps/fuji/src/routes/+layout.svelte -->
<script lang="ts">
  import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
  import { Toaster } from '@epicenter/ui/sonner';
  import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
  import { ModeWatcher } from 'mode-watcher';
  import Loading from '$lib/components/Loading.svelte';
  import SignedInSessionProvider from '$lib/components/SignedInSessionProvider.svelte';
  import { session } from '$lib/session.svelte';
  import { auth } from '$lib/auth';
  import SignInPage from './sign-in/SignInPage.svelte';
  import '@epicenter/ui/app.css';

  let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

{@const current = session.current}

{#if current.status === 'pending'}
  <Loading />
{:else if current.status === 'signed-out'}
  <SignInPage />
{:else}
  <WorkspaceGate
    pending={current.signedIn.fuji.idb.whenLoaded}
    onSignOut={() => auth.signOut()}
  >
    <SignedInSessionProvider signedIn={current.signedIn}>
      {@render children?.()}
    </SignedInSessionProvider>
  </WorkspaceGate>
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
```

The `{@const current = session.current}` reads the union once at the top of
the template. TypeScript narrows each branch. `auth.signOut` stays on auth.

## Lifecycle flows

```txt
Cold boot, signed-in user
─────────────────────────
1. session.svelte.ts evaluates createSession({ auth, build }).
2. signedIn = undefined; current projects auth.state (status: 'pending').
3. unsubscribe = auth.onStateChange(reconcile)
4. Initial replay: reconcile(auth.state). If auth has already settled:
   signedIn = build(identity).
5. +layout: signed-in branch renders.
6. WorkspaceGate awaits idb.whenLoaded.
7. SignedInSessionProvider mounts; context installed; children render.

Logout
──────
1. await auth.signOut() resolves.
2. better-auth atom updates session synchronously after the /sign-out
   API resolves: data → null, isPending → false. No setTimeout, no
   microtask delay (verified against better-auth source).
3. reconcile runs; signedIn[Symbol.dispose](); signedIn = undefined.
4. session.current projects auth.state ('signed-out').
5. Layout re-renders signed-out branch; SignInPage mounts.
6. Descendants reading getSignedInSession during teardown see the
   plain JS reference captured at Provider mount (see "Capture
   pattern" below). No signal participates in those reads, so
   teardown timing does not matter.

Identity change mid-session (rotated keys, displayName edit, user switch)
─────────────────────────────────────────────────────────────────────────
1. atom emits a new identity that differs from the captured one.
2. reconcile compares with `identitiesEqual`; not equal.
3. signedIn[Symbol.dispose](); location.reload();
4. Throws unreachable to satisfy the compiler.
5. Page reloads, cold-boot path runs with the new identity.

This is one rule for every identity-mutation case: same user with
rotated keys, same user with profile edits, different user. See
"Why we don't apply keys in place" below for the rationale.

HMR on session.svelte.ts
────────────────────────
1. Vite calls import.meta.hot.dispose.
2. session[Symbol.dispose](): unsubscribe() and dispose any live signedIn.
3. New module evaluates; fresh createSession; initial replay seeds
   from current auth.state.

HMR on auth.ts
──────────────
1. Vite calls auth.ts dispose: auth[Symbol.dispose]() (clears its
   stateChangeListeners set on the way out).
2. No module along the import chain calls hot.accept, so Vite does a
   full page reload.
3. Page reload re-evaluates everything: fresh auth, fresh session,
   fresh listener, fresh fuji built from initial-state replay.
4. Same UX cost as editing any other infrastructure file. Acceptable
   because auth.ts is rarely edited.

Direct nav to /entries/abc while signed-out
───────────────────────────────────────────
1. Layout mounts; auth.state = pending → <Loading />.
2. Auth resolves to signed-out.
3. session.current projects auth.state (signed-out); layout renders <SignInPage />.
4. Browser URL stays /entries/abc; SignInPage may replaceState to /sign-in
   for URL hygiene. The protected route never mounts.
```

## What changes per app

### Fuji

```txt
NEW:
  apps/fuji/src/lib/session.svelte.ts
  apps/fuji/src/lib/signed-in-session.ts
  apps/fuji/src/lib/components/SignedInSessionProvider.svelte

MODIFIED:
  apps/fuji/src/routes/+layout.svelte                 (uses session, WorkspaceGate)
  All callers of getSignedIn / getEntriesState        (use getSignedInSession;
                                                       inline createEntry as
                                                       fuji.actions.entries.create() + goto())

DELETED:
  apps/fuji/src/routes/(signed-in)/+layout.svelte
  apps/fuji/src/routes/(signed-in)/components/SignedIn.svelte
  apps/fuji/src/routes/(signed-in)/signed-in.ts
  apps/fuji/src/routes/(signed-in)/state/entries.svelte.ts
```

### Honeycrisp

```txt
NEW:
  apps/honeycrisp/src/lib/session.svelte.ts
  apps/honeycrisp/src/lib/signed-in-session.ts
  apps/honeycrisp/src/lib/components/SignedInSessionProvider.svelte

MODIFIED:
  apps/honeycrisp/src/routes/+layout.svelte
  All callers of getSignedIn / getHoneycrispState

DELETED:
  apps/honeycrisp/src/routes/(signed-in)/+layout.svelte
  apps/honeycrisp/src/routes/(signed-in)/components/SignedIn.svelte
  apps/honeycrisp/src/routes/(signed-in)/signed-in.ts
  apps/honeycrisp/src/routes/(signed-in)/state/folders.svelte.ts
  apps/honeycrisp/src/routes/(signed-in)/state/notes.svelte.ts
  apps/honeycrisp/src/routes/(signed-in)/state/index.ts
  (state/view.svelte.ts and search-params.svelte.ts stay; UI state, not workspace state)
```

### Zhongwen

```txt
NEW:
  apps/zhongwen/src/lib/session.svelte.ts
  apps/zhongwen/src/lib/signed-in-session.ts
  apps/zhongwen/src/lib/components/SignedInSessionProvider.svelte

MODIFIED:
  apps/zhongwen/src/routes/+layout.svelte
  All callers of getSignedIn

DELETED:
  apps/zhongwen/src/routes/(signed-in)/+layout.svelte
  apps/zhongwen/src/routes/(signed-in)/components/SignedIn.svelte
  apps/zhongwen/src/routes/(signed-in)/signed-in.ts
  (chat-state.svelte.ts stays; chat UI state, not workspace state)
```

### Shared

```txt
NEW:
  packages/svelte-utils/src/session.svelte.ts        (createSession factory)
  packages/svelte-utils/src/index.ts                 (export createSession, Session, SignedInBase)
```

## Wave ordering

```txt
Wave 0   Build the shared factory.
         Add packages/svelte-utils/src/session.svelte.ts with createSession,
         Session, SignedInBase. Add to index. Typecheck. No app uses it yet.

Wave 1   Fuji pilot.
         Build apps/fuji/src/lib/session.svelte.ts using createSession.
         Build SignedInSessionProvider and signed-in-session.ts.
         Both code paths exist; nothing imports new session yet.

Wave 2   Fuji: switch +layout.svelte to session-based gating.
         Migrate consumers to getSignedInSession.
         Inline createEntry as fuji.actions.entries.create() + goto().
         Old files still on disk, no longer imported.

Wave 3   Verify fuji (rollback point).
         - typecheck
         - manual smoke: cold boot signed-in, cold boot signed-out, sign in,
           sign out, identity-change reload (any same-user identity mutation
           or different-user switch produces a full reload), forget device,
           /sign-in direct nav while signed-in,
           /entries/[id] direct nav while signed-out, HMR on session.svelte.ts,
           HMR on auth.ts (verifies hot.accept).
         - auth failure mode tests:
             a. signOut while a workspace write is in flight: trigger a
                Y.IndexedDB write (e.g., create entry) and call signOut
                in the same tick. Assert no unhandled rejection, no
                write-to-disposed-handle error.
             b. signOut network failure: mock /sign-out to return 500.
                Assert session.current does NOT spuriously bounce to
                signed-out (atom should reflect actual better-auth
                behavior on error).
             c. HMR edit to session.svelte.ts while signed-in with
                descendants holding workspace refs: edit the file,
                wait for HMR, click around. Assert no error from
                stale workspace references. (If this fails, accept
                full reload on session.svelte.ts edits as a tradeoff.)
             d. Concurrent token refresh during render: trigger
                refresh while reading signedIn.fuji. Assert no flicker
                if better-auth briefly emits pending.
         If anything fails, the old files still exist; revert Wave 2 in one PR.

Wave 4   Delete fuji's old files.
         Final typecheck.

Wave 5   Repeat Waves 1 to 4 for honeycrisp.

Wave 6   Repeat Waves 1 to 4 for zhongwen.
```

Wave 0 is small (one shared file). Wave 3 is the hard rollback point.

## Tradeoffs (honest accounting)

**`createSession` bakes in the user-switch refusal.** Apps that need live
A→B without reload cannot use this factory. The refusal is visible at the
import site, not buried in app code. If a future multi-account UI app
appears, it writes its own state machine. Acceptable.

**Per-app `SignedInSessionProvider`, not shared.** Each app's reactive views
differ (entries for fuji; folders + notes for honeycrisp; nothing for
zhongwen). A shared component would force a generic over the workspace
type and the view shape, which is worse than ~25 lines per app. The shared
piece (`createSession`) is structural for lifecycle; the per-app Provider
is structural for views.

**Test fixtures are partial.** `<SignedInSessionProvider signedIn={fakeSignedIn}>`
fixtures the signed-in branch only. The `pending` and `signed-out` branches
read the module singleton via `session.current`. Tests for those branches
need `vi.mock('$lib/session.svelte', () => ({ session: { current: {...} } }))`.
Two test patterns, not one.

**Module-level singleton, SPA-only.** Each app has one session per page
load. SSR is not supported. None of the workspace apps are SSR'd.

**Reactive views recompute per Provider mount, not per consumer.** The
`$derived` inside `SignedInSessionProvider` runs once per change cycle and
is shared by all readers of `entries.active`. Same cost as today's
`state/entries.svelte.ts`, just colocated with the Provider that owns
their lifetime.

**HMR is "dispose only, full reload on auth edits."** Matches the existing
pattern in `apps/*/src/lib/auth.ts`. Full reloads on auth.ts edits are
acceptable because auth.ts is rarely edited. Editing session.svelte.ts
also full-reloads today; we may add `hot.accept()` self-accept after
Wave 3 smoke testing for faster iteration, but only after correctness
is proven. Adding `hot.accept(['./auth'], cb)` would be a bug: it stops
HMR propagation without re-running the module, leaving stale subscriptions
on a disposed auth client.

## Open questions

### Q1: `(signed-in)` route group?

Keep as a file-tree organization marker. Add a one-line README pointing to
`$lib/session.svelte.ts` for the gate.

### Q2: `goto('/sign-in')` redirect?

Lives inside `<SignInPage>` if URL hygiene matters. The layout renders
`<SignInPage />` directly when signed-out; URL stays at whatever the user
typed. SignInPage may `replaceState` to `/sign-in` after first paint.

### Q3: Generic `createSession` in @epicenter/svelte vs per-app duplication?

Extract the factory in Wave 0. The collapse from three near-identical state
machines to one factory + three configs is large and the per-app variance
is small (only the build closure differs).

### Q4: Should auth.ts construction move into session.svelte.ts?

Decided: keep separate. Auth.ts stays as a tiny module that constructs the
auth client; session.svelte.ts imports it. Editing auth.ts triggers a full
page reload via Vite's no-acceptor propagation rule, which re-evaluates
session cleanly. No `hot.accept` ceremony required. Co-location remains
available as a refactor if a future need (e.g., test injection of auth)
makes it useful, but no current concern justifies it.

## Final check (cohesive-clean-breaks)

```txt
Can I explain the new API without saying "or"?
  Yes. "session.current is the discriminated union; createSession owns
  lifecycle; descendants read getSignedInSession()."

Does one layer own each invariant?
  Yes:
    createSession             when signed-in exists; refusal of live switch
    per-app session config    what the signed-in payload is
    layout                    type-level proof at this moment
    SignedInSessionProvider      stability across destroy + reactive views
    descendants               UI policy

Would a new caller find only one obvious path?
  Yes. session.current to read; getSignedInSession() inside the scope.

Are examples free of compatibility shapes?
  Yes. Old SignedIn.svelte, signed-in.ts, state files are deleted.

Did I delete stale names instead of leaving aliases?
  Yes. SignedIn → SignedInSessionProvider. cell.session → session.current.
  Identity $state mirror → plain const capture. session.signOut →
  auth.signOut.

Did the file tree change to match the new ownership?
  Yes. session.svelte.ts and SignedInSessionProvider.svelte are new homes.
  createSession lives in @epicenter/svelte alongside WorkspaceGate.

Did I move the boundary that caused the smell, or only wrap it?
  Moved. Lifecycle is in a shared factory. Race defense is in Svelte's prop
  semantics. Atomicity is in single-cell writes. User switch is refused
  rather than handled.

Would mentally inlining each new helper make the code clearer?
  No. createSession is ~70 LOC of cohesive logic; SignedInSessionProvider
  owns view lifetime; getSignedInSession provides a useful error.
```

## References

- `apps/fuji/src/routes/(signed-in)/components/SignedIn.svelte` (today's lifecycle owner)
- `apps/honeycrisp/src/routes/(signed-in)/components/SignedIn.svelte`
- `apps/zhongwen/src/routes/(signed-in)/components/SignedIn.svelte`
- `packages/svelte-utils/src/workspace-gate/workspace-gate.svelte` (precedent for shared svelte primitives)
- `packages/svelte-utils/src/from-table.svelte.ts` (SvelteMap reactivity)
- `packages/auth/src/create-auth.ts` (auth.state and auth.onStateChange)
- `specs/20260506T010807-signed-in-owns-the-workspace.md` (predecessor; fuji-only)
- `specs/20260505T080000-auth-state-machine-and-gated-identity-context.md`
- `specs/20260423T064414-auth-core-package.md` line 237 (no `$effect.root` precedent)
- `docs/articles/your-spa-singleton-doesnt-need-effect-cleanup.md`
- `docs/articles/svelte-effect-root-hmr-pattern.md`
- DeepWiki: Svelte 5 unmount semantics, prop d.v caching, module-level $state mutation, $effect.root necessity
- DeepWiki: Better Auth signOut atom timing
- Two falsification grills run against the first draft, May 2026.
