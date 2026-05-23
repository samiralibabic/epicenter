# Daemon `/run` Ownership Map and Clean-Break Options

Status: design note. Followed up by implementation spec `20260515T140000-daemon-run-clean-break.md` (Option A + C / D3 chosen, grounded against `yjs/yjs` via deepwiki).

## One-sentence test

`/run` is a unix-socket shortcut that picks a hosted route, looks up a snake_case action key, then invokes it in-process or dispatches it to a peer over RPC, and returns one tagged result the CLI renders directly.

The sentence still survives, so the route is not orphaned. The tension is **what else** it owns beyond that sentence.

## Ownership surfaces (with code evidence)

```
┌─────────────────────────────┬───────────────────────────────────────────────────┐
│ surface                     │ owner                                             │
├─────────────────────────────┼───────────────────────────────────────────────────┤
│ request contract            │ daemon/app.ts:39 (RunRequest, arktype)            │
│   re-exported for CLI       │ node.ts:16                                        │
│   used by local facade      │ client/daemon-actions.ts:67                       │
│                             │                                                   │
│ response contract           │ daemon/run-errors.ts:96 (RunResponse)             │
│ error taxonomy              │ daemon/run-errors.ts:49 (RunError, 4 variants)    │
│ sync-status snapshot type   │ daemon/run-errors.ts:27 (RunSyncStatus)           │
│                             │                                                   │
│ route dispatch (HTTP)       │ daemon/app.ts:103 (Hono /run + sValidator)        │
│ action-path grammar         │ daemon/action-path.ts                             │
│   duplicated inline         │ client/daemon-actions.ts:69 (`${route}.${prop}`)  │
│                             │                                                   │
│ route routing               │ daemon/run-handler.ts:35-45                       │
│ action lookup + suggestions │ daemon/run-handler.ts:47-60, 146-170              │
│ local invocation            │ daemon/run-handler.ts:72-76 (invokeAction)        │
│ peer dispatch               │ daemon/run-handler.ts:79-122                      │
│ sync-status snapshot read   │ daemon/run-handler.ts:124-144                     │
│                             │                                                   │
│ transport mapping           │ daemon/client.ts:130 (call, DaemonError)          │
│ typed handle                │ daemon/client.ts:168 (daemonClient.run)           │
│                             │                                                   │
│ error rendering             │ cli/commands/run.ts:96-141 (switch on .name)      │
│ exit-code taxonomy          │ cli/commands/run.ts (1=usage, 2=runtime, 3=peer)  │
│                             │                                                   │
│ tests                       │ daemon/run-handler.test.ts                        │
│                             │ daemon/server.test.ts:157 (`/run` over socket)    │
│                             │ daemon/list-route.test.ts (grammar)               │
│                             │ client/daemon-actions.test.ts (proxy)             │
│                             │ cli/commands/run-peer-errors.test.ts (renderer)   │
└─────────────────────────────┴───────────────────────────────────────────────────┘
```

## Real tensions

1. **Split contract ownership.** `daemon/run-errors.ts` admits it: *"CLI-specific failures of the `/run` route. Carrying the failure mode in-band lets the renderer set `process.exitCode`."* The daemon's wire taxonomy is shaped by the CLI's exit-code categories. `RunError.RuntimeError` (exit 2) vs `RemoteCallFailed` (exit 2) vs `PeerNotFound` (exit 3) vs `UsageError` (exit 1) is **the CLI's exit table promoted into the wire**.

2. **Action-path grammar duplicated.** `joinDaemonActionPath` lives in `daemon/action-path.ts:32`, but `client/daemon-actions.ts:69` writes `${route}.${prop}` inline. Two implementations of one rule.

3. **Daemon owns presentation strings.** `RunError.UsageError.suggestions` is `string[]` of pre-formatted `"  notes.notes_add  (mutation)"` lines, built in `run-handler.ts:154`. The CLI prints them verbatim. Any non-CLI consumer of `/run` (the local facade `buildDaemonActions`) gets human-formatted strings as part of an error contract.

4. **`waitMs` is always-required wire field that the local path ignores.** `RunRequest.waitMs: 'number'` is mandatory in `app.ts:43`. With no `peerTarget`, `run-handler.ts` never reads it. The CLI ships `5000` for local invokes (`commands/run.ts:75`).

