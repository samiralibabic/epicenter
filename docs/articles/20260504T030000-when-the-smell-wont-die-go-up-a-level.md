# When the Smell Won't Die, Go Up a Level

When a code-smell removal still feels wrong, but the deeper violation feels even deeper, that off-feel is the signal. The local fix is going to leave the deeper thing alive. Go up a level. Ask what the surface code is compensating for, find the missing invariant, install it, and watch the surface evaporate.

The workspace identity reset spec went through four rounds of this. Each round added cleanups that the prior round left standing.

```
Round 1   drop the cold-null pause                        (1 smell)
Round 2   also drop the reset-path pause                  (2 smells)
Round 3   also drop the syncControl parameter,
          the SyncControl named base type,
          the BrowserWorkspace.syncControl field,
          and composeSyncControls                         (6 smells)
Round 4   dispose child document caches before parent
          teardown and drop the whenDisposed wait          (8 smells)
```

Round 1 was wrong scope. The cold-null `syncControl?.pause()` was a no-op, but the reset-path `syncControl?.pause()` was doing real work: synchronously closing the WebSocket before `await clearLocalData()` yielded, narrowing a microtask race. They looked the same and they weren't. "Delete both" was not yet a sound move. Round 3 found the actual missing invariant: there is no deterministic teardown. Round 4 found the missing first line inside that teardown: apps with cached child documents must dispose those caches before destroying the parent `ydoc`, otherwise IndexedDB deletion can block on open child connections and the reload never runs.

Once bundle disposal, `clearLocalData()`, and reload in `finally` become the canonical reset, the race the pause was narrowing does not exist. The pause has nothing to compensate for. Neither does the parameter that threaded it. Neither does the named type that aliased it. Neither does the field that exposed it. Neither does the fan-out helper that nobody had ever called. The explicit `await sync.whenDisposed` also drops out: the page is about to reload, and the bundle disposer has already detached listeners and started WebSocket teardown.

That collapse, eight surfaces gone for one invariant installed, is the pattern worth naming.

## The audit questions

When something feels off about a piece of code or an API surface, walk these questions before fixing it locally.

1. **What is this code compensating for?** Defensive mechanisms are receipts. A microtask-window pause, a try/catch that toasts and keeps running, a `Pick<Thing, 'method'>` parameter, a callback option that fires before another option, a "did we finish loading" boolean. Each one is paying off some invariant the layer above does not enforce. Name the invariant before deleting the code.

2. **Why is this violation a problem? Go up a level.** The first cut at "drop the cold-null pause" felt off, and the off-feel was the signal that a deeper invariant was being broken. Surface diffs do not surface deep invariants. Ask the why-question once more than feels necessary.

3. **What if we eliminate this behavior entirely?** Compensating code often supports a behavior nobody asked for. Half-cleared local state with a toast is a behavior. Hybrid old-and-new shapes is a behavior. A fan-out helper without a caller is a behavior. Eliminating the behavior eliminates the compensation, and usually no one notices. Compatibility is a feature; if no one asked for it, do not smuggle it in.

4. **Where could this boundary move?** If a smell appears at multiple call sites, do not extract a helper. Move the boundary that should have owned the invariant. UI code repeating cleanup means cleanup belongs to a lifecycle binding, not in five components. The best fix often relocates a responsibility instead of shortening a function.

5. **Who owns this invariant, really?** Two layers owning the same value drift. If `auth-workspace` is calling `syncControl?.pause()` to close the WebSocket and `attach-sync` is also closing the WebSocket on `ydoc.destroy()`, two layers own the same shutdown. Pick one. The other goes.

6. **Pretend you are designing today, no compatibility burden.** Write the ideal call site first, then work backwards into the implementation. If the ideal call site needs the consumer to pass unrelated things, the boundary is wrong. If it hides important policy, the abstraction is too soft.

7. **What would Better Auth, Yjs, Hono, or Rust do here?** Ground the audit in upstream conventions, not local habits. `ydoc.destroy()` is synchronous and detaches every listener via `ObservableV2`; that is a Yjs invariant, you do not need a hand-rolled "before destroy" hook. Better Auth's `signOut().onSuccess` is the canonical local-state-clear hook; you do not need a parallel one. Rust's `Drop` enforces destructor ordering at the type level; if you are hand-rolling that ordering with a private boolean and a try/finally, ask whether the type system can hold it instead.

8. **Mentally inline this layer. Does the caller get clearer?** A helper, file, parameter, or option earns its place only when it owns a real invariant or names non-obvious domain behavior. If inlining it makes the caller easier to understand, the layer was preserving a stale boundary, not adding meaning.

## When the local fix keeps growing, the boundary is wrong

The trigger for this audit is concrete: a small clean-up keeps growing as you implement it. A "drop one option" turns into "thread a parameter through five files." A "delete this method" turns into "rename three call sites and update four tests." The growth is not a sign that the change is too big. It is the audit talking. The original framing assumed the smell was local; it is not. Stop, write the one-sentence description of what the system should make true after the change, and re-scope.

The corollary: when the deep fix is the same size as the surface fix, the surface fix is correct. Pragmatic grounding matters. The audit's value is not bigger diffs; the audit's value is making the difference between "the surface fix would have left two of these alive" and "the deep fix collapses six surfaces into one."

## The Move

After the audit, the new design should have a one-sentence description that does not need an "or" in it.

```txt
Workspace identity reset is a deterministic teardown sequence;
every defensive mechanism that compensated for the absence of
this sequence is removed.
```

No "we still keep the pause for backwards compatibility." No "we leave the parameter for future fan-out." No "the type is still useful for documentation." If the sentence needs an "or" or an "also," the audit went up the right number of levels but stopped short of the install.

The goal is not fewer files. The goal is fewer competing truths.
