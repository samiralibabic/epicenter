# Daemon `/run` Clean Break: One Contract, Two Transports

Status: implementation spec. Companion to `specs/20260515T120000-daemon-run-ownership-map.md`. Pauses for confirmation before any wire-affecting commit.

## The Finding

`/run` and `collab.dispatch` answer the same product question from two angles. `/run` carries a parallel error taxonomy (`RunError`), a duplicate action-path grammar, daemon-side presentation strings, and a wire field (`waitMs`) that one of its two paths ignores. None of that complexity is load-bearing for the route's actual job, which is "invoke an action through the local daemon."

## One Sentence

> *Invoking a workspace action returns `Result<T, DispatchError>`. `/run` is the local-machine Unix-socket fast path; `collab.dispatch` is the cross-device Yjs-RPC path. Same return shape, different wires.*

## The Killer Sentence the Model Must Survive

> *"How do I tell whether an action invocation succeeded" has the same answer whether the action ran in this process, in the daemon next door, or on my phone over the cloud relay.*

## Why This Collapses

```
WIRE, BEFORE                              WIRE, AFTER
─────────────────────────────             ─────────────────────────────
/run body:                                /run body:
  Result<unknown,                           Result<unknown, DispatchError>
    | UsageError       (exit 1)
    | RuntimeError     (exit 2)
    | PeerNotFound     (exit 3)             (CLI fetches /peers itself when
    | RemoteCallFailed (exit 2)              it wants to enrich peer-miss
  >                                          messages with sync status)

collab.dispatch:                          collab.dispatch:
  Result<unknown, DispatchError>            Result<unknown, DispatchError>
                                            (unchanged)
```

After: **one** action-invocation error type across the codebase. The CLI's exit-code map is a CLI concern, computed locally from `DispatchError.name`. The daemon stops carrying it on the wire.

## Why The Other Radical Paths Were Rejected (Grounded)

The `specs/20260515T120000-daemon-run-ownership-map.md` audit produced six candidate architectures. Five were rejected. The grounding:

### Rejected: delete `/run`, replace with Yjs-RPC over a daemon-hosted local sync server

The fatal claim is "scripts can become same-machine peers and pay only a small sync handshake cost." Deepwiki on `yjs/yjs` confirms this is false at the protocol level:

> *"The Yjs core library does not support partial document synchronization at the protocol level. STEP1/STEP2 always exchange the full document state vector and all missing updates."* : deepwiki query against `yjs/yjs`, INTERNALS docs.

A short-lived script becoming a transient peer therefore pays **full Y.Doc state-transfer cost on every invocation**. For a workspace with non-trivial data this is unacceptable : and crucially, the script's pain is **proportional to the workspace's size**, not the action's complexity. A 1KB action on a 10MB workspace handshakes 10MB. The architectural elegance is structurally broken by Yjs's sync protocol shape.

`/run` over Unix HTTP POST sidesteps this entirely: no state transfer, no presence row, no doc subscription.

### Rejected: SQLite-as-channel (SPA stops being a Yjs peer)

Conceptually clean but requires:
- New live-tailing infrastructure (`attachYjsLogReader` at `packages/workspace/src/document/attach-yjs-log-reader.ts` is snapshot-only : verified in source).
- SPA reactivity rewrite from Yjs observers to SQLite changefeed observers.

Triggered by a real need (drop Yjs runtime from SPA bundle) that doesn't exist today. Deferred.

### Rejected: status quo without D3

Keeps the parallel `RunError` taxonomy, the daemon-side presentation strings, the action-path grammar duplication, and the `waitMs` field nobody on the local path reads. None of these are load-bearing. Refusing to delete them is choosing to maintain duplicate machinery indefinitely.

### Rejected: dual-provider on the SPA (cloud + local), additive local sync server

Real resilience benefits for SPA+daemon-offline-same-machine. Real costs:
- y-websocket-server addition to daemon (~200 lines + dep)
- Bandwidth amplification when both providers active. Confirmed by deepwiki:

> *"Deduplication is NOT based on origin or update bytes. Instead, it relies on Yjs's idempotency property... duplicate updates are harmless but wasteful."* : deepwiki query against `yjs/yjs`.

The amplification doesn't break correctness (Yjs updates are idempotent and commutative, also confirmed by deepwiki) but does waste cloud egress. **The use case (SPA+daemon on one machine, offline) is niche today.** Deferred until real demand surfaces.

