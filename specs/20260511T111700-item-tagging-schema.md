# Item Tagging Schema

**Date**: 2026-05-11
**Status**: Draft
**Author**: AI-assisted

## Overview

This spec defines a minimal tag-first schema for organizing music and other collectable things. The core model stores objects as `items`, stores vocabulary as `tags`, stores assignments as `taggings`, and lets UI behavior bind to ordinary tags instead of inventing separate favorite, pin, rating, and folder systems.

## One Sentence

An item can have many tags, a tag can apply to many items, and special UI behavior is a binding to a tag rather than a separate data model.

## Motivation

### Current State

Simple workspace apps can store tags directly on a row:

```typescript
const entriesTable = defineTable(
	type({
		id: EntryId,
		title: 'string',
		tags: 'string[]',
		pinned: 'boolean',
		rating: 'number',
		_v: '2',
	}),
);
```

That is pleasant for a personal CMS because tags are light metadata and `pinned` is a single fixed behavior.

This creates problems for a tag-first music collection:

1. **Tag renames are expensive**: Renaming `late-night` to `night` requires rewriting every item row that stores the string.
2. **AI suggestions need provenance**: A plain `tags: string[]` field cannot distinguish user-applied tags from AI-suggested tags.
3. **Rejected suggestions matter**: If the AI keeps suggesting `dream-pop` for a track and the user rejects it, the model needs memory.
4. **Special fields multiply**: `favorite`, `pinned`, `inbox`, `currentRotation`, and `revisit` can become separate columns even though they are all tag-like.
5. **Sync conflicts get wider**: Two devices editing the same array can contend on the whole item row rather than on one tag assignment.

### Desired State

The stored model should normalize the write path:

```text
items    = things that can be tagged
tags     = reusable vocabulary
taggings = item has tag, with state and source
bindings = UI behavior points at ordinary tags
```

The app can denormalize in memory for reads:

```text
activeTagsByItemId
suggestedTagsByItemId
itemsByTagId
favoriteItems
pinnedItems
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Generic tagged object name | 2 coherence | Use `items` | Music starts with tracks, albums, and artists, but tags should also apply to playlists, notes, collections, and imported objects later. |
| Domain-facing names | 2 coherence | Keep domain nouns like `entries` and `tracks` | `items` is an infrastructure noun. Product code should still use the nouns users would say out loud. |
| Tag storage | 2 coherence | Use a `tags` table | Tags need stable identity so labels can change without rewriting item rows. |
| Tag assignment storage | 2 coherence | Use a `taggings` table | The relationship needs state, source, confidence, timestamps, and conflict-friendly identity. |
| AI provenance | 2 coherence | Store `source` on `taggings`, not only on `tags` | A tag can be created by AI but later used by the user. The assignment is where suggestion and acceptance happen. |
| Accepted AI suggestions | 2 coherence | Change `state` from `suggested` to `active` | Acceptance changes the assignment, not the tag. `source: 'ai'` remains useful provenance. |
| System source | 3 taste | Omit for now | `user | ai` is enough if special behavior is handled through bindings. Add `system` later only if the app needs protected built-in rows. |
| Favorite and pin | 2 coherence | Model as ordinary tags | This preserves composability. `favorite + late-night` is just a tag query. |
| Special UI behavior | 2 coherence | Use bindings that point to tag IDs | The UI can treat one tag as the favorite tag without making that tag a different kind of entity. |
| Denormalized tag arrays | Deferred | Derived state first | Store canonical data normalized. Add cached arrays only after profiling proves a need. |

## Naming Model

Use `items` only at the layer that needs to tag many kinds of objects. Keep concrete nouns at the app boundary.

```text
Infrastructure noun:
  item

Domain nouns:
  entry
  track
  album
  artist
  playlist
  note
```

The noun should answer what sentence the table serves:

```text
Fuji edits dated content entries.
Music organizes tracks, albums, artists, and playlists.
The tag layer attaches tags to any item.
```

This means Fuji should not rename `entries` to `items` just because a generic tagging layer exists. If Fuji needs universal tagging later, it can join the item layer:

```text
items
  id
  kind: "fuji.entry"
  title

entries
  id
  itemId
  subtitle
  date
  contentDocId

tags
  id
  slug
  label

taggings
  id
  itemId
  tagId
```

That gives the tag system one generic target while Fuji keeps its product language.

## Architecture

The canonical model has three required tables:

```text
+-------------------+
| items             |
|-------------------|
| id                |
| kind              |
| title             |
| createdAt         |
| updatedAt         |
| _v                |
+-------------------+
          ^
          |
          | itemId
          |
