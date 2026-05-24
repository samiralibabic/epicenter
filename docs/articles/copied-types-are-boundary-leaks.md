# Copied Types Are Boundary Leaks

These are a lot of code smells that we should definitely try to remove or prevent in the future. They look like TypeScript cleanup at first, but the deeper smell is architectural: a local type is copying a shape that already belongs somewhere else.

The obvious version has a name ending in `Like`:

```typescript
type AuthClientLike = {
	signOut(): Promise<void>;
};

function bindSignOut(auth: AuthClientLike) {
	return auth.signOut();
}
```

That type is not a contract. It is a shadow of another object. The caller only needs one operation, so name that operation in the caller's language:

```typescript
type SignOut = () => Promise<void>;

function bindSignOut(signOut: SignOut) {
	return signOut();
}
```

Now the dependency says what the function needs, not where one implementation happened to come from.

## `Like` Types Usually Mean Nobody Owns the Shape

`Like` is a useful word at true system boundaries. A test helper may accept a tiny fake. A compatibility layer may accept a browser-shaped object. A parser may inspect unknown input before a schema owns it.

Inside typed production code, though, `Like` often means the owner was nearby and we walked around it:

```typescript
type WorkspaceLike = {
	ydoc: Y.Doc;
	[Symbol.dispose](): void;
};

const workspace = value as WorkspaceLike;
workspace[Symbol.dispose]();
```

If `value` came from our own workspace factory, the factory should own the handle type:

```typescript
export type WorkspaceHandle = ReturnType<typeof createWorkspaceHandle>;

const workspace: WorkspaceHandle = createWorkspaceHandle();
workspace[Symbol.dispose]();
```

If `value` came from outside the system, validate or brand it at the boundary. Do not spread the cast across internal code.

The decision tree is boring on purpose:

```txt
External library owns it? Import it.
Runtime schema owns it? Infer it.
Factory owns it? ReturnType it.
Function owns it? Parameters or ReturnType it.
Caller only needs one verb? Name the capability function.
Test needs an incomplete object? Keep the fake in the test.
```

The answer is almost never "copy the object and add `Like` to the end."

## `Record<string, unknown>` Is a Boundary, Not a Utility Type

`as Record<string, unknown>` is fine right after `JSON.parse`, plugin loading, CLI argv parsing, or another untrusted edge. It is not fine as a casual escape hatch in already-typed code.

```typescript
function readToken(session: AuthSession) {
	const record = session as Record<string, unknown>;
	return typeof record.token === 'string' ? record.token : null;
}
```

That cast says `AuthSession` does not actually know whether it has a token. Either the type is wrong, or this code is reading the wrong object.

The fix should move the uncertainty earlier:

```typescript
const AuthSession = type({
	token: 'string',
	user: AuthUser,
});

type AuthSession = typeof AuthSession.infer;
```

Now unknown input is parsed once. Everything downstream gets the typed result.

## Single-Method `Pick` Keeps the Old Object Alive

`Pick<T, 'method'>` looks narrow, but the object name still pulls in the old boundary.

```typescript
type OpenSnapshotOptions = {
	machineAuth?: Pick<MachineAuth, 'getOfflineEncryptionKeys'>;
};
```

`openSnapshot()` does not coordinate machine auth. It loads keys for a snapshot. That deserves a caller-owned capability:

```typescript
type LoadOfflineEncryptionKeys = () => Promise<EncryptionKeys | null>;

type OpenSnapshotOptions = {
	loadOfflineEncryptionKeys?: LoadOfflineEncryptionKeys;
};
```

Do not stop at `MachineAuth['getOfflineEncryptionKeys']` unless `MachineAuth` is still the caller's real concept. Indexed access can be the same leak in a smaller shape.

## Tests Should Not Make Production Types Worse

Tests often expose the smell first. A test wants to fake one method, so production code grows a copied type to accept the fake:

```typescript
type ClientLike = {
	fetch(input: RequestInfo): Promise<Response>;
};

function createService(client: ClientLike) {
	return client.fetch('/health');
}
```

If production really needs "fetch a response," make that the production seam:

```typescript
type FetchResponse = (input: RequestInfo) => Promise<Response>;

function createService(fetchResponse: FetchResponse) {
	return fetchResponse('/health');
}
```

Then the test fake is honest and tiny:

```typescript
const fetchResponse = async () =>
	new Response(JSON.stringify({ ok: true }));

createService(fetchResponse);
```

When the real production contract is larger, keep the contract and make the test fake satisfy it at the boundary:

```typescript
const fakeAuth = {
	state: signedInState,
	async signOut() {
		return { ok: true, value: undefined };
	},
} satisfies AuthClient;
```

That way incomplete objects stay visible in tests. Production code does not grow optional branches, casts, or `Like` types just because a fake was convenient.

## `Parameters<typeof fn>[n]` Can Be Honest Or Desperate

Deriving a type from a function signature is often the right move:

```typescript
type VerifyOptions = Parameters<typeof verifyAccessToken>[1];
```

The smell is the test-only version where a helper digs through indexes because no one named the seam:

```typescript
type FakeStore = Parameters<typeof createSyncBinding>[0]['store'];
```

That might be a useful derived type if `store` is the public concept. More often, it means the test wants one operation:

```typescript
type ReadSnapshot = (id: DocumentId) => Promise<Snapshot | null>;
```

The rule is not "ban indexed access." The rule is "make the owner obvious." If the owner is a function signature, derive from it. If the owner is the caller's one verb, name the verb.

## The Review Pass

This is the audit I want agents and humans to run before accepting another local shape copy:

```bash
rg "type\s+\w+Like\b|interface\s+\w+Like\b" packages apps
rg "as\s+\w+Like\b" packages apps
rg "as\s+Record<string, unknown>" packages apps
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
rg "Parameters<typeof\s+[^>]+>\[[0-9]+\]" packages apps
```

For each hit, read the surrounding code before judging it. The categories are simple:

| Classification | Leave or change |
| -------------- | --------------- |
| Justified boundary | Leave it, preferably with a comment naming the boundary |
| Test fake only | Keep it in the test and use `satisfies` where it helps |
| Refactor candidate | Derive from the owner or name the caller-owned capability |
| False positive | Leave it |

The useful question is not "can TypeScript express this?" TypeScript can express almost anything if you are patient enough. The useful question is "who owns this shape?"

Once you find the owner, the code usually gets smaller.