### Rejected: cloud-only, no local IPC

Breaks offline scripts. Non-starter.

## What Stays

- `/run` route exists. It is the local-machine fast path.
- `collab.dispatch` exists. It is the cross-device path.
- The CLI command `epicenter run` exists. Its body still POSTs `/run`.
- Daemon's writer-lease, materializer, Yjs sync to cloud relay: unchanged.
- `apps/api` Cloudflare Worker, presence writer, `PRESENCE_KEY`: unchanged.

## What Disappears

```
packages/workspace/src/daemon/run-errors.ts          DELETE (~96 lines)
packages/workspace/src/daemon/run-handler.ts         SHRINK ~70%  (171 → ~50 lines)
  - daemonActionSuggestionLines                      DELETE (presentation moves to CLI)
  - daemonActionNearestSiblingLines                  DELETE
  - toRunSyncStatus                                  DELETE (CLI fetches /peers when needed)
packages/workspace/src/daemon/app.ts
  - RunRequest.waitMs                                DELETE (CLI uses AbortSignal locally)
  - PeerSnapshot                                     KEEP (used by /peers)
packages/workspace/src/daemon/client.ts
  - daemonClient.run                                 RETURN-SHAPE CHANGE: Result<unknown, DispatchError | DaemonError>
packages/workspace/src/node.ts
  - RunError                                         REMOVE EXPORT
  - RunResponse                                      REMOVE EXPORT
  - RunSyncStatus                                    REMOVE EXPORT
packages/workspace/src/client/daemon-actions.ts
  - `${route}.${prop}` inline join                   REPLACE with joinDaemonActionPath
packages/cli/src/commands/run.ts
  - renderRunResult                                  REWRITE: switch on DispatchError | DaemonError
  - emitPeerNotFound                                 INLINE into CLI; fetch /peers when --peer
                                                       miss needs sync-status enrichment
  - describePeerMissReason                           MOVE to CLI (it always was CLI presentation)
packages/cli/src/commands/run-peer-errors.test.ts    KEEP (already DispatchError-shaped)
packages/workspace/src/daemon/run-handler.test.ts    REWRITE for new return shape
packages/workspace/src/client/daemon-actions.test.ts ASSERT DispatchError instead of RunError
```

Net: ~150 lines removed, one error taxonomy gone, grammar deduplicated, wire shape uniform across local and remote.

## What This Does Not Touch

```
Yjs sync protocol                       unchanged
@epicenter/sync wire codecs             unchanged
attachYjsLog / attachYjsLogReader       unchanged
SQLite materializer                     unchanged
collab.dispatch / Call / YKeyValueLww   unchanged
PRESENCE_KEY / apps/api presence write  unchanged
Auth model                              unchanged (AF_UNIX OS-perms gate)
CLI command surface                     unchanged (still `epicenter run <action> [input]`)
Daemon lifecycle / lease / metadata     unchanged
```

The blast radius is the `/run` route's wire shape and its consumers. Resist bundling adjacent cleanups.

## Implementation Waves

### Wave 1: Free wins (no wire change)

These can land independently and ship before Wave 2.

1. **Deduplicate action-path grammar.** `packages/workspace/src/client/daemon-actions.ts:69` constructs `` `${route}.${prop}` `` inline. Replace with `joinDaemonActionPath(route, prop)` imported from `daemon/action-path.ts`. Add test asserting the proxy uses the helper.
2. **Fix `--wait` documentation.** `packages/cli/src/commands/run.ts:67` claims "Total ms to wait for peer resolution + RPC." Code does only `AbortSignal.timeout(waitMs)` on the dispatch (`packages/workspace/src/daemon/run-handler.ts:111`); there is no resolution-wait loop. Either implement bounded retry, or fix help text. **Decision: fix help text.** A peer-resolution retry is a separate feature with separate semantics.

**Validation:** `bun test packages/workspace packages/cli`. No wire change; existing tests cover.

### Wave 2: Wire shape collapse

**Deliverable:** `/run` returns `Result<unknown, DispatchError>`. `RunError` is gone.

#### Step 2a: rewrite `run-handler.ts`

