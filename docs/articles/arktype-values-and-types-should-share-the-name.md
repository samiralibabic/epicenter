# Let Arktype Values and Types Share the Name

If an arktype schema exports a runtime value and an inferred type with the same name, import that name once. The schema is a value when you pass it into `type({...})`; the inferred shape is a type when you annotate a parameter or field. TypeScript already has separate namespaces for those two jobs.

This was the smell:

```typescript
import {
	EncryptionKeys as EncryptionKeysSchema,
	type EncryptionKeys,
} from '@epicenter/encryption';

const Session = type({
	encryptionKeys: EncryptionKeysSchema,
});

type SessionResponse = {
	encryptionKeys: EncryptionKeys;
};
```

The alias only exists because we assumed the type import needed its own name. It does not.

```typescript
import { EncryptionKeys } from '@epicenter/encryption';

const Session = type({
	encryptionKeys: EncryptionKeys,
});

type SessionResponse = {
	encryptionKeys: EncryptionKeys;
};
```

The exported module is shaped for this:

```typescript
export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);

export type EncryptionKeys = typeof EncryptionKeys.infer;
```

`EncryptionKeys` in an expression points at the schema value. `EncryptionKeys` in a type position points at the inferred type. There is no runtime ambiguity and no import collision.

Aliases are still useful when two values collide in the same namespace:

```typescript
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { schema as markdownSchema } from 'prosemirror-markdown';
```

That is a real value-space conflict. `EncryptionKeys as EncryptionKeysSchema` next to `type EncryptionKeys` is not. Prefer the shared name for arktype schemas because it makes the contract obvious: this value validates the same thing this type describes.
