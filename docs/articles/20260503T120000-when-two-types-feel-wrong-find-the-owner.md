# When Two Types Feel Wrong, Find the Owner

Historical note, 2026-05-03: this article captures an earlier auth cleanup that
made `AuthCredential` the local owner. The later local auth session clean break
superseded that model. Current code uses `AuthSession` as the local persisted
shape, while `BetterAuthSessionResponse` is only the server response boundary.

When I sense this tension, I immediately think: okay, we could have two types, one derived from the other, the other derived from the first, or both extending a shared base type. That reflex is good. But the trick is not picking one of those patterns first. The trick is asking which concept owns the truth.

Here was the smell:

```typescript
import type { Session as AuthSession } from '../auth-types.js';
import type { Session as StoredSession } from '../contracts/session.js';
```

Two imports named `Session` in the same file. One gets renamed to `AuthSession`, the other to `StoredSession`, and suddenly the reader has to reverse engineer the architecture from aliases.

The first answer is usually a type-system answer:

```txt
Option A: keep two types
Option B: derive A from B
Option C: derive B from A
Option D: extract a base type and extend both
Option E: stop. Maybe this is the wrong boundary.
```

Those are implementation choices. They are not the design yet.

## The Type Shape Is Not the Ownership Shape

The two session types looked similar because they shared fields:

```typescript
type AuthSession = {
	token: string;
	user: StoredUser;
	encryptionKeys: EncryptionKeys;
};

type StoredSession = {
	user: StoredBetterAuthUser;
	session: StoredBetterAuthSession;
	encryptionKeys: EncryptionKeys;
};
```

The overlap tempts you toward a base type:

```typescript
type SessionBase = {
	user: StoredUser;
	encryptionKeys: EncryptionKeys;
};
```

That is sometimes right. But it is only right if `SessionBase` is a real concept in the system, not just the largest common subset TypeScript could find.

In this case, the sharper question was:

```txt
Who owns the credential?
```

Once you ask that, the shape changes.

```txt
AuthCredential
|-- serverOrigin
|-- authorizationToken
|-- user
|-- serverSession
`-- encryptionKeys
```

Now the old types stop looking like peers. They become projections.

## Projections Should Derive From the Aggregate

If the credential is the real thing, the app snapshot can be a smaller view:

```typescript
export type AuthSnapshotSession = Pick<
	AuthCredential,
	'authorizationToken' | 'user' | 'encryptionKeys'
>;
```

The machine credential summary is another view:

```typescript
export type AuthCredentialSummary = {
	serverOrigin: AuthCredential['serverOrigin'];
	user: Pick<AuthCredential['user'], 'id' | 'name' | 'email'>;
	serverSession: Pick<AuthCredential['serverSession'], 'expiresAt'>;
	savedAt: string;
	lastUsedAt: string;
};
```

That is very different from making two independent session types and hoping structural typing keeps them aligned. The shared fields have one owner. The projections can be as small as their callers need.

## A Shared Base Is Only Right When the Base Has a Name You Believe

This is the decision tree I want to keep using:

```txt
Do the two types represent the same concept?
  Yes: collapse them into one type.

Does one type represent the full concept and the other a view?
  Yes: define the full concept, derive the view.

Do both types represent views of a larger concept?
  Yes: define the larger concept, derive both views.

Do they only share fields by coincidence?
  Yes: keep them separate. Duplication is cheaper than fake inheritance.

Does every option feel awkward?
  Yes: look for the invariant or move the boundary.
```

The last case matters. A shared base type can be a lie. If you extract `HasUserAndEncryptionKeys` only because two objects happen to contain those fields, you have created vocabulary that nobody speaks.

Good bases sound like domain language:

```typescript
type AuthCredential = {
	user: AuthUser;
	serverSession: AuthServerSession;
	encryptionKeys: EncryptionKeys;
};
```

Weak bases sound like type trivia:

```typescript
type HasUserAndEncryptionKeys = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};
```

The first one tells you what the object is. The second tells you what fields TypeScript noticed.

## Option E Means the Frame Is Probably Wrong

Sometimes all four type moves feel bad. Keeping two types feels duplicative. Deriving one from the other feels backwards. A shared base feels fake. That is usually not a TypeScript problem anymore.

It means one of the invariants is hiding.

```txt
The auth snapshot must always have the current authorization token.
The machine credential must preserve expiry metadata without loading secrets.
The server response must mirror Better Auth before we normalize it.
```

Those sentences are more useful than the type shapes. They tell you what must stay true, who can know it, and where the boundary belongs.

This is where "invariant" is the right word. Inversion of control may be the fix if the wrong layer is making the decision. A new storage boundary may be the fix if one object is trying to represent both public metadata and private secrets. A rename may be enough if the code is sound but the vocabulary is lying.

Option E is not another type pattern. It is permission to reject the current framing.

## Storage Should Follow Secret Boundaries, Not Type Boundaries

The auth case had one more wrinkle: machine credentials do not store everything in one public JSON object. The public metadata can live in `credentials.json`; tokens and keys may belong in the keychain.

That does not mean the model needs to fracture into five concepts.

```txt
AuthCredential
|-- public metadata
|   |-- serverOrigin
|   |-- user
|   `-- serverSession without token
|
`-- secret values
    |-- authorizationToken
    |-- serverSessionToken
    `-- encryptionKeys
```

The storage split is physical. The credential is still conceptual. A repository can rehydrate the aggregate from the public record plus the secret blob.

That is the clean break: one model, multiple storage representations.

## The Move

When duplicate types feel wrong, do not start by choosing between inheritance, derivation, or a shared base. Start by naming the owner and the invariant.

If you can say, "this object is the thing, and these other shapes are views of it," derive the views. If you cannot say that, keep looking. The type problem is usually pointing at an ownership problem.

The goal is not fewer types. The goal is fewer competing truths.