```ts
// packages/workspace/src/daemon/run-handler.ts (after)
import { Ok } from 'wellcrafted/result';
import { invokeAction } from '../shared/actions.js';
import { DispatchError } from '../document/rpc.js';
import { parseDaemonActionPath } from './action-path.js';
import type { RunRequest } from './app.js';
import type { DaemonServedRoute } from './types.js';

export async function executeRun(
  runtimes: readonly DaemonServedRoute[],
  { actionPath, input, peerTarget }: RunRequest,
): Promise<Result<unknown, DispatchError>> {
  const { routeName, localPath } = parseDaemonActionPath(actionPath);
  const route = runtimes.find((r) => r.route === routeName);
  if (!route) return DispatchError.ActionNotFound({ action: actionPath });

  const action = route.runtime.collaboration.actions[localPath];
  if (!action) return DispatchError.ActionNotFound({ action: actionPath });

  if (peerTarget !== undefined) {
    const peer = route.runtime.collaboration.peers
      .list()
      .find((p) => p.replicaId === peerTarget);
    if (!peer) return DispatchError.ActionNotFound({ action: `peer:${peerTarget}` });
    // dispatch returns Result<unknown, DispatchError> already
    return route.runtime.collaboration.dispatch(localPath, input, {
      to: peer.connId,
      signal: AbortSignal.timeout(/* CLI-controlled deadline */ 30_000),
    });
  }

  const result = await invokeAction(action, input);
  if (result.error !== null) {
    return DispatchError.ActionFailed({ action: actionPath, cause: result.error });
  }
  return Ok(result.data);
}
```

Notes:
- "Unknown route" and "unknown action" both surface as `DispatchError.ActionNotFound`. The action key includes the route prefix so the CLI can render `"action 'demo.foo' not found"` faithfully.
- Peer miss is also `ActionNotFound` with a `peer:` prefix on the action string. **Open question (grilled below)**: is this the right shape, or should `DispatchError` grow a `PeerNotFound` variant?
- `signal` deadline is server-side internal. The CLI's deadline-on-call is enforced via `AbortSignal.timeout` in `daemonClient` (already there).

#### Step 2b: shrink `app.ts` and delete `waitMs`

```ts
// packages/workspace/src/daemon/app.ts (RunRequest after)
export const RunRequest = type({
  actionPath: 'string',
  input: 'unknown',
  'peerTarget?': 'string',
  // waitMs deleted
});
```

#### Step 2c: delete `run-errors.ts`

Entire file removed. Update `packages/workspace/src/node.ts` to drop the three exports.

#### Step 2d: rewrite `commands/run.ts` renderer

```ts
// packages/cli/src/commands/run.ts (renderer after)
function renderRunResult(
  result: Result<unknown, DispatchError | DaemonError>,
  format: OutputFormat | undefined,
): void {
  if (result.error === null) {
    output(result.data, { format });
    return;
  }
  const { error } = result;
  switch (error.name) {
    case 'ActionNotFound':
      outputError(`error: ${error.message}`);
      // CLI-local: if this looks like a peer miss (action starts with "peer:")
      // optionally fetch /peers and enrich the message with sync status.
      process.exitCode = 1;
      return;
    case 'ActionFailed':
      outputError(`error: ${error.message}`);
      if (error.cause) outputError(`  cause: ${extractErrorMessage(error.cause)}`);
      process.exitCode = 2;
      return;
    case 'Cancelled':
      outputError(`error: dispatch cancelled: ${extractErrorMessage(error.reason)}`);
      process.exitCode = 3;
      return;
    case 'MissingConfig':
    case 'Required':
    case 'Timeout':
    case 'Unreachable':
    case 'HandlerCrashed':
      outputError(`error: ${error.message}`);
      process.exitCode = 1;
      return;
    default:
      error satisfies never;
  }
}
```

#### Step 2e: rewrite tests

- `run-handler.test.ts`: replace `RunError.X` assertions with `DispatchError.X` assertions.
- `client/daemon-actions.test.ts`: update generic constraint to `Result<_, DispatchError | DaemonError>`.
- `run-peer-errors.test.ts`: already DispatchError-shaped; verify against new message format.

**Validation:** `bun test packages/workspace packages/cli`; smoke test `epicenter daemon up && epicenter run <action> <input>` end-to-end against a real daemon; verify exit codes for each failure variant.

## Grilling

### Q: Why fold "peer not found" into `DispatchError.ActionNotFound` rather than add a variant?

**A:** Two reasons.

First, `DispatchError` is the cross-device contract. Adding a `PeerNotFound` variant means every cross-device caller has to handle a case that only makes sense at the CLI-with-`--peer` boundary. The narrower the contract, the more honest.

