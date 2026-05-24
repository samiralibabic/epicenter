# CLI: mandatory daemon, drop cold-path, collapse the impedance

**Status**: Implemented
**Date**: 2026-04-28
**Supersedes (in part)**: `20260426T235000-cli-up-long-lived-peer.md` § "Discovery from sibling commands" (the auto-detect-with-fallback behavior). The rest of that spec (socket layout, lifecycle, ps/down/logs, security model, Invariants 1 to 7) stays load-bearing. Also supersedes `20260427T000000-execute-cli-up-long-lived-peer.md` § Wave 6 (the `*Core` extraction pattern); that pattern is reverted here.
**Related**:
- `20260427T010000-supervisor-redesign.md` § Step 3 (the rpc/presence rename touches the same dispatch sites).
- `20260427T120000-workspace-sync-failed-phase.md` (deletes the 10 s connect ceiling that lives in `up`).
- `20260425T230000-result-handling-conventions.md` (the nested-Result flattening here is an instance of those conventions).

**Review 2026-05-01**: The core collapse is implemented. `run`, `list`, and
`peers` call `getDaemon()` and no longer cold-load config. `tryGetDaemon`,
`runCore`, and `listCore` are gone from `packages/cli/src`. The daemon client
and route handlers moved into `packages/workspace/src/daemon`, so some file
paths in this spec are historical. The startup recovery design was adapted to
Bun's Unix socket behavior through `bindOrRecover()`.

> **Path note (2026-05-22):** Any pre-flight references to directory creation under `~/.epicenter` are stale path guidance. Current daemon process files are owned by `packages/workspace/src/daemon/paths.ts` and should not recreate top-level `~/.epicenter/run` or `~/.epicenter/log`.

## Why this exists

The current CLI has two execution modes for `run`, `list`, and `peers`:

```
              ┌─ tryGetDaemon ─→ ping ─→ ✓ → IPC dispatch ─→ render
arg-parse ─→ ─┤
              └─ no daemon  ─→ loadConfig ─→ *Core inline ─→ render
```

That dual path made sense when the daemon's job was framed as "amortize cold-start cost for repeated CLI invocations." It does not make sense once the daemon's job is reframed as **"be a callable peer in the mesh."** Under the peer-mesh framing:

- A device either *is* online (an `up` is running) or it *isn't*. There is no coherent third state called "transient peer that exists for the duration of one CLI call."
- Power-user automation belongs in vault-style TypeScript scripts that load the workspace library directly. Those scripts are how you compose, branch, loop, and dispatch RPC across the mesh. The CLI is a shell-friendly *shortcut* surface for one-shot invocations, not the main automation interface.
- The dual path costs real complexity: nested `Result`, schema/`Ctx` duplication with a `{ input: undefined, ...validated }` patch, the `*Core` extraction whose only consumer is the cold path itself, and the `inspectExistingDaemon → StartupState` enum that exists to disambiguate three failure modes during boot.

This spec drops the cold-path fallback, makes `epicenter up` a hard prerequisite for `run`/`list`/`peers`, and uses the resulting freedom to flatten the wire shape, collapse the schema/Ctx duplication, simplify daemon startup, and delete the `*Core` indirection.

## The new mental model, in one diagram

```
library  (loadConfig + workspace API)            ← the substrate
   ▲
   ├── vault-style scripts   `bun ./script.ts`   ← power user automation
   │     • opens its own workspace
   │     • dispatches local actions
   │     • dispatches remote RPC via sync.rpc
   │     • composes / loops / branches freely
   │
   └── epicenter CLI         `epicenter <verb>`  ← shell shortcuts
         • run / list / peers REQUIRE a local `up` (error otherwise)
         • up / down / ps / logs / auth manage state, no daemon dep
         • the CLI is "type one line at a shell prompt"
         • not "build automation on top of"
```

`up` is the verb that makes this device a callable peer. Everything `run`/`list`/`peers` does is now "talk to my local peer process." If you don't have a peer process, those verbs error with a one-line hint pointing at `up`.

