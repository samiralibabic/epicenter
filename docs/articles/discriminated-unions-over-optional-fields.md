# Three Auth Modes, One Config Object, Zero Invalid States

You're building a sync provider. It connects to a WebSocket server and syncs data. Authentication has three modes: no auth (local network), a static token (self-hosted), or a dynamic token function (cloud). The first instinct is a config object with optional fields:

```typescript
type SyncProviderConfig = {
	url: string;
	/** Static shared secret, set once when the server starts. */
	token?: string;
	/** Fetches a short-lived JWT from your auth service on each connection. */
	loadToken?: (workspaceId: string) => Promise<string>;
};
```

This works. You can pass just a URL, or a URL with a token, or a URL with a loadToken callback. Three valid combinations. But there's a fourth combination TypeScript won't stop you from writing:

```typescript
createSyncProvider({
	url: 'wss://sync.example.com',
	token: 'my-static-secret',
	loadToken: async (id) => fetchJwt(id),
});
```

Both `token` and `loadToken` present. Which one wins? The spec says "mutually exclusive" in a JSDoc comment, but comments don't compile.

## The Real Cost

The JSDoc comment `Mutually exclusive with loadToken` is documentation debt. Someone will miss it. The provider implementation has to handle the impossible state anyway:

```typescript
function createSyncProvider(config: SyncProviderConfig) {
	if (config.token && config.loadToken) {
		throw new Error('Cannot specify both token and loadToken');
	}
	// ...
}
```

Runtime validation for something the type system should catch at compile time. Every consumer reads the docs, hopes they got it right, and finds out at runtime if they didn't.

## Discriminated Unions Fix the Type Problem

Instead of optional fields, model the three modes as explicit variants:

```typescript
type SyncProviderConfig =
	| { mode: 'open'; url: string }
	| { mode: 'static-token'; url: string; token: string }
	| {
			mode: 'dynamic-token';
			url: string;
			loadToken: (workspaceId: string) => Promise<string>;
	  };
```

Now the invalid state is unrepresentable. TypeScript won't let you pass `token` when `mode` is `'dynamic-token'`. The `mode` discriminant tells both the type system and the reader exactly which auth path this config uses.

The implementation can use an exhaustive switch instead of defensive checks:

```typescript
function createSyncProvider(config: SyncProviderConfig) {
	switch (config.mode) {
		case 'open':
			return connect(config.url);
		case 'static-token':
			return connect(config.url, { protocol: config.token });
		case 'dynamic-token':
			return connect(config.url, { getProtocol: config.loadToken });
		default: {
			const _exhaustive: never = config;
			throw new Error(
				`Unknown mode: ${(_exhaustive as SyncProviderConfig).mode}`,
			);
		}
	}
}
```

No runtime validation for invalid combinations. The type system already eliminated them.

## The DX Problem

Discriminated unions solve the correctness problem but add friction. Every call site now needs the discriminant key:

```typescript
// Before: just pass what you need
createSyncProvider({ url: 'ws://localhost:3913' });

// After: always spell out the mode
createSyncProvider({ mode: 'open', url: 'ws://localhost:3913' });
createSyncProvider({
	mode: 'static-token',
	url: 'ws://my-server:3913',
	token: 'secret',
});
createSyncProvider({
	mode: 'dynamic-token',
	url: 'wss://cloud.example.com',
	loadToken: fetchJwt,
});
```

The `mode` key is redundant information. When you pass only a URL, the mode is obviously "open." When you pass a token string, the mode is obviously "static-token." The developer already knows which mode they're using by the fields they provide. Forcing them to also declare it is boilerplate.

For an internal API or a library with few consumers, this is fine. For a developer-facing config that people type out by hand, the extra key feels like ceremony.

## Factory Functions as the Final Layer

The solution is to keep the discriminated union as the internal representation but give consumers named factory functions that construct each variant:

```typescript
function openSync(url: string): SyncProviderConfig {
	return { mode: 'open', url };
}

function staticTokenSync(url: string, token: string): SyncProviderConfig {
	return { mode: 'static-token', url, token };
}

function dynamicTokenSync(
	url: string,
	loadToken: (workspaceId: string) => Promise<string>,
): SyncProviderConfig {
	return { mode: 'dynamic-token', url, loadToken };
}
```

Consumers pick the function that matches their auth model. The function name is the discriminant:

```typescript
createSyncProvider(openSync('ws://localhost:3913'));

createSyncProvider(staticTokenSync('ws://my-server:3913', 'my-shared-secret'));

createSyncProvider(
	dynamicTokenSync('wss://cloud.example.com', async (workspaceId) => {
		const res = await fetch('/api/sync/token', {
			method: 'POST',
			body: JSON.stringify({ workspaceId }),
		});
		return (await res.json()).token;
	}),
);
```

Each function accepts only the fields valid for its mode. You can't accidentally pass both `token` and `loadToken` because no single function accepts both. The discriminant `mode` key is injected automatically; the consumer never sees it.

The internal implementation still gets a clean discriminated union to switch on. The external API is a set of focused functions with obvious names and tight signatures.

| Layer    | Sees                            | Guarantees                             |
| -------- | ------------------------------- | -------------------------------------- |
| Consumer | Factory function per mode       | Can't construct invalid config         |
| Internal | Discriminated union with `mode` | Exhaustive switch, no defensive checks |

## When This Pattern Fits

The optional-fields-to-discriminated-union-to-factory-functions progression applies whenever you have a config object with mutually exclusive groups of fields. The trigger is a JSDoc comment that says "mutually exclusive with X." If you're writing that comment, you have a type that permits invalid states.

The factory function layer is optional. If the discriminant key carries meaningful information that consumers should see (like an error `kind` or an event `type`), keep it in the public API. Add factory functions when the discriminant is an implementation detail that the consumer's choice of function already communicates.