Second, the CLI is the only consumer that distinguishes "the peer didn't exist" from "the action didn't exist on a peer that did exist." The first is a CLI input error; the second is also a CLI input error from the user's perspective. Both map to exit code 1. The richer message (sync status, retry hints) is a CLI presentation choice and is computable from a `GET /peers` round-trip the CLI makes itself when it detects the `peer:` prefix.

**Counter:** if a future consumer wants to programmatically distinguish, they'd have to parse `error.action`. That's a smell.

**Resolution:** keep the merged variant for now. If a second non-CLI consumer surfaces and needs to distinguish, add a `PeerNotFound` variant to `DispatchError` then : at which point the existing CLI handler narrows to it. Defer the surface widening until forced.

### Q: The CLI now makes TWO round trips on a peer miss (one to `/run`, one to `/peers`). Isn't that worse than the current single-shot `RunError.PeerNotFound { syncStatus }`?

**A:** Yes, on the unhappy path. **No, on the happy path** (which is the common one).

The happy path is "the peer is there; dispatch succeeds in one round trip." The unhappy path is "the peer is not there; CLI optionally fetches `/peers` to enrich the error message." The user-visible delay is on a path where the user already has a problem and ~10ms more transport is invisible.

The architectural prize: the daemon stops owning a `RunSyncStatus` type that exists purely to be shown to humans. The CLI does its own enrichment. **Boundary integrity restored.**

### Q: `DispatchError.ActionNotFound { action: 'peer:macbook-pro' }` is a hack. The `action` field carries non-action data.

**A:** Fair. Alternative: rename the field to `target` or have `ActionNotFound` carry `{ kind: 'action' | 'peer', name: string }`. The latter is a small contract widening that's worth it for honesty.

**Resolution:** during Wave 2 implementation, propose this small expansion to `DispatchError.ActionNotFound`:

```ts
ActionNotFound: ({ kind, target }: { kind: 'action' | 'peer'; name: string }) => ({
  message: `${kind === 'peer' ? 'Peer' : 'Action'} "${name}" not found`,
  kind,
  name,
}),
```

This is the only `DispatchError` shape change. Existing call sites in `apps/api`, `document/rpc.ts`, and `attachActionRunner` need their constructor calls updated. Add to Wave 2 scope.

### Q: Bandwidth : when the CLI fetches `/peers` to enrich a miss message, isn't that wasted traffic vs. carrying `RunSyncStatus` in-band?

**A:** Only on the unhappy path, and only when the CLI is invoked in text mode (JSON mode emits raw `DispatchError` and the script handles enrichment if it wants). The wasted bytes are < 1KB. Not load-bearing.

### Q: Why `AbortSignal.timeout(30_000)` for peer dispatch when the request shape no longer carries a deadline?

**A:** That's the **daemon's local upper bound** on a single peer call, not a user-controllable deadline. User deadlines are enforced client-side via `daemonClient(socketPath, timeoutMs)` (already exists). Different concerns: the daemon protects itself from a runaway local handler; the client protects itself from a runaway round trip.

**Counter:** that's two timeouts shadowing each other. Confusing.

**Resolution:** delete the server-side timeout. The Unix-socket transport already has the client's deadline via `AbortSignal`; the daemon receives `c.req.raw.signal` (Hono passes through) and can propagate. Verify this during implementation. If the propagation works, server-side `setTimeout` is dead. If it doesn't, keep a large generous server-side cap (5 min) as a backstop.

### Q: The Yjs-RPC mechanism is the future. Why not just delete `/run` and force CLI/scripts to become peers?

**A:** Grounded rejection. Deepwiki on `yjs/yjs` confirms `STEP1/STEP2` exchange full document state : there is no partial sync at the protocol level. Short-lived scripts would pay handshake cost proportional to **workspace size**, not action complexity. This breaks the "scripts are cheap" invariant. The Yjs-RPC mechanism is excellent **for parties that are already syncing for other reasons** (SPA, Tauri, persistent peers); it is unsuitable for transient one-shot processes. The two transports answer different call patterns; forcing one is conceptual unification at the cost of real performance.

### Q: What if a script wants to do 100 dispatches in a row? Persistent connection?