+-------------------+       tagId       +-------------------+
| taggings          |------------------>| tags              |
|-------------------|                   |-------------------|
| id                |                   | id                |
| itemId            |                   | slug              |
| tagId             |                   | label             |
| state             |                   | createdAt         |
| source            |                   | updatedAt         |
| confidence?       |                   | _v                |
| createdAt         |                   +-------------------+
| updatedAt         |
| _v                |
+-------------------+
```

Bindings sit beside the tables. They are not tag rows and they are not item rows. They map app behavior to tag IDs:

```text
+-----------------------------+
| tagBindings                 |
|-----------------------------|
| favoriteTagId -> tag_fav    |
| pinnedTagId   -> tag_pin    |
| inboxTagId    -> tag_inbox  |
+-----------------------------+
```

The heart button does not set `item.favorite = true`. It toggles the tag bound by `favoriteTagId`.

```text
Heart button
    |
    v
read favoriteTagId
    |
    v
toggle tagging(itemId, favoriteTagId)
```

That means the user can rename the favorite tag to `essential` without breaking the heart button:

```text
tag_fav.slug  = "essential"
tag_fav.label = "Essential"

favoriteTagId still points to tag_fav
```

## Minimal Schema Sketch

The exact file placement depends on the app, but the schema should follow workspace table conventions: branded IDs, `defineTable()`, and `InferTableRow`.

```typescript
import {
	defineKv,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

export type ItemId = Id & Brand<'ItemId'>;
export const ItemId = type('string').as<ItemId>();
export const generateItemId = (): ItemId => generateId() as ItemId;

export type TagId = Id & Brand<'TagId'>;
export const TagId = type('string').as<TagId>();
export const generateTagId = (): TagId => generateId() as TagId;

export type TaggingId = string & Brand<'TaggingId'>;
export const TaggingId = type('string').as<TaggingId>();
export const createTaggingId = ({
	itemId,
	tagId,
}: {
	itemId: ItemId;
	tagId: TagId;
}): TaggingId => `${itemId}:${tagId}` as TaggingId;

const itemsTable = defineTable(
	type({
		id: ItemId,
		kind: "'track' | 'album' | 'artist' | 'playlist' | 'note'",
		title: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);

const tagsTable = defineTable(
	type({
		id: TagId,
		slug: 'string',
		label: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);

const taggingsTable = defineTable(
	type({
		id: TaggingId,
		itemId: ItemId,
		tagId: TagId,
		state: "'active' | 'suggested' | 'rejected'",
		source: "'user' | 'ai'",
		'confidence?': 'number',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);

const tagBindings = {
	'bindings.favoriteTagId': defineKv(TagId.or('null'), null),
	'bindings.pinnedTagId': defineKv(TagId.or('null'), null),
	'bindings.inboxTagId': defineKv(TagId.or('null'), null),
};

export type Item = InferTableRow<typeof itemsTable>;
export type Tag = InferTableRow<typeof tagsTable>;
export type Tagging = InferTableRow<typeof taggingsTable>;
```

## Flows

### User Adds A Tag

```text
1. Find or create tag by slug.
2. Create deterministic tagging ID from itemId and tagId.
3. Set tagging state to active.
4. Set tagging source to user.
```

```typescript
tables.taggings.set({
	id: createTaggingId({ itemId, tagId }),
	itemId,
	tagId,
	state: 'active',
	source: 'user',
	createdAt: now,
	updatedAt: now,
	_v: 1,
});
```

### AI Suggests A Tag

```text
1. Find or create tag by slug.
2. Create deterministic tagging ID from itemId and tagId.
3. Set tagging state to suggested.
4. Set tagging source to ai.
5. Store confidence if available.
```

```typescript
tables.taggings.set({
	id: createTaggingId({ itemId, tagId }),
	itemId,
	tagId,
	state: 'suggested',
	source: 'ai',
	confidence: 0.82,
	createdAt: now,
	updatedAt: now,
	_v: 1,
});
```

### User Accepts An AI Suggestion

```text
Before:
state  = suggested
source = ai

After:
state  = active
source = ai
```

Acceptance changes the assignment state. It does not rewrite the tag and it does not pretend the original source was user-created.

### User Rejects An AI Suggestion

```text
Before:
state  = suggested
source = ai

After:
state  = rejected
source = ai
```

Keeping rejected rows lets the AI avoid repeating bad suggestions. If storage becomes a concern, rejected taggings can be pruned later.

### User Toggles Favorite

```text
1. Read bindings.favoriteTagId.
2. If missing, create or choose the favorite tag and store the binding.
3. Toggle an active tagging for itemId plus favoriteTagId.
```

There is no `favorite` column on `items`.

## Why Bindings Exist

Bindings are for UI affordances that need a stable behavior but should still compose like tags.

Without bindings:

```text
favorite is hardcoded as a column or hardcoded tag slug.
```

With bindings:

```text
favorite behavior points at tag_fav.
tag_fav can be renamed, merged, displayed, hidden, queried, or replaced.
```

Bindings are useful for:

1. Heart button: `favoriteTagId`
2. Pin button: `pinnedTagId`
3. Inbox behavior: `inboxTagId`
4. Default current view: `defaultViewId` later

Bindings are not needed for ordinary tags. A tag like `late-night` should just be a tag.

## Optional Later Tables

### Tag Views

Add this when users want saved queries:

```text
tagViews
  id
  name
  includeTagIds
  excludeTagIds
  pinned
  createdAt
  updatedAt
  _v
```

Example:

```text
"Night Drive" = driving + late-night + favorite
"Work Mode"   = focus + instrumental
"Dig Later"   = revisit + weird
```

### Item Metadata Tables

Keep `items` generic. Add domain-specific tables only when the metadata matters:

```text
tracks
  id
  itemId
  artistName
  albumTitle
  durationMs
  sourceUri
  _v

albums
  id
  itemId
  artistName
  releaseYear?
  _v
```

This keeps the tag system generic while letting music metadata evolve separately.

## Edge Cases

### Duplicate Taggings

Use deterministic IDs:

```text
taggingId = itemId + ":" + tagId
```

Two devices adding the same tag to the same item should converge on the same row.

### Tag Rename

Update the tag row:

```text
tag.slug  = "night"
tag.label = "Night"
```

No item rows or tagging rows need to change.

### Tag Merge

Move taggings from the old tag ID to the target tag ID, then delete or archive the old tag. This is one of the few operations that touches multiple rows, so it should be an action rather than ad hoc UI writes.

### AI Suggests Existing User Tag

The AI should reuse the existing tag row and create a `suggested` tagging. The tag itself does not become AI-owned.

### User Adds Previously Rejected Tag

If a rejected tagging exists and the user adds the tag manually, update that row:

```text
state  = active
source = user
```

This means the latest intentional act wins.

## Implementation Plan

### Phase 1: Core Schema

- [ ] **1.1** Define branded IDs for `ItemId`, `TagId`, and `TaggingId`.
- [ ] **1.2** Add `items`, `tags`, and `taggings` table definitions.
- [ ] **1.3** Add deterministic `createTaggingId({ itemId, tagId })`.
- [ ] **1.4** Add scalar KV bindings for favorite, pinned, and inbox tag IDs.
- [ ] **1.5** Export row types with `InferTableRow`.

### Phase 2: Actions

- [ ] **2.1** Add `findOrCreateTagBySlug`.
- [ ] **2.2** Add `addUserTag`.
- [ ] **2.3** Add `suggestAiTag`.
- [ ] **2.4** Add `acceptSuggestedTag`.
- [ ] **2.5** Add `rejectSuggestedTag`.
- [ ] **2.6** Add `toggleBoundTag` for favorite and pinned behavior.

### Phase 3: Derived State

- [ ] **3.1** Build `tagsById`.
- [ ] **3.2** Build `activeTaggingsByItemId`.
- [ ] **3.3** Build `suggestedTaggingsByItemId`.
- [ ] **3.4** Build `itemsByTagId`.
- [ ] **3.5** Build derived lists for favorites, pinned items, and inbox.

### Phase 4: Optional Views

- [ ] **4.1** Add `tagViews` when saved tag queries are needed.
- [ ] **4.2** Support include and exclude tag IDs.
- [ ] **4.3** Add pinned views if the UI needs a sidebar or home screen.

## Open Questions

1. Should `items.kind` stay a literal union, or should item kinds become tags too?
2. Should accepted AI suggestions keep `source: 'ai'`, or should there be an `acceptedAt` timestamp later?
3. Should rejected AI taggings be kept forever, pruned after time, or hidden behind an archival state?
4. Should bindings live in KV, or should they become a table if users can create arbitrary named bindings?

## Recommendation

Start with `items`, `tags`, `taggings`, and three scalar bindings. Do not add ratings, system tags, tag views, or denormalized tag arrays yet. The model is already composable enough: favorites and pins are tags, AI suggestions are taggings, and the UI gets stable behavior through bindings.
