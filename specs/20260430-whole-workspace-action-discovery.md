# Whole-Workspace Action Discovery

Status: superseded by explicit daemon host config.

This spec proposed scanning the whole returned workspace object for action
leaves. That direction was rejected. The daemon now exposes only the explicit
`DaemonWorkspace.actions` root.

## Current Rule

Daemon action paths use two pieces:

```text
<host.route>.<path inside host.actions>
```

Given this host:

```ts
return {
	actions: {
		entries: {
			add: defineMutation({ ... }),
		},
	},
	[Symbol.dispose]() {},
} satisfies DaemonWorkspace;
```

The runnable path is:

```sh
epicenter run notes.entries.add
```

An action leaf outside `actions` is ignored:

```ts
return {
	actions: {},
	debug: {
		reset: defineMutation({ ... }),
	},
	[Symbol.dispose]() {},
} satisfies DaemonWorkspace;
```

`notes.debug.reset` is not public because `debug` is not under
`DaemonWorkspace.actions`.

## Type Contract

`DaemonWorkspace.actions` uses the recursive `Actions` type:

```ts
export type Actions = {
	[key: string]: Action | Actions;
};
```

That is the public authoring shape: each key is either a `defineQuery` or
`defineMutation` leaf, or another object containing action leaves.

## Why This Replaced Whole-Workspace Scanning

Whole-workspace scanning made returned infrastructure part of the public API by
accident. Any plain object containing an action leaf could become callable.
That put pressure on every daemon host return shape to hide implementation
details carefully.

The explicit `actions` root makes the boundary visible:

```txt
host.route
  selects the daemon host

host.actions
  defines the public runnable surface

host.sync, host.presence, host.rpc, materializers, tables
  remain infrastructure unless the host deliberately wraps them in actions
```

## RPC Alignment

Peer RPC should receive the same action root the host wants peers to call:

```ts
const rpc = sync.attachRpc(doc.actions);
```

For a daemon peer call:

```sh
epicenter run notes.entries.add --peer laptop
```

The daemon selects the `notes` host locally, then sends only the inner action
path over RPC:

```text
entries.add
```

## Rejected Rules

- No whole returned-workspace scan.
- No hidden `workspace.actions` prefix in CLI paths.
- No short-path aliasing.
- No `attachActions` primitive.
- No registry marker on `defineActions`.