**A:** Unix-socket HTTP keep-alive handles this. `daemonClient` already reuses the socket connection within a single Bun process. 100 dispatches ≈ 500ms total. If the script wants reactivity (observe a change as it happens), it's no longer "cheap one-shot scripts" territory : it's "persistent peer" territory, and the script should use `connectDaemonActions` differently or directly become a Yjs peer via the cloud relay.

### Q: Could `connectDaemonActions` later be backed by Yjs-RPC instead of `/run`, transparently?

**A:** Yes, **after this change**. Today the proxy hardcodes `client.run({...})`. After the wire shape unifies, you could swap the proxy's transport to `collab.dispatch` for use cases that prefer it (e.g., persistent processes). The CLI doesn't need this. Document the swappability; don't implement it.

### Q: Does this change affect remote `--peer` dispatch correctness?

**A:** No. `--peer` already goes through `collab.dispatch` (`run-handler.ts:109`). The only change is the wire shape coming back: `Result<_, DispatchError>` instead of `Result<_, RunError.RemoteCallFailed { cause: DispatchError }>`. One fewer envelope, same semantics.

### Q: Does removing `waitMs` from `RunRequest` change `--wait` CLI semantics?

**A:** Yes. The current `--wait` flag's value flows into `waitMs` which becomes `AbortSignal.timeout(waitMs)` on the daemon. After the change, `--wait` becomes a client-side `AbortSignal.timeout` passed via `daemonClient(socketPath, timeoutMs)`. The CLI's user-facing flag is unchanged; the wire stops carrying it.

**Validation:** `epicenter run --peer ghost --wait 100 demo.action` should still timeout in ~100ms with `DispatchError.Cancelled`. Existing test in `run-peer-errors.test.ts:30` already covers `Cancelled` rendering.

### Q: What about the `peerTarget !== undefined` case where the action key doesn't exist on the local route? Today's code looks up the action locally *before* deciding to dispatch. The new code... does what?

**A:** Look at the rewritten handler. After parse + route find, we look up `action` locally. If `peerTarget` is set, the local action presence is irrelevant : we go remote regardless. **But:** the current code requires the action to exist locally as a pre-flight validation. Is that load-bearing?

**Grilled answer:** No. The local pre-flight is a false signal. The peer might have actions the local daemon doesn't (different workspace version, different replica). The peer's `attachActionRunner` will respond `ActionNotFound` if the action isn't there. Faster failure but less accurate.

**Resolution:** drop the local pre-flight when `peerTarget` is set. Trust the peer to validate.

### Q: How does the CLI know to fetch `/peers` to enrich an `ActionNotFound { kind: 'peer' }`?

**A:** Conditional in the renderer. If `argv.peer && error.kind === 'peer'`, optionally fetch `/peers` and append a "currently connected peers" hint. Keep the enrichment optional : non-essential, doesn't gate the exit. CLI tests assert presence of base error; enrichment is a separate, easily-mocked branch.

### Q: Backwards compatibility : what if a user has the new CLI talking to an old daemon, or vice versa?

**A:** CLI and workspace ship together. The daemon binary is rebuilt from the workspace. There is no production constraint of "old daemon, new CLI" or vice versa : the daemon and the CLI are always built and shipped from the same monorepo commit. **Skip backcompat machinery.** This is a clean break. The unix-socket wire has never been a public stability promise.

### Q: Does this complicate the `buildDaemonActions` proxy's type system?

**A:** It simplifies it. `WrapDaemonAction` currently returns `Promise<Result<DaemonSuccessOutput<R>, RunError | DaemonError>>`. After: `Promise<Result<DaemonSuccessOutput<R>, DispatchError | DaemonError>>`. Same shape, simpler union, one fewer import in the file.

### Q: What's the rollback plan if Wave 2 breaks production scripts in apps/?

**A:** Revert the workspace + CLI commits together. The wire shape is internally consistent; partial revert would mismatch them. Per the monorepo's lockstep release, this is one PR.

## Honest Downsides

1. **Wire break.** Daemon and CLI must be at matching versions. Mitigated by monorepo lockstep release.

2. **Less rich error message on peer miss without `/peers` fetch.** Today's `RunError.PeerNotFound { syncStatus }` carries `RunSyncStatus` so the CLI prints sync-state context in one round trip. After: enrichment requires a second `/peers` call. **Tradeoff accepted:** the daemon stops owning a presentation-layer type.

