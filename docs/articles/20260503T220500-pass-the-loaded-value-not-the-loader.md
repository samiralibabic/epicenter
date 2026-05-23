# Pass the Loaded Value, Not the Loader

If your factory takes a thing-that-loads and one of its first acts is to await it, you have built a factory with a sync surface and an async interior. That seam costs you bookkeeping: a "did we finish loading yet" flag, a nullable cleanup handle, a deferred to escape if someone disposes mid-load, and a public "wait for me" promise. None of those exist if the caller does the loading and passes the loaded value in.

```ts
// Before: factory takes a loader, hides the await
function createThing({ storage }: { storage: { load(): Promise<T>, save(v: T): void } }) {
    let value: T | null = null;
    let ready = false;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const whenReady = (async () => {
        value = await storage.load();
        if (disposed) return;
        ready = true;
        cleanup = subscribe((next) => { /* if (disposed) return; */ });
    })();

    return {
        get value() { return value; },
        whenReady,
        [Symbol.dispose]() { disposed = true; cleanup?.(); },
    };
}

// After: caller loads, factory takes the loaded value
function createThing({ initialValue, save }: { initialValue: T, save: (v: T) => void }) {
    let value = initialValue;
    const cleanup = subscribe((next) => { value = next; save(next); });
    return {
        get value() { return value; },
        [Symbol.dispose]() { cleanup(); },
    };
}
```

Same observable behavior. Half the code. No flags, no nullable handle, no deferred, no `whenReady` on the public type. The async window the bookkeeping was guarding does not exist anymore, because there is no async window inside the factory.

## The bookkeeping is the receipt for sync-construction-with-async-init

When init is async but the factory returns synchronously, the returned object enters the world in a half-built state. Every method on it has to consider "what if I am called before init finishes" or "what if I am disposed before init finishes." That gives you four guards across four methods, plus a deferred to unblock awaiters of the readiness promise when dispose lands first. You did not write that complexity for fun. You wrote it because the factory took on a job (loading) that the caller could have done.

## "Maybe async" inputs are the worst kind

A `MaybePromise<T>` parameter (load returns either a value or a promise) is a tax on every consumer. The factory has to await it unconditionally because it does not know which case it got. The async-window bookkeeping is there even when the actual implementation is synchronous. You pay the cost of the worst case in every case.

Hoisting changes the calculus. The caller knows whether their storage is sync or async, and reacts accordingly:

```ts
// Sync source: no await, no boot ceremony
const initialValue = state.get();
const thing = createThing({ initialValue, save: state.set });

// Async source: caller awaits at boot, then constructs
const initialValue = await keychain.load();
const thing = createThing({ initialValue, save: keychain.save });
```

The factory does not branch. The caller is honest about which world they are in. The async-only callers pay the await once, at boot, in the place that already has an async context.

## Render-gating handles the rest

The argument for sync construction is usually "I want to export the thing from a module so UI components can read it without awaiting." That argument still holds after hoisting. The async loaders that cannot be made sync (keychain, IndexedDB, network) need exactly one render-gate at the app shell:

```svelte
{#await app.idb.whenLoaded}
  <Loading />
{:then}
  {@render children()}
{:catch error}
  <ErrorState {error} />
{/await}
```

The gate already has to exist for everything else the app needs at boot (CRDT hydration, indexedDB, network handshake). Auth join the queue. The gate is the right layer for "wait until startup is done", not the inside of every factory that participates in startup.

## The test

Look at the lets and consts at the top of your factory. Are any of them lifecycle bookkeeping? A boolean for "init done", a nullable for "cleanup not yet registered", a deferred for "let awaiters escape on early teardown"? If yes, the factory is owning an async step that does not belong to it. Move the await up. Most of the bookkeeping evaporates.

The bigger lesson: a function's parameter list is also its claim about when work happens. `storage: { load, save }` says "I will do the loading inside me." `{ initialValue, save }` says "you have already loaded; I just keep going." The second form is almost always the one that scales.