## Invariants

These are the lock-ins for this collapse. All of them are testable.

1. **`run`, `list`, `peers` require a running local daemon.** No `loadConfig` fallback in any of those handlers. Absence prints exactly: `no daemon running for <abs-dir>; start one with \`epicenter up\` first` on stderr and exits 1.
2. **`up`, `down`, `ps`, `logs`, `auth login`, `auth logout` do not touch the daemon RPC plane.** They read/write config, metadata, sockets, and tokens directly.
3. **One Ctx type per command, sourced from the wire schema.** `RunCtx`, `ListCtx`, `PeersArgs` are each `typeof xCtxSchema.infer`. No hand-written shadow types. No `{ input: undefined, ...validated }` patching at the boundary.
4. **One `Result` per call site.** The transport plane throws; the domain plane returns a `Result`. No nested `Result<Result<T, DomainErr>, TransportErr>` anywhere. Renderers narrow on the inner `Result` only.
5. **No `*Core` extraction for the run/list/peers commands.** The Hono route handler IS the implementation. Tests exercise the handler directly via `app.request(...)` against an in-memory app instance.
6. **Daemon startup is bind-first.** Try to bind the socket; on `EADDRINUSE` ping the existing socket; if it answers, exit 1 (`already running, pid=X`); if it doesn't, sweep socket + metadata and retry once. No `inspectExistingDaemon`, no `StartupState` enum, no `isProcessAlive` pre-check.
7. **Vault-style scripts remain a first-class power user surface.** Nothing in this spec changes the workspace library API. A script can still `await using ws = await loadConfig(...)` and dispatch to local actions or remote peers via `sync.rpc(...)`. The CLI's narrowing does not narrow the library.

## What gets deleted, concretely

```
packages/cli/src/daemon/
  metadata.ts          203 → ~70 lines    -130
    delete: inspectExistingDaemon, sweepOrphan, isProcessAlive,
            StartupState type
    keep:   readMetadata, writeMetadata, unlinkMetadata,
            enumerateDaemons (used by ps + down --all)
  client.ts            208 → ~110 lines   -100
    delete: tryGetDaemon (returns null on absence)
    add:    getDaemon (throws DaemonRequired on absence)
    flatten: callRoute returns the inner Result; transport failures throw
  schemas.ts            44 →  ~44 lines     0
    keep shape, but `RunCtx` type now comes from `runCtxSchema.infer`
    instead of a separate hand-written declaration in run.ts

packages/cli/src/commands/
  run.ts               451 → ~280 lines   -170
    delete: cold-path branch (loadConfig + resolveEntry + runCore inline)
    delete: runCore extraction (inline into the route handler in app.ts)
    delete: nested-Result unwrap (one if instead of two)
  list.ts              554 → ~360 lines   -190
    same deletions as run.ts
  peers.ts             217 → ~140 lines    -75
    same deletions
  up.ts                483 → ~430 lines    -50
    delete: inspectExistingDaemon call site, orphan/clean branching
    add:    bindOrRecover wrapper

packages/cli/src/daemon/app.ts
                        158 → ~140 lines    -20
    delete: { input: undefined, ...validated } patch line
    delete: ListCtx & { workspace?: string } cast

────────────────────────────────────────────────────────────
total lines removed                                   ~735
total lines added                                     ~  0 (small)
net deletion                                          ~700
```

## The four collapses, in dependency order

These are independently mergeable. Land in this order so each compiles green and tests pass.

### Pre-flight: audit `loadConfig` side effects

Before any of the four collapses lands, audit `packages/cli/src/load-config.ts` for side effects that today fire on every cold-path invocation but will fire only at `up` boot afterwards. Examples to look for: directory creation under `~/.epicenter`, auth-token refresh, telemetry emission, registration with the relay. If any of these exist, decide per-effect whether to:

- (a) keep at boot only (the common case; the daemon already does it once, and one-shot CLI commands never had a real need to repeat it), or
- (b) move into a tiny precondition that runs in every `getDaemon` caller before talking to the daemon.