3. **`DispatchError.ActionNotFound` carries one more field (`kind`).** Every existing constructor call (in `apps/api/src/sync-handlers.ts` and `packages/workspace/src/document/rpc.ts`) needs an update. ~5 call sites.

4. **Test surface churn.** ~4 test files rewritten. Coverage stays equivalent; assertions update.

5. **CLI loses ability to distinguish "local action returned Err" from "remote dispatch errored."** Both surface as `DispatchError.ActionFailed`. The CLI can still infer locality from whether `--peer` was passed. The wire stops carrying the distinction. **This is the intended collapse**: it was never a wire-level distinction; it was a CLI-level one promoted into the wire by `RunError.RuntimeError` vs `RemoteCallFailed`. The exit-code map (both → exit 2) doesn't need it.

## Validation Plan

```
WAVE 1 (no wire change)
─────────────────────────
□ bun test packages/workspace --filter daemon-actions
□ bun test packages/cli --filter run
□ manual: `epicenter run --help` shows fixed --wait text

WAVE 2 (wire break)
─────────────────────────
□ bun test packages/workspace
  □ run-handler.test.ts: DispatchError assertions
  □ daemon-actions.test.ts: DispatchError type assertions
  □ list-route.test.ts: unchanged, still green
  □ server.test.ts: /run dispatches action; returns Result<_, DispatchError>
  □ rpc.test.ts: unchanged
□ bun test packages/cli
  □ run-peer-errors.test.ts: exit codes 1/2/3 map correctly
  □ list.test.ts: unchanged
□ bun test apps/api
  □ presence handlers unchanged
  □ sync-handlers: DispatchError.ActionNotFound constructor calls updated
□ end-to-end smoke
  □ epicenter daemon up
  □ epicenter list                              # /list works
  □ epicenter peers                             # /peers works
  □ epicenter run demo.echo '"hi"'              # local invoke, Ok
  □ epicenter run demo.missing '{}'             # ActionNotFound, exit 1
  □ epicenter run --peer ghost demo.echo '"hi"' # peer miss, exit 1, /peers
                                                  enrichment if available
  □ epicenter run demo.throws '{}'              # ActionFailed, exit 2
  □ epicenter daemon down
□ typecheck
  □ bun run typecheck (all packages)
```

## Completion Checklist

```
□ Wave 1 lands as one commit. No wire change. Existing tests cover.
□ Wave 2 lands as one commit:
  □ run-errors.ts deleted
  □ run-handler.ts rewritten (<60 lines)
  □ app.ts RunRequest.waitMs removed
  □ DispatchError.ActionNotFound gains { kind, target } shape
  □ All 5 DispatchError.ActionNotFound call sites updated
  □ daemon/client.ts run() return type changed
  □ node.ts exports trimmed
  □ daemon-actions.ts proxy uses joinDaemonActionPath
  □ commands/run.ts renderer switches on DispatchError | DaemonError
  □ tests rewritten
  □ docs / README mentions of RunError removed
□ Post-implementation review per `.agents/skills/post-implementation-review`
  reads every touched file, walks the wire shape end-to-end, asserts no
  stale RunError references remain.
□ Update specs/20260515T120000-daemon-run-ownership-map.md with link to
  this spec and "implemented" marker.
```

## Deferred (Explicit Non-Scope)

These belong in their own specs, triggered by their own use cases:

- **Daemon hosts a local Yjs sync server (additive)** : triggered by SPA+daemon-offline-same-machine demand.
- **SQLite-as-live-channel for cross-process reactivity** : triggered by desire to drop Yjs runtime from SPA bundle.
- **LAN-mesh peer discovery for offline cross-device sync** : triggered by real offline-multi-device use case.
- **Persistent script-as-peer mode using `connectDaemonActions` over Yjs-RPC** : triggered by long-running automation that benefits from observing reactivity.

Each of these is grounded in the design space already mapped in `specs/20260515T120000-daemon-run-ownership-map.md`. None is load-bearing today.

## References

- Companion audit: `specs/20260515T120000-daemon-run-ownership-map.md`
- Yjs-RPC source: `packages/workspace/src/document/rpc.ts`
- Yjs-RPC spec: `specs/20260513T235000-rpc-on-yjs-state.md`
- Yjs sync protocol semantics (grounding): deepwiki `yjs/yjs` : STEP1/STEP2 are whole-doc; updates are idempotent and commutative; multi-provider echo prevention is provider-level via the origin parameter.
