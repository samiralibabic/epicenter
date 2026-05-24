# Action Return Shapes: Local Vs Remote

Actions have two type surfaces. A local caller sees the handler exactly as it
was written. A remote caller goes through `collaboration.dispatch()`, so the
result is always a `Result<T, DispatchError>`.

## Call Contexts

```
1. LOCAL
   workspace.actions.tabs_close({...})
   Same process, direct function call, no wrapping.

2. ADAPTER
   epicenter run app.tabs_close
   LLM calls tabs_close tool
   In process, adapter formats the handler result for its surface.

3. REMOTE
   collaboration.dispatch('tabs_close', {...}, { to, signal })
   Crosses the collaboration wire, always Result-wrapped.
```

## One Handler, Every Caller's View

| Caller | Ok path | Err(BrowserApiFailed) | Handler throws |
| --- | --- | --- | --- |
| Local | `{data:{closedCount:1}, error:null}` | `{data:null, error:BrowserApiFailed}` | throws at `await` |
| CLI `epicenter run` | prints `{"closedCount":1}`, exit 0 | stderr + exit 1 | stderr stack trace + exit 1 |
| AI bridge | AI sees `{closedCount:1}` | AI sees tool failure | propagates as tool failure |
| `collaboration.dispatch()` | `Ok({closedCount:1})` | `Err(DispatchError.ActionFailed{cause: BrowserApiFailed})` | `Err(DispatchError.ActionFailed{cause})` |

Remote dispatch coarsens handler errors into `DispatchError.ActionFailed`.
Keep typed `Err` values for local callers and in-process adapters. Once a call
crosses the collaboration wire, the remote caller branches on `DispatchError`.

## Where Wrapping Happens

```
Target (handler owner)                 Caller
----------------------                 ------
attachActionRunner                     collaboration.dispatch
  raw value    -> Ok(raw)               waits for response row
  Result Ok    -> Ok(data)              returns Result<T, DispatchError>
  Result Err   -> ActionFailed(cause)
  throw        -> ActionFailed(cause)
```

Target-side normalization runs inside `attachActionRunner` in
`packages/workspace/src/document/rpc.ts`. The caller receives exactly the
response row through `collaboration.dispatch()`.

## Handler Rule

Return `Err` for failures local callers should branch on. Throw for bugs and
invariants. Remote callers always see either your successful data or a
`DispatchError` variant.

## Example

```typescript
const local = await workspace.actions.tabs_close({ tabIds: [1] });
if (local.error) {
  toast.error(local.error.message);
  return;
}

const remote = await collaboration.dispatch(
  'tabs_close',
  { tabIds: [1] },
  { to: peer.connId, signal: AbortSignal.timeout(10_000) },
);
if (remote.error) {
  switch (remote.error.name) {
    case 'ActionFailed':
      toast.error('Action failed');
      break;
    case 'ActionNotFound':
      toast.error('Action not found');
      break;
    case 'Cancelled':
      toast.error('Request cancelled');
      break;
  }
}
```

If the remote caller needs to know "not found" separately from "handler
crashed", make that a typed local error and add a narrower remote action
surface later. The current peer dispatch API intentionally exposes
`DispatchError`, not each handler's internal error union.

## Invariants

1. Local callers never see `DispatchError`.
2. Handlers can be sync, async, return raw, return `Result`, or throw.
3. Remote normalization runs exactly once per RPC, inside `attachActionRunner`.
4. Remote receivers expect `{ data, error }` from `collaboration.dispatch()`.
5. `DispatchError` lives in `packages/workspace/src/document/rpc.ts` and is re-exported from `@epicenter/workspace`.