This audit is small (one file, ~100 lines today) and gates the migration: a side effect we miss here becomes a silent behavior regression after Collapse 3 ships.

### Pre-flight: read `list.ts:60-200` for hidden wire/in-memory deltas

`schemas.ts:14-17` flags `listCtxSchema` as a "strict subset" of the in-memory `ListCtx`, with cleanup happening "inline in the dispatcher." That comment hints at deltas beyond the obvious `workspace?` field. Before Collapse 1 lands for `list`, read `list.ts:60-200` and document every field that the dispatcher computes between the wire and `listCore`. Fold those into the schema (preferred) or accept the hand-bridge for `list` and only collapse `run`/`peers` cleanly. Do not skip this step; the spec's "drop the cast by adding `workspace` to the schema" is verified for `workspace` and unverified for whatever else lives in those 140 lines.

### Collapse 1: single-source the Ctx types

Today (run.ts:70 + schemas.ts:37 + app.ts:120):

```ts
// schemas.ts
export const runCtxSchema = type({
  actionPath: 'string',
  'input?': 'unknown',          // optional on wire
  'peerTarget?': 'string',
  waitMs: 'number',
  'workspaceArg?': 'string',
});

// run.ts (separate, hand-written)
export type RunCtx = {
  actionPath: string;
  input: unknown;                // required in memory
  peerTarget?: string;
  waitMs: number;
  workspaceArg?: string;
};

// app.ts route handler
const validated = c.req.valid('json');
const ctx = { input: undefined, ...validated };  // bridge the optional
```

After:

```ts
// schemas.ts becomes the single source
export const runCtxSchema = type({
  actionPath: 'string',
  'input?': 'unknown',
  'peerTarget?': 'string',
  waitMs: 'number',
  'workspaceArg?': 'string',
});
export type RunCtx = typeof runCtxSchema.infer;
//   ↑ input is `unknown | undefined`, peerTarget is `string | undefined`, etc.

// run.ts: import { RunCtx } from '../daemon/schemas';

// app.ts route handler
const ctx = c.req.valid('json');  // already typed RunCtx, no patch
```

Same treatment for `ListCtx` (drop the `& { workspace?: string }` cast in `app.ts:95` by adding `workspace` to the schema and the type alias) and `PeersArgs`. The daemon route handlers, the CLI client wrapper, and the test code all import the same type from `schemas.ts`.

### Collapse 2: flatten the wire Result

Today (`client.ts:167`, `run.ts:192`, `list.ts:189`):

```ts
// client.ts: daemonClient methods type a nested Result
run: (args) => callRoute<Result<RunSuccess, RunError>>(...)
//                    ↑ callRoute itself returns Result<T, DaemonClientError | SerializedError>
//                      so the actual return is Result<Result<RunSuccess, RunError>, TransportErr>

// run.ts handler
const transport = await daemon.run(ctx);
if (transport.error === null) {                  // 1st level: transport ok
  if (transport.data.error === null) {           // 2nd level: domain ok    ← gone after this collapse
    renderRunResult(transport.data, format);
  }
}
```

After:

```ts
// client.ts: daemonClient throws on transport failure, returns the domain Result
class DaemonRequiredError extends Error { /* ... */ }   // for getDaemon
class DaemonTransportError extends Error {
  constructor(public kind: 'timeout' | 'crashed', message: string) { super(message); }
}

const callRoute = async <T>(req: Promise<Response>): Promise<T> => {
  let res: Response;
  try { res = await req; }
  catch (cause) {
    if (cause?.name === 'TimeoutError') throw new DaemonTransportError('timeout', ...);
    throw new DaemonTransportError('crashed', `daemon connection failed: ${cause}`);
  }
  if (!res.ok) throw new DaemonTransportError('crashed', `daemon returned ${res.status}`);
  return await res.json() as T;
};

// daemonClient methods now return the bare RunResult etc.
run: (args) => callRoute<RunResult>(client.run.$post({ json: args }))

// run.ts handler: one level of unwrap
try {
  const result = await daemon.run(ctx);
  renderRunResult(result, format);   // already handles result.error itself
} catch (cause) {
  if (cause instanceof DaemonRequiredError || cause instanceof DaemonTransportError) {
    console.error(cause.message);
    process.exit(1);
  }
  throw cause;
}
```

