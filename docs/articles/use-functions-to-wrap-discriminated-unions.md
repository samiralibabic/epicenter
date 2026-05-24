# Use Functions to Wrap Discriminated Unions

Discriminated unions eliminate invalid states. They also make every call site spell out a discriminant key the developer already communicated by choosing which fields to pass. The fix: replace one function with N discriminant keys with N functions that each inject the discriminant internally.

## The Problem

A discriminated union with three variants means every consumer writes the discriminant by hand:

```typescript
type Auth =
	| { kind: 'none'; url: string }
	| { kind: 'static'; url: string; token: string }
	| { kind: 'dynamic'; url: string; loadToken: () => Promise<string> };

// Consumer has to write `kind` every time
connect({ kind: 'none', url: 'ws://localhost:3913' });
connect({ kind: 'static', url: 'ws://my-server:3913', token: 'secret' });
connect({
	kind: 'dynamic',
	url: 'wss://cloud.example.com',
	loadToken: fetchJwt,
});
```

The `kind` field is load-bearing for the implementation but redundant for the caller. If you're passing a `token`, you already know the kind. If you're passing `loadToken`, same thing. The discriminant is just restating what the arguments already say.

## The Fix

Three functions, one per variant. Each injects the discriminant:

```typescript
function noAuth(url: string): Auth {
	return { kind: 'none', url };
}

function staticToken(url: string, token: string): Auth {
	return { kind: 'static', url, token };
}

function dynamicToken(url: string, loadToken: () => Promise<string>): Auth {
	return { kind: 'dynamic', url, loadToken };
}
```

The call sites become:

```typescript
connect(noAuth('ws://localhost:3913'));
connect(staticToken('ws://my-server:3913', 'secret'));
connect(dynamicToken('wss://cloud.example.com', fetchJwt));
```

The function name replaces the discriminant key. The consumer picks which function to call; the implementation still gets a clean union to switch on.

## Why This Works Better Than Overloads

You might think function overloads solve this:

```typescript
function connect(url: string): void;
function connect(url: string, token: string): void;
function connect(url: string, loadToken: () => Promise<string>): void;
```

But `token` and `loadToken` are both functions or strings in other contexts. Overloads rely on TypeScript distinguishing argument types at the call site, which gets fragile when types overlap or when you need to store the config before passing it. Separate functions are unambiguous: the name carries the intent, not the argument types.

The other advantage: the config object is a first-class value. You can store it, pass it around, serialize it. Overloads disappear at the call boundary.

```typescript
// Config can travel through your app as data
const auth = staticToken('ws://my-server:3913', 'secret');
saveToSettings(auth);
// later
connect(loadFromSettings());
```

## The Pattern Generalized

Any discriminated union where the discriminant is an implementation detail (not something the consumer cares about naming) benefits from wrapper functions. The shape is always the same:

```typescript
// Internal: discriminated union
type Action =
	| { type: 'create'; name: string }
	| { type: 'rename'; id: string; name: string }
	| { type: 'delete'; id: string };

// External: one function per variant
function create(name: string): Action {
	return { type: 'create', name };
}

function rename(id: string, name: string): Action {
	return { type: 'rename', id, name };
}

function remove(id: string): Action {
	return { type: 'delete', id };
}
```

The functions are trivial. That's the point. Each one does exactly one thing: construct the right variant with the right discriminant. No logic, no validation, no branching. The type system guarantees correctness at the boundary; the implementation gets a union it can exhaustively switch on.

| What the consumer sees | What the implementation sees          |
| ---------------------- | ------------------------------------- |
| `create('my-doc')`     | `{ type: 'create', name: 'my-doc' }`  |
| `rename(id, 'new')`    | `{ type: 'rename', id, name: 'new' }` |
| `remove(id)`           | `{ type: 'delete', id }`              |

One function per variant. The function name is the discriminant.

## Related

- [Three Auth Modes, One Config Object, Zero Invalid States](./discriminated-unions-over-optional-fields.md) : the full progression from optional fields to discriminated unions to factory functions
