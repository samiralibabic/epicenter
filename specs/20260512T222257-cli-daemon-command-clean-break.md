# CLI Daemon Command Clean Break

**Date**: 2026-05-12
**Status**: Implemented
**Author**: AI-assisted
**Branch**: `codex/app-resource-auth-cleanup`

## One Sentence

```txt
Top-level commands expose workspace and auth workflows; daemon subcommands operate the daemon lifecycle.
```

Anything that keeps daemon lifecycle verbs at the top level preserves the old mixed model and is out of scope.

## Overview

The CLI currently presents action commands (`list`, `run`, `peers`) beside daemon lifecycle commands (`up`, `down`, `ps`, `logs`) as if they are the same kind of operation. This spec makes the lifecycle boundary explicit by moving lifecycle commands under `epicenter daemon` and removing the old top-level lifecycle commands with no compatibility aliases.

## Execution note

Current status: mostly implemented in the CLI. `createCLI()` registers `daemonCommand` instead of top-level `up`, `down`, `ps`, or `logs`; `packages/cli/src/commands/daemon.ts` composes the lifecycle commands; CLI help tests assert the new namespace and active CLI docs already teach `epicenter daemon ...`. The remaining live gap was that yargs reported old top-level lifecycle verbs as unknown arguments instead of unknown commands.

Implemented now: enabled root `strictCommands()` so `epicenter up`, `epicenter down`, `epicenter ps`, and `epicenter logs` fail as unknown commands, matching the clean-break test boundary.

Out of scope now: no daemon process behavior changes, no auto-start policy, no file tree migration under `commands/daemon/`, and no historical spec rewrites.

The target command surface is:

```txt
epicenter auth ...
epicenter list ...
epicenter run ...
epicenter peers ...

epicenter daemon up
epicenter daemon down
epicenter daemon ps
epicenter daemon logs
```

## Motivation

### Current State

The current top-level CLI mixes two products:

```txt
epicenter up       # operate the daemon
epicenter down     # operate the daemon
epicenter ps       # inspect daemon processes
epicenter logs     # inspect daemon logs

epicenter list     # inspect exposed actions
epicenter run      # invoke an action
epicenter peers    # inspect connected peers
epicenter auth     # manage machine auth
```

The command registration reflects the mixed surface:

```ts
yargs()
  .command(authCommand)
  .command(downCommand)
  .command(listCommand)
  .command(logsCommand)
  .command(peersCommand)
  .command(psCommand)
  .command(runCommand)
  .command(upCommand);
```

This creates problems:

1. **Mixed ownership**: `list`, `run`, and `peers` depend on a daemon, but do not own daemon lifecycle. `up`, `down`, `ps`, and `logs` own lifecycle, but sit beside action commands as peer verbs.
2. **Weak test boundary**: `runDown` is exported mainly because the daemon shutdown body is a command internal living in a top-level command file. `ps` is already tested through `createCLI().run(['ps'])`, so its migration is an argument-boundary update rather than a helper-export cleanup.
3. **README drift**: The README describes the CLI as a scripting surface, but the command list gives daemon operation equal top-level weight.
4. **Future command pressure**: Any new daemon operator command would either bloat the top-level command list or force a later namespace migration.

### Desired State

Lifecycle commands live under one namespace:

```txt
epicenter daemon up
epicenter daemon down
epicenter daemon ps
epicenter daemon logs
```

Action and auth commands stay top-level:

```txt
epicenter auth login
epicenter list
epicenter run route.action
epicenter peers
```

The CLI now has a rule a new reader can apply without knowing the implementation:

```txt
If the command starts, stops, lists, or tails the daemon:
  it belongs under `daemon`.

If the command inspects or invokes workspace action behavior:
  it stays top-level.
```

No compatibility aliases are added. `epicenter up`, `epicenter down`, `epicenter ps`, and `epicenter logs` should become unknown commands in this clean break.

