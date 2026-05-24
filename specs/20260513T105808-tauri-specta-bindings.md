# Tauri Specta Bindings

**Date**: 2026-05-13
**Status**: Draft
**Author**: Codex

## One-Sentence Test

Whispering should replace raw stringly Tauri `invoke(...)` calls with checked-in `tauri-specta` generated bindings so Rust commands, TypeScript call sites, and IPC payload types fail together instead of drifting apart.

## Overview

This spec proposes adopting `tauri-specta` v2 for the Whispering Tauri boundary. The immediate goal is typed command wrappers for `apps/whispering`; the broader goal is a repeatable convention for any future Tauri surface in the monorepo.

This is a planning document. It does not implement the migration.

## Motivation

### Current State

Whispering registers commands through Tauri's generated handler:

```rust
let builder = builder.invoke_handler(tauri::generate_handler![
    write_text,
    simulate_enter_keystroke,
    get_current_recording_id,
    enumerate_recording_devices,
    init_recording_session,
    close_recording_session,
    start_recording,
    stop_recording,
    cancel_recording,
    transcribe_audio_whisper,
    transcribe_audio_parakeet,
    transcribe_audio_moonshine,
    send_sigint,
    execute_command,
    spawn_command,
    read_markdown_files,
    count_markdown_files,
    delete_files_in_directory,
    write_markdown_files,
]);
```

Frontend code calls those commands by string:

```ts
const result = await invoke<ChildProcess<string>>('execute_command', {
	command,
});
```

Some services wrap raw `invoke` with `tryAsync`; others expect an application-level `Result` shape:

```ts
const { data: recordingId, error: getRecorderStateError } = await invoke<
	string | null
>('get_current_recording_id');
```

That creates problems:

1. **Command names are untyped**: Renaming a Rust command can leave stale TypeScript strings behind.
2. **Arguments are manually mirrored**: TypeScript object keys must match Rust parameter names, but there is no generated contract.
3. **Return types are assertions**: `invoke<T>` trusts the caller. It does not prove Rust actually returns `T`.
4. **Result semantics are inconsistent**: Raw Tauri rejections, `wellcrafted/result`, and generated `Result<T, E>` wrappers can look similar at the call site while behaving differently.
5. **Migration pressure grows with command count**: Whispering already has recorder, transcription, command execution, markdown, text insertion, and shutdown commands.

### Desired State

Rust owns the command contract:

```rust
#[tauri::command]
#[specta::specta]
async fn execute_command(command: String) -> Result<CommandOutput, String> {
    // ...
}
```

Generated TypeScript owns the frontend command client:

```ts
import { commands } from '$lib/tauri/bindings.gen';

const result = await commands.executeCommand(command);
```

Generated files are checked in. CI regenerates them and fails if the working tree changes.

## Research Findings

Sources checked:

```txt
https://github.com/specta-rs/specta
https://github.com/specta-rs/tauri-specta
https://docs.rs/specta/latest/specta/
https://docs.rs/tauri-specta/latest/tauri_specta/
https://docs.rs/ts-rs/latest/ts_rs/
https://github.com/fastrepl/anarlog
```

### Anarlog Uses Tauri Specta

The `fastrepl/anarlog` repository uses `tauri-specta`, `specta`, and `specta-typescript` for Tauri command bindings.

Their app-level pattern:

```rust
tauri_specta::Builder::<R>::new()
    .commands(tauri_specta::collect_commands![...])
    .error_handling(tauri_specta::ErrorHandlingMode::Result)
```

They mount the generated invoke handler:

```rust
.invoke_handler(specta_builder.invoke_handler())
```

They generate `apps/desktop/src/types/tauri.gen.ts` from a Rust test named `export_types`. Their custom Tauri plugins repeat the same pattern and emit `plugins/<plugin>/js/bindings.gen.ts`.

**Key finding**: A serious Tauri v2 app is already using `tauri-specta` for checked-in generated command clients.

**Implication**: The pattern is not theoretical. It works in a large command surface with plugins, events, and generated TypeScript.

### Specta v2 Is Active But Not Stable

As of 2026-05-13, crates.io reports:

```txt
specta          2.0.0-rc.25
tauri-specta    2.0.0-rc.25
specta-typescript 0.0.12
```

GitHub activity checked on 2026-05-13:

```txt
specta-rs/specta
  stars: 582
  open issues: 16
  pushed_at: 2026-05-13T04:34:43Z

specta-rs/tauri-specta
  stars: 715
  open issues: 27
  pushed_at: 2026-05-13T03:05:47Z
```

Recent Specta commits include fixes for serde enum TypeScript rendering. That is good maintenance signal and also a reminder that the v2 line is still hardening.

**Key finding**: Specta v2 is the active line for Tauri v2, but it is still an RC line.

**Implication**: We can use it, but we should pin exact versions and make generated output reproducible.

### Alternatives

| Option | Fit | Stability | Notes |
| --- | --- | --- | --- |
| `tauri-specta` v2 | Best Tauri v2 command fit | Medium | Generates command wrappers and can support events. Still RC-line. |
| `ts-rs` | Good DTO exporter | High | Mature for shared types, but does not generate Tauri command clients. |
| `tauri-typegen` | Interesting command generator | Low to medium | Can scan commands and generate TypeScript, with optional Zod. Smaller ecosystem. |
| `TauRPC` | Strong RPC abstraction | Medium | More opinionated than normal Tauri commands. |
| `rspc` | Full router/RPC layer | Medium | Useful if the IPC boundary becomes a router. Too much for the current need. |
| Manual `invoke<T>` | Simple | High | Leaves command names and arguments stringly typed. |

**Key finding**: `ts-rs` is more mature, but it solves only the shared type problem. `tauri-specta` solves the command boundary problem.

**Implication**: Use `tauri-specta` for the Tauri IPC surface. Do not add `ts-rs` unless a separate non-Tauri DTO export problem appears.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Binding tool | 1 evidence | `tauri-specta` v2 | It is the active Tauri v2 binding line and generates command wrappers, not just DTOs. |
| Version policy | 1 evidence | Pin exact RC versions | The crates are still `2.0.0-rc.*`; exact pins prevent surprise generator changes. |
| Generated output | 2 coherence | Check in generated TypeScript | Generated IPC clients are part of the contract and should be reviewable. |
| Generation trigger | 2 coherence | Rust test plus package script | The Anarlog pattern is simple and keeps generation close to command registration. |
| Migration scope | 2 coherence | Start with `apps/whispering` only | It is the only current Tauri app with raw app commands in this repo. |
| Frontend import location | 3 taste | `$lib/tauri/bindings.gen` | Keeps generated app bindings near other Whispering frontend code. |
| Result handling | Deferred | Decide during implementation | We need to inspect each command return shape and choose whether to use generated `Result<T, E>` wrappers or preserve existing `tryAsync` wrappers around thrown errors. |
| Event bindings | Deferred | Do not migrate events in phase 1 | The current problem is command drift. Tauri event imports can stay direct until there is a typed event need. |

## Architecture

### Before

```txt
Rust command
  #[tauri::command]
        |
        v
tauri::generate_handler![command_name]
        |
        v
Frontend
  invoke<ClaimedReturn>('command_name', { claimedArg })
```

The command name, argument names, and return type are repeated by hand.

### After

```txt
Rust command
  #[tauri::command]
  #[specta::specta]
        |
        v
make_specta_builder()
  collect_commands![command_name]
        |
        +-- runtime: specta_builder.invoke_handler()
        |
        +-- codegen: export_types test
                 |
                 v
          src/lib/tauri/bindings.gen.ts
                 |
                 v
          Frontend
            commands.commandName(...)
```

The Rust signature becomes the source of truth.

### File Shape

```txt
apps/whispering
  src-tauri
    Cargo.toml
    src
      lib.rs
      recorder/commands.rs
      transcription/mod.rs
      command.rs
      markdown.rs

  src
    lib
      tauri
        bindings.gen.ts
        commands.ts
```

`bindings.gen.ts` is generated. `commands.ts` is optional, handwritten, and can adapt generated command results into existing app service conventions if that keeps the first migration smaller.

## Implementation Plan

### Phase 1: Prove Generation Without Migrating Call Sites