5. **`--wait` flag claims more than the code does.** CLI help text: *"Total ms to wait for peer resolution + RPC."* Code does **one** `peers.list().find(...)` (`run-handler.ts:98-100`) then applies `AbortSignal.timeout(waitMs)` to the dispatch. There is no resolution wait loop. Doc/behavior drift.

6. **Two error taxonomies for one RPC outcome.** Local action that returns `Err(...)` → `RunError.RuntimeError`. Remote call that returns `DispatchError.ActionFailed` → `RunError.RemoteCallFailed{ cause: DispatchError }`. Same situation (an action failed), two wire shapes. The CLI then unwraps `DispatchError.cause` inside `RunError.RemoteCallFailed.cause` (`commands/run.ts:128`, `emitRemoteCallError`).

## Three options

### Option A : Current-shape cleanup

Keep the wire. Patch the smells.

- Use `joinDaemonActionPath` inside `client/daemon-actions.ts` instead of `${route}.${prop}` (tension 2).
- Fix `--wait` help text to match code, **or** wrap the peer lookup in a small bounded retry (tension 5). Pick one.
- Optionally extract `dispatchLocal` / `dispatchPeer` helpers in `run-handler.ts` for readability.

```diff
- run-handler.ts: 171 lines
+ run-handler.ts: ~140 lines, two named sub-helpers
```

| | |
|---|---|
| deletion prize | tiny (~30 lines, one duplicate) |
| user loss | none |
| migration cost | trivial, no wire change |
| files touched | `client/daemon-actions.ts`, `run-handler.ts`, `commands/run.ts` (help text) |
| validation | existing tests cover; no new tests needed |
| recommendation | **GO** regardless of larger choice. These are free wins. |

### Option B : Small clean break: structured `RunError`, drop `waitMs` from wire

Keep `/run` as a separate route, but stop letting CLI presentation leak into it.

- `RunError.UsageError` becomes `{ kind: 'unknown-route' | 'unknown-action' | 'partial-prefix'; missing: string; candidates: string[] }` (raw action paths, not formatted lines). CLI does the formatting.
- Drop `waitMs` from `RunRequest`. Peer-call timeout becomes a per-call `AbortSignal` the CLI sets via `daemonClient(socketPath, timeoutMs)` (tension 4).
- Keep `RunError.RuntimeError` / `RemoteCallFailed` / `PeerNotFound` distinctions.

| | |
|---|---|
| deletion prize | ~30 lines (waitMs field, format-string builders, daemon-side formatter) |
| user loss | none (CLI ships lockstep with workspace) |
| migration cost | wire break: `RunRequest` and `RunError.UsageError` shape change |
| files touched | `app.ts`, `run-errors.ts`, `run-handler.ts`, `commands/run.ts`, `daemon-actions.ts`, `run-handler.test.ts`, `client/daemon-actions.test.ts` |
| validation | `bun test packages/workspace packages/cli`; end-to-end `epicenter run` smoke against a real daemon |
| recommendation | **GO** if you want to land the smaller break first and defer C2 |

### Option C : Radical clean break: collapse `RunError` into `DispatchError`

`/run` already wraps `collab.dispatch` on the peer path. The local path is just "dispatch in-process". Make the wire shape uniform.

```
Before                                    After
─────────────────────────────────────     ─────────────────────────────────────
RunResponse =                              RunResponse =
  Result<unknown,                            Result<unknown,
    | UsageError       (exit 1)                | DispatchError    (one taxonomy)
    | RuntimeError     (exit 2)              >
    | PeerNotFound     (exit 3)
    | RemoteCallFailed (exit 2)
  >                                          (CLI checks /peers itself
                                              before calling /run when --peer)
```

