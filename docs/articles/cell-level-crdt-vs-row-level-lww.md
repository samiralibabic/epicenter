# The Trade-off: Cell-Level CRDT vs Row-Level LWW

Most CRDT-based databases let you edit individual fields of a record independently. Epicenter doesn't. We use row-level last-write-wins.

This is a deliberate trade-off, and it's not right for every app. Here's how to think about it.

## Cell-Level CRDT: The Default Approach

In a typical CRDT database, each field is an independent data structure:

```
Record: users/alice
├── name: LWW("Alice")        ← Independent CRDT
├── email: LWW("a@b.com")     ← Independent CRDT
└── bio: Y.Text("Hello...")   ← Independent CRDT
```

When Alice updates her name while Bob updates her email, both changes merge:

```
Alice: { name: "Alicia" }     → merged
Bob:   { email: "new@b.com" } → merged
Result: { name: "Alicia", email: "new@b.com", bio: "Hello..." }
```

No conflicts. No data loss. This is the CRDT promise.

## Row-Level LWW: Epicenter's Approach

In Epicenter, the entire row is one atomic blob:

```
Record: users/alice = { name: "Alice", email: "a@b.com", bio: "Hello...", _v: 2 }
                      ↑ One atomic value
```

When Alice and Bob edit simultaneously:

```
Alice: { name: "Alicia", email: "a@b.com", bio: "Hello...", _v: 2 }
Bob:   { name: "Alice", email: "new@b.com", bio: "Hello...", _v: 2 }
```

Last write wins. One of their changes is lost.

## Why Would Anyone Choose Row-Level LWW?

Because it enables something cell-level CRDTs can't: **coherent schema versioning**.

### The Schema Version Problem

With cell-level CRDTs, imagine this scenario:

1. You ship v1 of your app with schema `{ name, email }`
2. You ship v2 with schema `{ name, email, bio }`
3. Alice (on v2) adds a bio
4. Bob (on v1) updates the name
5. After sync, the record has cells from both versions

What schema version is this record? It's neither v1 nor v2. It's a Frankenstein mix.

Your migration function can't handle this:

```typescript
.migrate((row) => {
  // Is this v1 or v2? It has 'bio' (v2) but was partially
  // written by a v1 client. The _v field might say "1"
  // but the data has v2 fields. Or vice versa.
  // There's no coherent answer.
})
```

### Row-Level Solves This

With row-level LWW, the entire row comes from a single write:

```typescript
// Alice writes (v2 client):
{ name: "Alice", email: "a@b.com", bio: "Hello", _v: 2 }

// Bob writes (v1 client):
{ name: "Bobby", email: "b@b.com", _v: 1 }

// After sync, it's one or the other - not a mix
// Migration knows exactly what it's dealing with
```

Every row has a coherent schema version because every row is from a single atomic write.

## The Trade-off Matrix

| Aspect                 | Cell-Level CRDT         | Row-Level LWW    |
| ---------------------- | ----------------------- | ---------------- |
| Concurrent field edits | Merge perfectly         | Last writer wins |
| Schema versioning      | Broken (mixed versions) | Works cleanly    |
| Conflict resolution    | Per-field               | Per-row          |
| Storage efficiency     | More metadata           | Less metadata    |
| Migration complexity   | Very hard               | Straightforward  |

## When to Use Cell-Level CRDT

**Good fit for:**

- Real-time collaborative editing (Google Docs-style)
- Apps where multiple users edit the same record simultaneously
- Data with stable schemas that rarely change
- Records with independent fields (editing one shouldn't affect others)

**Examples:**

- Collaborative document editors
- Shared whiteboards
- Real-time multiplayer game state

## When to Use Row-Level LWW

**Good fit for:**

- Document-style data (one author at a time)
- Apps that need schema evolution
- Records that are conceptually atomic
- Apps where "last edit wins" is acceptable

**Examples:**

- Note-taking apps (one person writes a note)
- Task managers (tasks have an owner)
- CMS systems (articles have an author)
- Settings/preferences (user updates their own settings)

## The Honest Assessment

Row-level LWW is a constraint. You lose the CRDT magic of conflict-free field merging.

But schema evolution is also a constraint. Most apps need to evolve their data model, and "CRDT migration hell" is a real problem that has sunk local-first projects.

Epicenter chooses row-level LWW because:

1. **Most apps don't need concurrent field editing** - One person edits a document at a time
2. **Most apps do need schema evolution** - Requirements change, data models change
3. **Last-write-wins is often acceptable** - For non-collaborative data, it's fine
4. **Simpler mental model** - Easier to reason about than per-field merging

## Hybrid Approaches

You don't have to choose one approach for everything.

**Use row-level for structured metadata:**

```typescript
// Posts, notes, records with schemas. Multi-version tables get a migrate;
// `_v` is library-managed, so it never appears in column declarations or
// in the rows you write.
const posts = defineTable(
  { id: column.string(), title: column.string() },
  { id: column.string(), title: column.string(), authorId: column.string() },
).migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, authorId: 'unknown' };
    case 2: return value;
  }
});
```

**Use cell-level for collaborative content:**

```typescript
// Store rich text in a separate per-row Y.Doc (via createDisposableCache)
const content = ydoc.getText('content'); // Full CRDT merging
```

**Reference between them:**

```typescript
// Row holds the metadata; the editor opens a content Y.Doc keyed off the id.
const post = {
  id: 'post-1',
  title: 'My Post',     // Row-level LWW
  contentDocId: 'post-1', // Keys into a createDisposableCache of content docs
};
```

This gives you schema versioning for metadata and CRDT merging for content.

## Conclusion

There's no universally correct answer. Cell-level CRDTs and row-level LWW solve different problems.

Epicenter bets that for most apps, schema evolution matters more than concurrent field editing. If your app is highly collaborative with multiple users editing the same record simultaneously, Epicenter's approach might not be right for you.

But if you're building a local-first app where data has an "owner" and schemas need to evolve, row-level LWW with migrate-on-read is a powerful pattern that sidesteps the hardest problems in CRDT-land.

Know your requirements. Choose accordingly.