## Research Findings

### Local Command Surface

| Current command | Current owner file | Target command | Target owner |
| --- | --- | --- | --- |
| `auth` | `commands/auth.ts` | `auth` | unchanged |
| `list` | `commands/list.ts` | `list` | unchanged |
| `run` | `commands/run.ts` | `run` | unchanged |
| `peers` | `commands/peers.ts` | `peers` | unchanged |
| `up` | `commands/up.ts` | `daemon up` | daemon command group |
| `down` | `commands/down.ts` | `daemon down` | daemon command group |
| `ps` | `commands/ps.ts` | `daemon ps` | daemon command group |
| `logs` | `commands/logs.ts` | `daemon logs` | daemon command group |

### Current Test Shape

| Test file | Current boundary | After this spec |
| --- | --- | --- |
| `cli.test.ts` | Top-level help includes lifecycle commands | Top-level help includes `daemon`, not `up/down/ps/logs` |
| `commands/up.test.ts` | Calls `runUp` directly | Keep direct startup-body tests, plus CLI registration through `daemon up` where cheap |
| `commands/down.test.ts` | Calls `runDown` directly | Prefer `createCLI().run(['daemon', 'down', ...])`; make `runDown` private after tests move |
| `commands/ps.test.ts` | Already calls `createCLI().run(['ps'])` | Change command arguments to `['daemon', 'ps']`; no `runPs` helper exists |
| `commands/run-peer-errors.test.ts` | Uses top-level `run` | unchanged |

### Active Old-Command Text

The command registration is not the only user-facing surface. Active source text still teaches the old shape:

| Location | Current text shape | Target |
| --- | --- | --- |
| `packages/workspace/src/daemon/client.ts` | `start one with \`epicenter up\` first` | `start one with \`epicenter daemon up\` first` |
| `packages/workspace/src/client/connect-daemon-actions.ts` | `Start one with \`epicenter up\`.` | `Start one with \`epicenter daemon up\`.` |
| `packages/cli/src/commands/run.ts` | local `epicenter up` daemon and hint comments | local `epicenter daemon up` daemon and hint comments |
| `packages/cli/src/commands/list.ts` | hint comments point at `epicenter up` | hint comments point at `epicenter daemon up` |
| `packages/cli/src/commands/peers.ts` | hint comments point at `epicenter up` | hint comments point at `epicenter daemon up` |
| `packages/cli/src/commands/up.ts` | command JSDoc says `epicenter up` | command JSDoc says `epicenter daemon up` |
| `packages/cli/src/commands/down.ts` | command JSDoc and description say `epicenter down` / `epicenter up` | command JSDoc and description say `epicenter daemon down` / `epicenter daemon up` |
| `packages/cli/src/commands/ps.ts` | command JSDoc and description say `epicenter ps` / `epicenter up` | command JSDoc and description say `epicenter daemon ps` / `epicenter daemon up` |
| `packages/cli/src/commands/logs.ts` | command JSDoc says `epicenter logs` | command JSDoc says `epicenter daemon logs` |

Historical specs can keep old command examples when they document past work. Active source, README, command descriptions, and runtime error strings must teach the new shape only.

### Why Not Auto-Start

Auto-start is a different product decision:

```txt
Current explicit model:
  user starts daemon
    -> user runs action commands

Auto-start model:
  user runs action command
    -> CLI starts daemon as needed
    -> CLI decides daemon lifetime
```

Auto-start would remove ceremony, but it changes ownership of process lifetime, config reload, failure reporting, and cleanup. This spec keeps lifecycle explicit. It only names the lifecycle boundary honestly.

### Why No Compatibility Alias

Compatibility aliases would keep both shapes alive:

```txt
Old:
  epicenter up

New:
  epicenter daemon up
```

That breaks the clean-break sentence. The point of the spec is to teach one model:

```txt
daemon lifecycle lives under daemon
```