- `/run` returns `Result<unknown, DispatchError>` (the same error type peer RPC already uses).
- `RunError.UsageError` → `DispatchError.ActionNotFound` (already exists). Add `DispatchError.RouteNotFound` if needed, or fold into `ActionNotFound`.
- `RunError.RuntimeError` → `DispatchError.ActionFailed`. Local invoke wraps thrown causes the same way `attachActionRunner` does at the RPC boundary.
- `RunError.PeerNotFound` and `RunError.RemoteCallFailed.syncStatus` → **the CLI fetches `/peers` itself** on the unhappy path and composes the friendly message. Daemon stops carrying `RunSyncStatus`.
- Drop `daemon/run-errors.ts` entirely. Exit-code mapping lives in `commands/run.ts` as a local function (or migrate to the existing `DispatchError`-by-name switch already in `emitRemoteCallError`).
- `run-handler.ts` collapses to ~40 lines: parse path, find route, find action, invoke (local) or dispatch (peer), return.

| | |
|---|---|
| deletion prize | `run-errors.ts` (96 lines), `toRunSyncStatus`, `daemonActionSuggestionLines`/`NearestSibling` (move grammar pretty-printing to CLI), most of `run-handler.ts` |
| user loss | richer peer-miss messages need one extra `/peers` round-trip on the unhappy path |
| migration cost | larger wire break; touches every caller of `/run` |
| files touched | `app.ts`, `run-handler.ts`, **delete** `run-errors.ts`, `client.ts` (typed handle), `node.ts` (drop `RunError`, `RunSyncStatus`, `RunResponse` exports), `commands/run.ts`, `daemon-actions.ts`, `run-handler.test.ts`, `client/daemon-actions.test.ts`, `run-peer-errors.test.ts` |
| validation | full daemon and CLI suite, plus targeted unhappy-path test: peer not present, peer disconnects mid-call |
| recommendation | **GO** as the cohesive clean break : the product sentence still survives, the daemon stops owning CLI exit-code shape |

## Asymmetric wins surfaced by the audit

| refuse                                                       | lose                                                                  | gain                                                  |
|--------------------------------------------------------------|-----------------------------------------------------------------------|-------------------------------------------------------|
| daemon-side pre-formatted suggestion strings                 | one already-CLI-only formatter                                        | `/list` and `/run` agree on raw shape; non-CLI clients see structured data |
| `RunSyncStatus` carried in-band with `PeerNotFound`          | one round trip on the peer-miss path                                  | drop `RunSyncStatus`, `toRunSyncStatus`               |
| `RunError.RuntimeError` vs `RemoteCallFailed`                | local-vs-remote tag in the wire (CLI already knows from request)      | one error taxonomy: `DispatchError`                   |
| `waitMs` as a wire field                                     | nothing : CLI already controls it                                      | smaller `RunRequest`, no field the local path ignores  |
| second `${route}.${prop}` grammar in `daemon-actions.ts`     | nothing                                                                | one parse/join helper, one source of truth            |

All five wins individually pass the product-sentence test. Stacked, they are Option C.

## Recommendation

**Option A (free wins) + Option C (collapse `RunError` into `DispatchError`).** The route survives; the parallel taxonomy dies.

The route's product sentence after the change:

> *Invoking a workspace action is `collab.dispatch`. `/run` is the local-machine Unix-socket fast path; Yjs-RPC over the relay is the cross-device path. Same return shape, same mental model, different transports.*

**Pause requested before any code change.** C alters:

- public daemon wire shape (`RunRequest`, `RunResponse`/`RunError`)
- `@epicenter/workspace/node` package exports (`RunError`, `RunResponse`, `RunSyncStatus` removed)
- CLI behavior contract on `--wait` semantics

Per goal stop clause, **do not implement until confirmed**.

## Rejected: delete `/run`, replace with Yjs-RPC over a daemon-hosted local sync server

This was seriously considered and rejected. Recording the reasoning so it doesn't get re-litigated.

The seductive framing: `document/rpc.ts` exposes a synchronized request/response over `YKeyValueLww<Call>` rows. Two parties on the same Y.Doc can dispatch actions to each other through Yjs sync. If the daemon hosted a local Yjs WebSocket server (AF_UNIX or `127.0.0.1`), the CLI / scripts could become same-machine peers, dispatch over the same mechanism the cloud relay uses, and `/run` plus its entire taxonomy could be deleted.

Why this is **complexity addition disguised as deduplication**:

