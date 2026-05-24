# A Single-Method `Pick` Is Often a Boundary Leak

A single-method `Pick` often means the old object boundary leaked into a place that only needed one verb.

That is the whole smell. `Pick` is not bad. It is useful when you are projecting a data shape, trimming a DTO, or naming the part of a type a caller can see. The problem shows up when `Pick` becomes dependency injection:

```ts
type OpenSnapshotOptions = {
	machineAuth?: Pick<MachineAuth, 'getOfflineEncryptionKeys'>;
};
```

This looks nicely narrow. It is not. `openSnapshot()` does not participate in the `MachineAuth` life cycle. It does not log in, log out, check status, or refresh credentials. It needs one capability: load offline encryption keys.

Name that capability in the caller's language:

```ts
type LoadOfflineEncryptionKeys = () => Promise<EncryptionKeys | null>;

type OpenSnapshotOptions = {
	loadOfflineEncryptionKeys?: LoadOfflineEncryptionKeys;
};
```

Now the dependency says what the caller needs, not where the implementation happens to come from.

Do not stop at `MachineAuth['getOfflineEncryptionKeys']`. That removes the
object-shaped parameter, but it still derives the caller's dependency from the
wrong concept. If the caller's sentence is about loading snapshot keys, name and
type that capability directly.

## Why the Object Shape Leaks

An object name carries a model with it. If a function accepts `MachineAuth`, even as `Pick<MachineAuth, 'getOfflineEncryptionKeys'>`, a reader has to ask why this layer knows about machine auth at all.

Sometimes that is the right question. If the caller owns auth state, handles login flows, checks status, and logs out, then `MachineAuth` is the right boundary.

But if the caller just decrypts a local snapshot, `MachineAuth` is too much context. The object name pulled an auth boundary into a snapshot boundary.

## The Test

Mentally inline the dependency at the call site:

```ts
machineAuth.getOfflineEncryptionKeys({ serverOrigin: EPICENTER_API_URL });
```

Then write the sentence the caller actually cares about:

```txt
Load offline encryption keys for this snapshot.
```

If the sentence does not name the object, the option probably should not either.

## When to Keep the Object

Keep the object shape when the caller genuinely participates in that object's life cycle or needs the rest of the capability family:

```ts
type AuthLifecycleBindingOptions = {
	auth: MachineAuth;
};
```

That caller might check status, prompt for login, read tokens, and log out. The object is the domain concept. Passing a bag of individual callbacks would hide the relationship between those operations.

Keep the object when:

- the caller coordinates several methods from the same domain
- the object has meaningful construction or teardown semantics
- the object name is the concept the caller is actually working with
- splitting it into callbacks would create a bag of unrelated steps

## When to Use a Capability Function

Prefer a named function when the caller needs one verb:

```ts
type GetBearerToken = () => Promise<string | null>;
type LoadOfflineEncryptionKeys = () => Promise<EncryptionKeys | null>;
type ReportSyncError = (error: SyncError) => void;
```

The function name should belong to the caller. `loadOfflineEncryptionKeys` is a better snapshot dependency than `getOfflineEncryptionKeys` because the snapshot is loading keys to read local data. The auth facade can still implement it. The caller does not need to inherit auth vocabulary.

Use a capability function when:

- only one method is used
- tests fake one method and ignore the rest of the object
- the object name belongs to another layer
- the method needs a clearer name in the caller's domain

## The Practical Rule

Do not ban `Pick`. Ban autopilot.

When you write this:

```ts
Pick<Thing, 'method'>
```

stop and ask:

```txt
Does this caller need Thing, or does it need one verb?
```

If it needs one verb, name the verb. If it needs the object life cycle, pass the object.

The same rule catches indexed method aliases:

```ts
Thing['method']
```

That can be the same boundary leak in a smaller costume. If `Thing` is not in
the caller's one-sentence job, the capability type should not come from
`Thing`.