The conceptual split (transport vs domain) was real; the cost was paying it at every call site. Throwing the transport plane and returning the domain plane preserves the distinction without the call-site tax.

**Critical reconcile point:** the daemon's existing `/run` and `/list` route handlers (`app.ts:97-115`, `app.ts:121-139`) wrap their work in a blanket `try { ... } catch (e) { return 200 with { data: null, error: serialize(e) } }` so domain errors arrive as HTTP 200 with the inner `Result.error` populated. **This wrapping must stay.** Under the new model, `callRoute` only throws on `!res.ok` (HTTP 500 = `HandlerCrashed`), connection failure, or timeout. Anything that flows back as 200 is a domain `Result` and is returned, not thrown. The handler's `try/catch` is what makes the transport/domain split actually true on the wire; without it, an unhandled throw inside the handler would surface as `HandlerCrashed` to the caller, losing the typed error union (`UsageError`, `RpcError`, etc.) the renderer needs.

Add this as a route-handler invariant: every dispatch route must terminate in a serialized `Result<T, KnownDomainError>`. `HandlerCrashed` is reserved for genuinely-unexpected exceptions (out-of-memory, programmer errors, schema-validator failures); it is not a fallback for "we forgot to map this error."

### Collapse 3: drop the cold path, drop *Core

Today (run.ts:188-205 sketch):

```ts
const daemon = await tryGetDaemon(target);
if (daemon) {
  // attached path: IPC dispatch, render
  return;
}
// cold path
await using config = await loadConfig(target.absDir);
const entry = resolveEntry(config.entries, target.userWorkspace);
const result = await runCore(entry, ctx);
renderRunResult(result, format);
```

`runCore` (run.ts:215) is shared between this cold path and the daemon's `/run` route handler in `app.ts`.

After:

```ts
// commands/run.ts handler, total
const daemon = await getDaemon(target);   // throws DaemonRequiredError if absent
try {
  const result = await daemon.run(ctx);
  renderRunResult(result, format);
} catch (cause) { /* see Collapse 2 */ }

// commands/run.ts: runCore EXPORT REMOVED
//   the daemon's /run route handler in app.ts now contains the full
//   implementation, calling resolveEntry + dispatching against the entry
//   it already loaded at boot. There is no second caller.
```

`getDaemon` is just `tryGetDaemon` minus the `null` return:

```ts
export async function getDaemon(target: ResolvedTarget): Promise<DaemonClient> {
  const sock = socketPathFor(target.absDir);
  if (!(await pingDaemon(sock))) {
    throw new DaemonRequiredError(
      `no daemon running for ${target.absDir}; start one with \`epicenter up\` first`,
    );
  }
  return daemonClient(sock);
}
```

Same shape for `list` and `peers`. After this collapse, the only callers of `loadConfig` are `up` (boot) and the auth/config-management commands. `runCore`/`listCore` cease to exist as exported names; their bodies live in `daemon/app.ts` route handlers.

### Collapse 4: bind-first daemon startup

Today (`up.ts:223` + `metadata.ts:117-200`):

```ts
const inspect = await inspectExistingDaemon(absDir);   // runs:
  //   1. read metadata
  //   2. if pid exists, isProcessAlive(pid)
  //   3. if alive, pingDaemon(socketPath, 250ms)
  //   4. classify into 'in-use' | 'orphan' | 'clean'
  //   5. on 'orphan', sweep socket + metadata