Aliases would require duplicate help behavior, duplicate README branches, and tests that preserve the old path. The user loss is small: scripts using top-level lifecycle commands must update once.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Lifecycle namespace | 2 coherence | Move `up/down/ps/logs` under `daemon` | Matches the one-sentence rule. Lifecycle commands operate the daemon; workspace and auth workflows stay top-level. |
| Compatibility | 2 coherence | No aliases for `up/down/ps/logs` | Aliases preserve the mixed model and keep old tests/docs alive. This is a clean break. |
| Binary name | 2 coherence | Keep one `epicenter` binary | A second binary such as `epicenterd` would split install and docs without deleting much code. The problem is command family ownership, not binary packaging. |
| Auto-start | Deferred | Do not auto-start daemons in this spec | Auto-start changes lifecycle policy. This spec only reorganizes ownership. |
| `runUp` test seam | 2 coherence | Keep direct `runUp` tests for startup lifecycle | `daemon up` parks the process, so direct startup-body tests still earn their keep. |
| `runDown` export | 2 coherence | Make private after `down` tests move to the command boundary | The export is test-shaped once lifecycle has a command namespace. `ps` already has a private body and command-boundary tests. |
| File names | 3 taste | Prefer `commands/daemon.ts` group plus existing implementation files in first wave | Minimal movement proves the command shape first. Deeper file moves can follow once tests pass. |
| README examples | 2 coherence | Update all lifecycle examples to `epicenter daemon ...` | Documentation should teach the new model only. |
| Bare `epicenter daemon` | 2 coherence | Fail with daemon help-shaped guidance | The namespace is not itself an operation. It should guide the user to `up`, `down`, `ps`, or `logs`. |

## From-Scratch Design Notes

The searches do not point to a from-scratch CLI redesign. The intended implementation is a small command namespace plus text and tests that prove the old top-level lifecycle commands are gone.

Do build from scratch:

```txt
commands/daemon.ts
  owns the daemon namespace
  composes up/down/ps/logs
  demands exactly one daemon subcommand
```

Do not rebuild from scratch:

```txt
up.ts       keep runUp and command behavior
down.ts     keep shutdown semantics, then make runDown private after tests move
ps.ts       keep collectPsRows private and update command path tests
logs.ts     keep tail/follow behavior
createCLI   keep the same factory shape, only change registered commands
```

The implementation is therefore:

```txt
new namespace
  -> existing lifecycle commands
  -> updated help, tests, README, and runtime hints
```

Not:

```txt
new binary
new daemon process model
new CLI framework
auto-start daemon policy
file tree migration under commands/daemon/
```

## Long-Term CLI Boundary Vision

The long-term CLI shape should use a thin top level with strong namespaces:

```txt
Top-level commands are daily workspace workflows.
Namespaced commands operate supporting systems.
```

That gives future commands a durable placement rule:

```txt
If the command uses the daemon to expose workspace behavior:
  it can stay top-level.

If the command starts, stops, inspects, or repairs daemon machinery:
  it belongs under `daemon`.

If the command changes machine identity or session state:
  it belongs under `auth`.

If the command validates or explains project declaration:
  it belongs under `config`.

If the command diagnoses multiple systems at once:
  it belongs under `doctor`.
```

The root should stay small because it is the daily workspace surface:

```txt
epicenter run <action>
epicenter list [path]
epicenter peers
epicenter auth ...
epicenter daemon ...
epicenter config ...
epicenter doctor ...
```

The namespaces should own real invariants:

```txt
daemon
  process lifecycle
  daemon logs
  running daemon inventory
  daemon repair and cleanup

auth
  machine login/logout
  session status
  token refresh or repair

config
  config validation
  route inspection
  resolved project metadata

doctor
  cross-boundary diagnosis
  auth + config + daemon + network checks
```

Future examples:

```txt
epicenter daemon restart
epicenter daemon status
epicenter daemon prune

epicenter auth login
epicenter auth logout
epicenter auth status

epicenter config check
epicenter config routes
epicenter config print

epicenter doctor
epicenter doctor daemon
```

Avoid both extremes:

```txt
Too flat:
  epicenter up
  epicenter down
  epicenter logs
  epicenter restart
  epicenter status
  epicenter run
  epicenter list

Too nested:
  epicenter workspace run
  epicenter workspace list
  epicenter workspace peers
```

The flat shape ages into a junk drawer. The fully nested shape makes the daily workspace path heavier than it needs to be. `run`, `list`, and `peers` are the product surface; `daemon`, `auth`, `config`, and `doctor` are supporting systems.

This spec implements the first cleanup under that vision:

```txt
Before:
  daemon lifecycle shared the root with workspace workflows

After:
  workspace workflows stay top-level
  daemon lifecycle moves under `daemon`
```

## Architecture

Current:

```txt
createCLI
  auth
  up
  down
  ps
  logs
  list
  run
  peers
```

Target:

```txt
createCLI
  auth
  list
  run
  peers
  daemon
    up
    down
    ps
    logs
```

Ownership:

```txt
commands/auth.ts
  machine auth session

commands/list.ts
commands/run.ts
commands/peers.ts
  action and peer use through an existing daemon

commands/daemon.ts
commands/up.ts
commands/down.ts
commands/ps.ts
commands/logs.ts
  daemon lifecycle and daemon inspection
```

Recommended first implementation shape:

```ts
// commands/daemon.ts
export const daemonCommand = cmd({
  command: 'daemon',
  describe: 'Operate the local Epicenter daemon.',
  builder: (yargs) =>
    yargs
      .command(upCommand)
      .command(downCommand)
      .command(psCommand)
      .command(logsCommand)
      .demandCommand(1, 'Specify a subcommand: up, down, ps, or logs')
      .strict(),
  handler: () => {},
});
```

Then `createCLI` registers `daemonCommand` and stops registering lifecycle commands directly.

## Implementation Plan

### Phase 1: Build the Daemon Namespace

- [x] **1.1** Add `packages/cli/src/commands/daemon.ts`.
- [x] **1.2** Register `daemonCommand` in `createCLI`.
- [x] **1.3** Stop registering `upCommand`, `downCommand`, `psCommand`, and `logsCommand` as top-level commands.
- [x] **1.4** Keep `up.ts`, `down.ts`, `ps.ts`, and `logs.ts` file-local command exports for composition under `daemon`.
- [x] **1.5** Update top-level help tests to expect `daemon` and reject top-level lifecycle commands.
- [x] **1.6** Add daemon help tests for `epicenter daemon --help` and `epicenter daemon` with no subcommand.

### Phase 2: Move Tests to the New Boundary

- [x] **2.1** Update lifecycle CLI tests to call `createCLI().run(['daemon', 'down', ...])`, `['daemon', 'ps']`, and similar forms.
- [x] **2.2** Keep direct `runUp` tests for startup-body behavior that would otherwise park the test process.
- [x] **2.3** Convert `down.test.ts` from direct `runDown` calls to command-boundary assertions where practical.
- [x] **2.4** Make `runDown` private if no production consumer remains. `DownOptions`, `DownOutcome`, and `DownResult` are already private.
- [x] **2.5** Update `ps.test.ts` from `['ps']` to `['daemon', 'ps']`. There is no `runPs` helper to remove.

### Phase 3: Update Documentation and Examples

- [x] **3.1** Update `packages/cli/README.md` command examples.
- [x] **3.2** Update README common flag table so `-C` lists `daemon up`, `daemon down`, `daemon logs`, `list`, `run`, and `peers`.
- [x] **3.3** Search specs, docs, and fixtures for `epicenter up`, `epicenter down`, `epicenter ps`, and `epicenter logs`; update only current user-facing guidance. Historical specs can remain if they document old work, but active handoff docs should move.
- [x] **3.4** Update command descriptions so `daemon` is the top-level lifecycle entry point.
- [x] **3.5** Update active CLI and workspace source comments that teach the old lifecycle paths.
- [x] **3.6** Update `DaemonError.Required` so runtime hints point at `epicenter daemon up`.

