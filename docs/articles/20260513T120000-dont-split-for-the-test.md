# Don't Split for the Test

You're looking at a module with two functions where there should be one. The outer is a handler or a wrapper or a thin Svelte factory. Its body is a single call to the inner, plus a little formatting. The inner is exported. The only other caller of the inner lives in a `.test.ts` file next door.

The split exists for the test. The production code never asked for it.

That's the smell. The test reached for an invariant the natural API didn't surface, so somebody carved out an inner function the test could call directly, with whatever fakes it needed. The carving stayed permanent. Now every reader of the module has to understand two functions instead of one, every refactor has to keep both names stable, and every new contributor inherits a structure shaped not by the system but by the test suite.

The cure isn't a cleverer split. It's gluing the pieces back into one.

## A Real Example

Last week the `@epicenter/svelte` package had this:

```
session-lifecycle.ts        47 LOC
session-lifecycle.test.ts  187 LOC
session.svelte.ts           69 LOC
```

`session-lifecycle.ts` exported a `createSessionLifecycle()` function that owned the auth state machine: build a payload on sign-in, dispose on sign-out, leave reauth alone. To let the test reach the payload slot, the function took two parameters describing the slot from the outside:

```ts
createSessionLifecycle({
    auth,
    build,
    getPayload: () => payload,
    setPayload: (next) => { payload = next; },
});
```

`session.svelte.ts` was the only production caller. It declared `let payload = $state(...)` and forwarded read/write through those two closures. The test wrote its own holder helper, stubbed the same closures, and asserted on the slot it owned.

Read the file paths. The inner has one consumer, and that consumer lives next door. Read the test. Every assertion reads a value visible only because the seam exists. Read the outer. Its body is a `$state` declaration plus a forwarding call. Three smells in one shape.

We deleted the inner, deleted the test, let `$state` live in the outer. The state machine collapsed to four lines:

```ts
function reconcile(state: AuthState) {
    if (state.status === 'signed-out') {
        payload?.[Symbol.dispose]();
        payload = null;
    } else {
        payload ??= build(state.identity);
    }
}
```

`payload ??= build(state.identity)` is the reauth-preservation invariant. It's a single operator. `T extends Disposable` enforces the dispose call site at the type level. The four behaviors the 187-line test asserted are now visible in plain sight, and every app exercises them on boot. Net: minus 265 lines, three files to one, two injection points to zero.

The test was ten times the size of the system it was protecting, and that was the signal.

## The Same Shape Elsewhere

Once you see it, you see it everywhere.

In `epicenter ps`:

```ts
export type RunPsDeps = {
    pingDaemon?: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
};

export async function runPs(deps: RunPsDeps = {}): Promise<PsRow[]> {
    const ping = deps.pingDaemon ?? pingDaemon;
    // ... the actual work
}

export const psCommand = cmd({
    handler: async () => {
        const rows = await runPs();           // ← no deps in production
        if (rows.length === 0) { ... }
        console.table(rows);
    },
});
```

The handler calls `runPs()` with no arguments. The test calls `runPs({ pingDaemon: async () => true })`. Two callers, one production, one test. The export exists for the test.

In `epicenter down`:

```ts
export type RunDownDeps = {
    shutdown?: (sock: string, ms: number) => Promise<Result<unknown, unknown>>;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
};

export async function runDown(options: DownOptions, deps: RunDownDeps = {}) { ... }

export const downCommand = cmd({
    handler: async (argv) => {
        const result = await runDown({ projectDir: argv.C, all: argv.all });
        // ... render
    },
});
```

Same shape. Two callers, one production with empty deps, one test that injects fakes.

The pattern reads like helpful defensiveness. "We made it injectable so we could unit test the SIGTERM fallback." But the injection point exists only in service of the test; production never threads anything through. The structure of the file is a fossil of the test's needs.

## What to Do About It

Glue them back. Inline the inner into the outer. Drop the seam.

Then pay the coverage bill differently:

- **Integration test.** Drive the natural boundary: invoke the CLI, mount the Svelte component, hit the HTTP endpoint. Heavier setup, more realistic coverage. The boundary the test was reaching past is the one users actually cross.
- **Type-level invariant.** If the test was asserting "we always call `dispose()` on the way out," encode it: `T extends Disposable`, a branded return type, a `using` declaration. The type system enforces what the test was watching for, on every call, forever.
- **No test.** When the branch logic is small, trivially type-checked, and exercised on every product use, the unit test was insurance you didn't need. The deletion is honest, not lazy. Document the risk decision in the commit and move on.

The third option scares people because we're trained to equate "more tests" with "better code." It isn't a one-way ratchet. Coverage of trivial branches at the cost of permanent architectural distortion is a bad trade. Delete the trivial test; keep the cohesion.

## How to Spot It

The procedure, when reviewing a module:

1. **Count callers.** Grep for the inner function's name across the workspace, excluding the test file. If the count is one and that one is the obvious wrapper next door, you have a candidate.
2. **Read the outer.** If its body is "call the inner plus format," the outer has no independent logic and the inner has no independent product sentence.
3. **Read the test.** For each `expect()`, ask: would this assertion be possible without the seam? If no, the test wrote the API.
4. **Count LOC.** Test versus SUT. The danger zone is when the test is comparable to or larger than the system being tested.
5. **Ask the counterfactual.** Without the test, would I have written this as two pieces? If no, inline.

Hit three or more of these and the helper is test-shaped, not code-shaped.

## When the Split is Real

Inlining isn't always right. Keep the split when:

- The inner has multiple real production consumers. Reuse earns the stability tax.
- The inner has its own product sentence. "Compile a markdown table from rows" is a real concept; "the inner half of `ps`" is not.
- The seam carries policy (a decision the caller owns: what to do on error, how to reload, when to retry). Policy callbacks earn their place.
- The seam crosses a real runtime boundary that's expensive or dangerous to exercise (process signals, network IO that can't be faked cheaply). Even then, the threshold is "is it worth it" not "is it possible."

The question is never "could I justify the split?" You can always justify a split. The question is "would I have written this if the test weren't here?"

## The Trap

The framing "make it injectable for tests" feels professional. You're being defensive. You're enabling unit coverage. You're following SOLID. The trap is that every injection point is a permanent shape, and you pay for it forever in indirection, type ceremony, and contributor confusion. The unit test pays you back in seconds-of-CI-time and one shallow regression check.

The good shape is code structured for the system, coverage paid through the natural boundary. The bad shape is code structured for the test, coverage paid through an artificial seam.

When the test asks for a shape your production code wouldn't otherwise need, the answer isn't "give it the shape." The answer is "test it a different way, or don't test it." Cohesion first. Coverage second. Don't split for the test.