if (inspect.state === 'in-use') exit(1, 'already running, pid=...');
// proceed to bind unconditionally
const server = await bindUnixSocket(socketPath, app);
```

After:

```ts
// daemon/unix-socket.ts
export async function bindOrRecover(
  socketPath: string,
  metadataPath: string,
  app: Hono,
): Promise<UnixSocketServer> {
  try {
    return await bindUnixSocket(socketPath, app);
  } catch (cause) {
    if (!isAddressInUse(cause)) throw cause;
    // Socket file exists. Is anyone home?
    if (await pingDaemon(socketPath, 250)) {
      const meta = readMetadata(metadataPath);
      throw new AlreadyRunningError(`daemon already running${meta ? ` (pid=${meta.pid})` : ''}`);
    }
    // Stale socket, no one listening. Sweep metadata too in case it's stale.
    unlinkSocketFile(socketPath);
    unlinkMetadata(metadataPath);
    try {
      return await bindUnixSocket(socketPath, app);     // one retry
    } catch (retryCause) {
      // TOCTOU: another `up` raced us between the ping and the rebind.
      // Re-check; if the new occupant answers ping, surface AlreadyRunning
      // (not a generic EADDRINUSE) so the operator gets a clean message.
      if (isAddressInUse(retryCause) && (await pingDaemon(socketPath, 250))) {
        const meta = readMetadata(metadataPath);
        throw new AlreadyRunningError(`daemon already running${meta ? ` (pid=${meta.pid})` : ''}`);
      }
      throw retryCause;
    }
  }
}

// up.ts handler
const server = await bindOrRecover(socketPath, app);  // one call instead of inspect+bind
```

`isProcessAlive` is gone. The pid liveness pre-check is replaced by "actually try the socket"; a recycled pid that isn't serving on this socket simply fails the ping, same as a dead pid would. The `StartupState` union is gone. `inspectExistingDaemon` is gone. `metadata.ts` shrinks to read/write/unlink + `enumerateDaemons` for `ps`.

The pid is still recorded in metadata: `down` uses it for the SIGTERM fallback when the daemon doesn't ack `/shutdown` in 1 s, and `ps` displays it. But it is no longer a startup-time correctness gate.

### Collapse 5: unify the peers wire shape

Today there are three nearly-identical peer shapes drifting:

```
daemon/schemas.ts:26          peersArgsSchema   { workspace?: string }
daemon/app.ts:33              PeerSnapshot      { workspace, clientID, device: unknown }
commands/peers.ts:56          PeerRow           { workspace, clientID, deviceId, name, platform }
```

`peers.ts:126` casts `row.device as AwarenessState['device']` to recover the strong type the daemon erased. The cold path then re-groups the flat list `byWorkspace`. After Collapse 3 deletes the cold path, this drift becomes pure dead weight: there is one producer (the daemon's `/peers` route) and one consumer (the CLI renderer), and they should agree.

**After:**

```ts
// schemas.ts: type the device as the canonical PeerDevice from @epicenter/workspace
import { peerDeviceSchema } from '@epicenter/workspace';

export const peerSnapshotSchema = type({
  workspace: 'string',
  clientID: 'number',
  device: peerDeviceSchema,
});
export type PeerSnapshot = typeof peerSnapshotSchema.infer;

// app.ts /peers route returns PeerSnapshot[] grouped by workspace
//   (or returns the flat list and the renderer groups; pick one and stick to it)

