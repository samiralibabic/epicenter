import { defineWorkspace } from '../daemon/define-workspace.js';
import { defineConfig, type EpicenterConfig } from './define-config.js';

// Both `defineConfig` and `defineWorkspace` are `(x) => x`. The contract worth
// pinning lives at the type level. Runtime identity is JS-trivial and covered
// indirectly by load-project-config.test.ts.
//
// We pin two distinct properties:
//
// 1. `defineConfig` widens an empty object literal to `EpicenterConfig`.
//    The Equal check below catches a regression where the signature loses
//    its annotation and the return becomes `{}` instead of the named type.
//
// 2. Both functions refuse wrong-shape inputs. The `@ts-expect-error` lines
//    fail compilation if the constraint stops catching misuse.
//
// We intentionally do NOT add an Equal check for `defineWorkspace`'s return.
// The function is generic and identity-preserving (`<T>(d: Def<T>) => Def<T>`);
// asserting `typeof result === Def<T>` is tautological and only works after
// inventing a fake runtime value (the `return undefined as unknown as
// DaemonRuntime` smell). The constraint failures below already prove the
// type rejection; preservation through identity is a TypeScript invariant
// we don't need to re-verify.

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	(<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected
		? 1
		: 2
		? true
		: false;

const inferred = defineConfig({});
export type InferredConfigIsEpicenterConfig = Expect<
	Equal<typeof inferred, EpicenterConfig>
>;

// @ts-expect-error route values must be daemon workspace definitions.
defineConfig({ daemon: { routes: { demo: { open: 1 } } } });

// @ts-expect-error route values must expose open().
defineConfig({ daemon: { routes: { demo: {} } } });

// @ts-expect-error routes must be a record.
defineConfig({ daemon: { routes: [] } });

// @ts-expect-error top-level routes are no longer accepted.
defineConfig({ routes: [] });

// @ts-expect-error a workspace definition must expose open().
defineWorkspace({});

// @ts-expect-error open() must be a function.
defineWorkspace({ open: 1 });