### Phase 4: Verify and Remove Old Paths

- [x] **4.1** Verify `epicenter daemon up --help`, `epicenter daemon down --help`, `epicenter daemon ps --help`, and `epicenter daemon logs --help`.
- [x] **4.2** Verify `epicenter up --help` fails as an unknown command.
- [x] **4.3** Run CLI package typecheck.
- [x] **4.4** Run targeted CLI tests.
- [x] **4.5** Run broader test selection if command registration touches shared CLI tests.

## Edge Cases

### `daemon up` Parks the Process

`upCommand` still parks the process after startup. Tests should not rely on `createCLI().run(['daemon', 'up'])` returning unless the test explicitly runs it in a child process and sends a signal. Keep direct `runUp` tests for startup-body behavior.

### `daemon logs --follow` Parks the Process

`logsCommand` returns after printing the default tail, but `--follow` parks until a signal. Tests should verify `daemon logs --help` and non-follow behavior through `createCLI().run(...)`; follow-mode tests need a child process or a direct helper around the follow body.

### Shell Scripts Using Old Commands

This is a breaking change:

```bash
epicenter up &
epicenter down
```

must become:

```bash
epicenter daemon up &
epicenter daemon down
```

No alias, no warning period. The cost is a one-time script edit.

### README Historical Specs

Historical specs that describe already-landed old behavior do not need to be rewritten unless they are active implementation guidance. The active CLI README must teach only the new form.

### Help Text

The top-level help should show `daemon`, not all lifecycle subcommands. The daemon help should show `up`, `down`, `ps`, and `logs`.

### Runtime Hints

`run`, `list`, and `peers` surface `DaemonError.Required` from `packages/workspace`. The error message must say `epicenter daemon up`, or the clean break will ship with a dead first-run hint.

## Rejected Alternatives

### Keep Top-Level Lifecycle Commands

This preserves the mixed model:

```txt
epicenter up
epicenter run
```

The code can be cleaned locally, but the product sentence stays muddy. Rejected.

### Add `daemon` While Keeping Aliases

This gives users two ways to express the same lifecycle operation. It makes migration gentle but keeps the old model in help, docs, tests, and muscle memory. Rejected because the user explicitly chose a clean break.

### Split Into `epicenterd`

This is more radical than needed. The lifecycle commands are related to the same installed package and project config. A command namespace gives the ownership win without splitting packaging, docs, or install behavior.

### Auto-Start on `run/list/peers`

Auto-start may be worth exploring later, but it changes lifecycle policy. It asks:

```txt
Who owns daemon lifetime after an action command starts it?
When does it stop?
How are config changes detected?
How are startup failures reported?
```

This spec does not answer those questions.

## Success Criteria

- [x] `epicenter daemon up/down/ps/logs` are the only lifecycle command paths.
- [x] `epicenter up/down/ps/logs` are unknown commands.
- [x] Top-level help shows `auth`, `daemon`, `list`, `peers`, and `run`.
- [x] Daemon help shows `up`, `down`, `ps`, and `logs`.
- [x] `runDown` no longer needs to be exported for tests.
- [x] README examples teach the daemon namespace only.
- [x] Runtime no-daemon hints teach `epicenter daemon up`.
- [x] CLI typecheck and targeted CLI tests pass.

## Resolved Grilling Answers

1. Use "Operate" for the daemon group description because `logs` and `ps` inspect rather than manage.
2. Wait on moving files into `commands/daemon/`. Command shape first, file move second if it still feels worth doing.
3. `epicenter daemon` without a subcommand should fail with daemon help-shaped guidance. The namespace is not an operation.