// peers.ts: PeerRow is deleted; renderer consumes PeerSnapshot directly,
// no `as` cast, no shadow type.
```

This unification is bundled with the rest of Collapse 3 because both sides only have one consumer once the cold path is gone.

### Bonus collapses

Small drift the audit surfaced. Land opportunistically with whichever collapse touches the surrounding file.

- **`PeerMiss` error name drift.** `RunError.PeerMiss` (`run.ts:100`) and `ListError.PeerMiss` (`list.ts:110`) share a name but carry different fields (`{peerTarget, sawPeers, workspaceArg, waitMs}` vs `{deviceId, emptyReason}`). Both map to `exitCode=3` in their renderers. Either rename one (`RunPeerMiss` / `ListPeerMiss`) or extract a shared `PeerMiss` factory in a common errors module that both pass through. The renderers' shared exit code is a clue that the abstraction wants to exist.
- **`DEFAULT_WAIT_MS = 500`** duplicated at `list.ts:65` and `peers.ts:46`. Move to a shared constants module.
- **`SerializedError` (de)serialization.** `app.ts:51` has an `errFrom` (Error to `SerializedError`) helper; the client-side currently does no symmetric `deserializeError` step (it just casts the parsed JSON). Formalize the pair if anything ever needs to reconstruct an `Error` instance from the wire (today nothing does, so skip until a real consumer arises).

## What about the `runCore`/`*Core` extraction for testability?

The historical justification for `*Core` was: "the cold path and the daemon route both need the same logic; extract once." With the cold path gone, that justification evaporates. The remaining concern is route-handler testability without spinning up Hono.

That concern is already solved: Hono apps support `await app.request(...)` against an in-memory instance, no socket required. New tests for `/run`, `/list`, `/peers` use this; the existing `*Core` unit tests get rewritten to call `app.request('/run', { method: 'POST', body: ... })`. Roughly 1:1 line-count substitution, no test coverage lost.

## Documentation and README updates

The doc surface drifted with the cold path; this is the punch list of files that must update *as part of* the relevant collapse, not in a separate cleanup pass that never lands. Each item is grouped under the collapse that owns it.

**With Collapse 3 (drop the cold path):**

- `packages/cli/src/commands/run.ts` lines 16-20, 66, 79, 137, 140, 187, 191, 201: file-level JSDoc and inline comments describe a "Standalone (default)" path and reference `runCore`. Rewrite the file-level JSDoc to: `epicenter run` dispatches via the local daemon. Without `up`, errors with a hint. Delete the standalone-path narrative entirely.
- `packages/cli/src/commands/list.ts` lines 23-32, 93, 105, 125, 131, 177, 186, 188, 198: same treatment.
- `packages/cli/src/commands/peers.ts` lines 25, 33, 106, 109: same treatment, plus delete the cold-path-`wait` comment.
- `packages/cli/src/daemon/client.ts` lines 13, 18, 199: rewrite to describe `getDaemon` (throws `DaemonRequiredError`) instead of `tryGetDaemon` (returns null).
- `packages/cli/src/util/common-options.ts` lines 10, 45: drop the "two paths" framing; the resolved target now feeds only the daemon probe.
- `packages/cli/README.md` lines 49-66: every `epicenter list` / `run` / `peers` example must show an `epicenter up &` (or equivalent) prerequisite, or a one-line note pointing at `up`. The current README implies these commands work standalone; under this spec they don't.
- `examples/notes-cross-peer/README.md` line 24: rewrite "auto-detects the daemon and reuses its warm connection" to "talks to the daemon for peer-a." The "auto-detect" framing is the cold-path idiom and is gone.

**With Collapse 4 (bind-first startup):**

- `packages/cli/src/daemon/metadata.ts` lines 98, 110, 117, 132, 134: delete the JSDoc + types for `isProcessAlive`, `inspectExistingDaemon`, `StartupState`. The replacement (`bindOrRecover`) lives in `daemon/unix-socket.ts` and gets its own JSDoc.
- `packages/cli/src/commands/up.ts` lines 7-8: rewrite to remove the "siblings run **standalone**" line. After this spec, siblings don't run standalone.
- `packages/cli/src/commands/down.ts` line 27, 90: `isProcessAlive` import + call site remain (used for SIGTERM fallback). Keep, but inline a tiny `isProcessAlive` helper at the down-callsite if `metadata.ts` no longer exports it after Collapse 4. Three lines, no JSDoc needed.
- `packages/cli/src/commands/ps.ts` lines 6, 23, 58: same treatment as `down.ts`.

**With every collapse:**

- `specs/20260427T000000-execute-cli-up-long-lived-peer.md`: add a `Status: superseded in part by 20260428T140000-...` line at the top, pointing the relevant Wave 6 / `*Core` / `tryGetDaemon` references back here. The old execution spec stays in the repo as historical context for what shipped originally; it's not deleted.

**Test files:**

- `packages/cli/src/commands/list-autodetect.test.ts`: this entire file tests the cold-path `listCore` against fake `WorkspaceEntry` shapes, plus an "IPC parity" describe that exists to verify cold and warm paths return identical shapes. Under Collapse 3 there is no cold path, so the parity tests are tautological. Replace with `packages/cli/src/daemon/list-route.test.ts` exercising the `/list` route via `app.request(...)`.
- `packages/cli/src/daemon/metadata.test.ts` lines 8-9, 69-109: delete the `isProcessAlive` and `inspectExistingDaemon` describe blocks. Add `bindOrRecover` tests in `daemon/unix-socket.test.ts` covering the three states (clean bind, ping-finds-occupant, sweep-and-retry-succeeds, sweep-and-retry-loses-race).
- `packages/cli/test/e2e-up-cross-peer.test.ts` line 30: refresh the comment to point at the new test files.

## What stays exactly the same

- The socket / metadata / log file layout (`<runtimeDir>/<hash>.{sock,meta.json}`, `~/.epicenter/log/<hash>.log`).
- All seven Invariants from `20260426T235000-cli-up-long-lived-peer.md` (one daemon per dir, no hot reload, no daemonization flags, etc.).
- The `up`, `down`, `ps`, `logs` surfaces.
- The peer-RPC plane between `up` daemons across the mesh (the Yjs/relay path, untouched).
- The vault-style script pattern (`bun ./script.ts` calling `loadConfig` directly).
- The error rendering for domain failures (`PeerOffline`, `UsageError`, `RuntimeError`, etc.); they still flow through `renderRunResult` and friends.

## Migration path

This is a behavioral break: `epicenter run foo.bar` cold (no `up` running) goes from "works, slow" to "errors with a helpful hint." That deserves a deliberate cutover, not a silent change.

Three steps, each independently mergeable:

1. **Land Collapses 1 and 2 first.** They are pure internal cleanups. No user-visible change. They reduce the diff size of step 2 substantially.
2. **Land Collapse 4 next.** Also internal-only. It changes startup error messages slightly but does not change the contract.
3. **Land Collapse 3 + Collapse 5 as a single clean break.** No deprecation cycle. The CLI is pre-1.0, has no external consumers of the cold path, and the new mental model says cold-path execution was always misuse. Phase 3a/3b are explicitly *not* in scope: the cold path is deleted, `getDaemon` throws `DaemonRequiredError`, the `*Core` extractions are gone, and `epicenter run`/`list`/`peers` error immediately when no daemon is running. Users update by adding `epicenter up &` once at the start of their session or script.

## Why this is the right move (and the costs)

**Right-move evidence:**

- The user's actual repeated-invocation workflow is vault-style scripts that loop internally, not `for f in *; do epicenter run; done` shell loops. The cold path is amortizing a cost the user is not in fact paying repeatedly through the CLI.
- Every smell flagged in prior architecture review (nested Result, schema/Ctx duplication, `*Core` indirection, `StartupState` enum) traces to the dual-path commitment. Removing the dual path removes all four at once.
- The mental model "`up` makes this device a callable peer" maps cleanly onto the existing `--peer` flag, the awareness layer, and the relay's RPC plane. The "transient peer for one CLI call" model is at odds with all three.

**Costs accepted:**

- Worse first-run UX for casual users. Typing `epicenter run sync.push` cold is a footgun under this design. Mitigated by: clear error message pointing at `up` and updated README examples that show `epicenter up &` as the first line of every session.
- CI integration gets one extra line: scripts must `epicenter up &` before invocation. Mitigated by: the cleaner alternative for CI is usually a vault-style script anyway.
- `up` becomes a hard dependency. A crashed `up` blocks `run`/`list`/`peers` until restart. Mitigated by: `up` is small and deterministic; the failure modes are observable in `ps` and `logs`.

## Acceptance criteria

After all collapses land:

- [ ] `epicenter run foo.bar '{}'` from a directory that contains a valid `epicenter.config.ts` but with no `up` running prints exactly `no daemon running for <abs-dir>; start one with \`epicenter up\` first` on stderr and exits 1.
- [ ] `epicenter run foo.bar '{}'` from a directory with **no** `epicenter.config.ts` prints the existing config-not-found error (same phrasing today's cold path emits), not the no-daemon hint. `getDaemon` checks for `epicenter.config.ts` presence before probing the socket; otherwise an unconfigured user gets pointed at `epicenter up`, which would also fail and would mislead about the actual problem.
- [ ] `epicenter list` and `epicenter peers` follow the same two rules.
- [ ] `epicenter up`, `epicenter down`, `epicenter ps`, `epicenter logs`, `epicenter auth {login,logout}` all work without a daemon running. (The first three manage daemons; the last two are config/disk-only.)
- [ ] `grep -rE '\b(runCore|listCore)\s*\(' packages/cli/src` returns zero results. (Word-boundary plus open-paren rules out matches inside comments and historical references; the `*Core` *call sites* are what matter.)
- [ ] `grep -rE '\btryGetDaemon\b' packages/cli/src` returns zero results. The new symbol is `getDaemon`.
- [ ] `grep -rE '\b(inspectExistingDaemon|StartupState)\b' packages/cli/src` returns zero results. `isProcessAlive` is allowed to survive as a small helper inside `down.ts` / `ps.ts` if it isn't worth re-exporting; the spec only forbids it as a *startup-time correctness gate*. If it does survive, it carries a one-line comment explaining why (SIGTERM fallback, ps liveness column).
- [ ] No call site does `transport.error === null && transport.data.error === null`. The double-unwrap is gone everywhere. Verified by reading the renderer call sites (`run.ts`, `list.ts`, `peers.ts`), not by grep.
- [ ] `RunCtx`, `ListCtx`, `PeersArgs` are each defined as `typeof xSchema.infer` in `schemas.ts`. No hand-written shadow types in command files. Verified at compile time by adding a `satisfies RunCtx` assertion at the route handler's `c.req.valid('json')` call site, which fails to compile if the schema and type drift.
- [ ] `grep -F '{ input: undefined,' packages/cli/src/daemon/app.ts` returns zero results. (Brittle to formatting; the `satisfies` check above is the load-bearing one. Keep this as a tripwire only.)
- [ ] `kill -9 <up-pid>` then `epicenter up` again binds successfully (orphan recovery via `bindOrRecover`).
- [ ] Two `epicenter up` invocations against the same `--dir`: second exits 1 with `already running (pid=X)`.
- [ ] All existing acceptance criteria from `20260426T235000-cli-up-long-lived-peer.md` (Invariants 1 to 7, stale-auth fast-fail, multi-workspace daemon, etc.) continue to pass.
- [ ] Unit tests for `/run`, `/list`, `/peers` route handlers run via `app.request(...)` against an in-memory app. No Unix socket is spun up in unit tests; the e2e test (`packages/cli/test/e2e-up-cross-peer.test.ts`) remains the single full-stack integration check.

## Out of scope

- Auto-spawn `up` on first `run`/`list`/`peers`. Re-introduces a "transient peer" failure mode by another name; the spec explicitly rejects it.
- A new `epicenter exec ./script.ts` that runs arbitrary TypeScript inside the daemon's loaded workspace. Code-injection surface; the answer for "run a script with a warm workspace" is to write the script and `bun` it directly. The script can connect to the local daemon over the socket if it wants warmth without re-doing the WS handshake; the public client lives in a hypothetical future `@epicenter/cli-client` package and is out of scope here (Invariant 3 of the long-lived-peer spec).
- Renaming `epicenter run` / `epicenter list` to disambiguate from the library API. The shell-shortcut framing tolerates the name overlap; renaming is cosmetic and would churn READMEs.
- Removing the metadata sidecar entirely. `ps` and `down` still need pid-keyed enumeration; the sidecar earns its keep there. The simplification is in the *use* of the sidecar (no startup state machine), not the sidecar itself.
