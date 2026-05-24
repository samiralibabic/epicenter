import type { DaemonWorkspaceDefinition } from '../daemon/define-daemon-workspace.js';
import type { DaemonRuntime } from '../daemon/types.js';
import {
	defineConfig,
	defineWorkspace,
	type EpicenterConfig,
} from './define-config.js';

// `defineConfig` and `defineWorkspace` are both `(x) => x`. The contract worth
// pinning is type inference, asserted via @ts-expect-error and the Equal
// type-level test. Runtime identity is JS-trivial and covered indirectly by
// load-project-config.test.ts.

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

// `defineWorkspace` takes a `DaemonWorkspaceDefinition` directly and returns
// it. The inferred type preserves the runtime generic; declaring the return
// type of `open()` as `DaemonRuntime` pins TRuntime concretely so the Equal
// check below compares against the default-typed definition.
const workspace = defineWorkspace({
	async open(): Promise<DaemonRuntime> {
		return undefined as unknown as DaemonRuntime;
	},
});
export type InferredWorkspaceIsDefinition = Expect<
	Equal<typeof workspace, DaemonWorkspaceDefinition<DaemonRuntime>>
>;

// @ts-expect-error a workspace definition must expose open().
defineWorkspace({});

// @ts-expect-error open() must be a function.
defineWorkspace({ open: 1 });