- [ ] **1.1** Add exact pinned Rust dependencies in `apps/whispering/src-tauri/Cargo.toml`: `specta`, `specta-typescript`, and `tauri-specta` with `derive` and `typescript`.
- [ ] **1.2** Enable the Tauri `specta` feature if required by the selected `tauri-specta` version.
- [ ] **1.3** Add `#[specta::specta]` to each app command currently registered in `tauri::generate_handler!`.
- [ ] **1.4** Create `make_specta_builder<R: tauri::Runtime>()`.
- [ ] **1.5** Add an `export_types` Rust test that writes `../src/lib/tauri/bindings.gen.ts`.
- [ ] **1.6** Run the export test and commit the generated file.
- [ ] **1.7** Keep `tauri::generate_handler!` unchanged until generated output is verified.

### Phase 2: Switch Runtime Registration

- [ ] **2.1** Replace `tauri::generate_handler![...]` with `specta_builder.invoke_handler()`.
- [ ] **2.2** Confirm the Tauri app still starts.
- [ ] **2.3** Run command smoke checks for recorder device enumeration, markdown file operations, command execution, and one local transcription path where feasible.

### Phase 3: Migrate Frontend Call Sites

- [ ] **3.1** Replace direct `invoke` calls in desktop service modules with generated `commands.*` calls.
- [ ] **3.2** Keep non-command Tauri APIs direct: path, fs plugin, shell plugin types, window, event, tray, menu, and updater APIs do not move through generated app bindings.
- [ ] **3.3** Remove hand-written return type assertions that duplicate generated types.
- [ ] **3.4** Add or update service tests where command result handling changes.

### Phase 4: CI And Guardrails

- [ ] **4.1** Add an app script such as `bindings:tauri`.
- [ ] **4.2** Add a root or app check that regenerates bindings and fails on diff.
- [ ] **4.3** Document the command authoring rule near Whispering's Tauri source: new commands need both `#[tauri::command]` and `#[specta::specta]`.
- [ ] **4.4** Add a grep check or review checklist item to avoid new raw `invoke('app_command')` calls.

### Phase 5: Follow-Up Cleanup

- [ ] **5.1** Decide whether app-specific command error shapes should move from `String` to typed Rust error enums.
- [ ] **5.2** Consider typed Tauri event bindings if event payloads become app-owned contracts.
- [ ] **5.3** Revisit `tauri-specta` when `2.0.0` final lands and decide whether to unpin to a narrow compatible range.

## Testing Plan

Generation checks:

```bash
bun run --cwd apps/whispering tauri
cargo test --manifest-path apps/whispering/src-tauri/Cargo.toml export_types
git diff -- apps/whispering/src/lib/tauri/bindings.gen.ts
```

Frontend checks:

```bash
bun run --cwd apps/whispering typecheck
```

Runtime smoke checks:

```txt
1. Start Whispering with bun run --cwd apps/whispering dev:local.
2. Confirm the app opens.
3. Enumerate microphones from the recording settings.
4. Start and stop a short recording.
5. Run a command-backed ffmpeg check from the app path that already does this today.
6. Save or materialize markdown output and confirm files are written.
```

## Risks

### RC Dependency Churn

Specta v2 is active but not stable. The mitigation is exact pins, checked-in generated output, and CI diff checks.

### Type Export Gaps

Some Rust types may not export cleanly on the first pass, especially types borrowed from external crates. The mitigation is to introduce local serializable DTOs at the command boundary instead of exporting internal implementation types.

### Result Shape Confusion

`tauri-specta` can generate `Result<T, E>` wrappers, while existing frontend code often uses `tryAsync` around raw `invoke`. The migration should choose one convention per service and avoid mixing both in the same function.

### Over-Broad Migration

Tauri plugin APIs should not move into app command bindings. The migration is only for app-owned `#[tauri::command]` functions.

## Open Questions

1. Should generated bindings live at `$lib/tauri/bindings.gen.ts` or `$lib/services/desktop/tauri.gen.ts`?
2. Should we keep a handwritten `$lib/tauri/commands.ts` adapter during migration, or migrate services directly to generated `commands`?
3. Should Rust command errors stay as `String` for phase 1, or should high-traffic commands move to typed serializable error enums first?
4. Should the generated file include `// @ts-nocheck`, as Anarlog does, or should we keep it type-checked and fix generator output if needed?

## Recommendation

Adopt `tauri-specta` v2 for Whispering, but treat it as an actively maintained RC dependency. The right posture is deliberate: exact pins, generated files in git, a regeneration diff check, and a small first migration. If that proves clean, migrate all app-owned Whispering commands and make the pattern the default for future Tauri work.