```
PEER-TO-PEER (where Yjs-RPC was designed)         CLIENT-TO-DAEMON (what /run does)
─────────────────────────────────────────         ───────────────────────────────────
Two parties ALREADY share a Y.Doc;                One party invokes; the other holds
they are syncing for other reasons.               state. No shared state needed.

Yjs-RPC adds one row to a structure they          Yjs-RPC would force the client to:
are already replicating: ~free.                     1. open a WebSocket
                                                    2. sync handshake (STEP1/STEP2/UPDATE)
                                                    3. write a presence row
                                                    4. write a Call row
                                                    5. observe response flip
                                                    6. delete Call row
                                                    7. tear down sync subscription
                                                    8. close socket

→ Yjs-RPC is cohesive HERE.                       → That is MORE machinery than POST,
                                                    not less.
```

Concrete costs of the local-sync-server alternative:

- New daemon dependency (y-websocket-server or hand-rolled equivalent), new lifecycle code.
- Every script process becomes a transient Yjs peer: ships the Yjs runtime, churns a presence row on each invocation, pays the sync handshake on first call.
- Per-call latency increases from ~5ms (Unix HTTP POST) to ~50-200ms (sync handshake + dispatch + teardown).
- More failure modes to test: partial sync, presence leaks on script crash, LWW timestamp skew, scratch-doc validation on every frame.
- If transport is `127.0.0.1` TCP, any local process can connect; AF_UNIX would keep current OS-perms model but adds nothing security-wise vs `/run`.

What we keep with the chosen path (A + C):

- `/run` route survives as a 10-line pass-through to `collab.dispatch`.
- Wire shape is `Result<unknown, DispatchError>` (the same shape Yjs-RPC returns).
- `RunError`, `RunSyncStatus`, `RunResponse`, suggestion formatters, parallel exit-code taxonomy: gone.
- Action-path grammar deduplicated via `joinDaemonActionPath`.
- No new infrastructure. No new dependency. No latency regression.

The conceptual unification is **on the return shape**, not on the transport. After this change:

```
cross-device dispatch:  collab.dispatch(action, input, { to: peerConnId })
                          → Result<unknown, DispatchError>

same-machine dispatch:  daemonClient.run({ actionPath, input })
                          → Result<unknown, DispatchError>   ← same shape
```

The mental model collapses without forcing the transports to collapse.

Future LAN-mesh / offline-multi-device sync is a separate problem with separate triggers (peer discovery, encrypted local transport, real user demand). It is not coupled to this decision and should get its own spec when a real use case shows up.

## Evidence inspected

Files read:
- `packages/workspace/src/daemon/app.ts`
- `packages/workspace/src/daemon/run-handler.ts`
- `packages/workspace/src/daemon/run-errors.ts`
- `packages/workspace/src/daemon/action-path.ts`
- `packages/workspace/src/daemon/types.ts`
- `packages/workspace/src/daemon/client.ts`
- `packages/workspace/src/daemon/route-validation.ts`
- `packages/workspace/src/daemon/best-effort.ts`
- `packages/workspace/src/daemon/index.ts`
- `packages/workspace/src/daemon/run-handler.test.ts`
- `packages/workspace/src/daemon/server.test.ts`
- `packages/workspace/src/daemon/client.test.ts`
- `packages/workspace/src/daemon/list-route.test.ts`
- `packages/workspace/src/client/daemon-actions.ts`
- `packages/workspace/src/client/daemon-actions.test.ts`
- `packages/workspace/src/client/connect-daemon-actions.ts`
- `packages/workspace/src/node.ts`
- `packages/workspace/src/shared/actions.ts`
- `packages/cli/src/commands/run.ts`
- `packages/cli/src/commands/run-peer-errors.test.ts`
- `packages/cli/src/commands/list.ts`
- `packages/cli/src/commands/peers.ts`

Spec context skimmed:
- `specs/20260513T200000-workspace-surface-clean-break-vision.md`
- `specs/20260514T170000-single-daemon-multi-workspace.md`
- `specs/20260513T235000-rpc-on-yjs-state.md` (motivates C's reuse of `DispatchError`)

Greps used:
- `grep -rn "RunRequest|daemonClient|\.run(|/run\b|executeRun"` (callers)
- `grep -rn "actionPath|joinDaemonActionPath|parseDaemonActionPath"` (grammar duplication)
