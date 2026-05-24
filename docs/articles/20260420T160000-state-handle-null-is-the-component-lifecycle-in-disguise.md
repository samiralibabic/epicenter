# `$state<Handle | null>` Is the Component Lifecycle in Disguise

When a Svelte component opens a disposable handle from a prop, that prop is often the component's identity. Key the parent on that identity, open the handle synchronously in the child, and let unmount dispose it. You usually do not need nullable state to describe a lifecycle the tree already owns.

I was reviewing five Svelte components that all opened a Yjs doc handle. Four of them looked like this:

```svelte
<script lang="ts">
	let { fileId }: { fileId: string } = $props();

	let handle = $state<ReturnType<typeof fileContentDocs.open> | null>(null);

	$effect(() => {
		const h = fileContentDocs.open(fileId);
		handle = h;
		return () => { h[Symbol.dispose](); handle = null; };
	});
</script>

{#if handle}
	<Editor ytext={handle.content.binding} />
{/if}
```

One of them, `EntryEditor.svelte`, looked like this:

```svelte
<script lang="ts">
	let { entry }: { entry: Entry } = $props();
	const id = entry.id;

	const contentDoc = entryContentDocs.open(id);
	$effect(() => () => contentDoc[Symbol.dispose]());
</script>

<Editor yxmlfragment={contentDoc.content.binding} />
```

Same job. Half the code. No nullable state. No `{#if handle}` guard. The only behavioral difference was a comment on top: `// Parent uses {#key entryId} to remount on navigation, so entry.id never changes within an instance.`

That comment is the whole trick.

## The effect is reimplementing mount and unmount

Look at what the first version is doing. When `fileId` changes, it runs the cleanup (dispose old handle, null out state), then re-runs the body (open new handle, assign). When the component unmounts, it runs the cleanup once.

That's mount and unmount. Written by hand. In user-space. Every time.

Svelte already does this. A component instance mounts when it appears in the tree and unmounts when it disappears. The two mechanisms that make it appear or disappear are `{#if}` and `{#key}`. The parent says "mount a fresh instance for this id" with one of those, and the child does its open-and-dispose once, synchronously, tied to its own lifetime.

The version with nullable state isn't giving you more control. It's giving you a second, parallel lifecycle to keep in sync with the real one. Two lifecycles means two places to get it wrong.

## The fix is to move the boundary up one component

For the four noisy callsites, the parent already had `{#key}` in place. All we did was lift the open into a child keyed by that boundary.

Before (`honeycrisp/+page.svelte`):

```svelte
<script>
	let bodyHandle = $state<ReturnType<typeof noteBodyDocs.open> | null>(null);

	$effect(() => {
		const id = viewState.selectedNoteId;
		if (!id) { bodyHandle = null; return; }
		const handle = noteBodyDocs.open(id);
		bodyHandle = handle;
		return () => { handle[Symbol.dispose](); bodyHandle = null; };
	});
</script>

{#if viewState.selectedNote && bodyHandle}
	{#key viewState.selectedNoteId}
		<HoneycripEditor yxmlfragment={bodyHandle.body.binding} ... />
	{/key}
{/if}
```

After:

```svelte
{#if viewState.selectedNote}
	{#key viewState.selectedNoteId}
		<NoteBodyPane noteId={viewState.selectedNoteId!} />
	{/key}
{/if}
```

And `NoteBodyPane.svelte`:

```svelte
<script lang="ts">
	let { noteId }: { noteId: string } = $props();
	const handle = noteBodyDocs.open(noteId);
	$effect(() => () => handle[Symbol.dispose]());
</script>

<HoneycripEditor yxmlfragment={handle.body.binding} ... />
```

The `{#key}` was already there. It was already causing the editor to remount on id change. The effect machinery on top of it was doing nothing the component tree wasn't already doing.

Net across four callsites: 54 insertions, 75 deletions. No behavior change.

## "But the docs say to use `$effect` for this"

They do. I asked DeepWiki what the idiomatic Svelte 5 pattern was for opening a resource whose identity depends on a prop. It came back with the nullable-state-plus-effect pattern as the default, with `{#key}` mentioned as "a more heavy-handed alternative."

The code DeepWiki produced:

```svelte
$effect(() => {
	if (externalResource) {
		externalResource[Symbol.dispose]();
	}
	externalResource = openExternalResource(resourceId);
	return () => {
		if (externalResource) {
			externalResource[Symbol.dispose]();
		}
	};
});
```

That disposes twice on every prop change. The effect body disposes the previous resource, assigns a new one, and the returned cleanup, which captured `externalResource` by closure, fires next and disposes the one that was just assigned. Then the body runs again and opens a third one. Classic.

This isn't a slight against the docs. It's the point. The pattern is hard to write correctly. The equivalent Pattern A version cannot write this bug, because the effect has one line:

```svelte
$effect(() => () => handle[Symbol.dispose]());
```

There is no body to desynchronize from the cleanup, because the body is the cleanup.

## The cost argument, honestly examined

The reason people reach for the effect pattern is remount cost. `{#key}` destroys the component, which means destroying the DOM, which means the editor loses its scroll position, selection, focus, IME state, internal undo history.

For Yjs-backed editors this doesn't matter. The content state lives in the CRDT, not in the editor instance. Reconnecting to the same doc restores content instantly. Scroll and focus aren't worth preserving across a document switch anyway, because the user is navigating to a different thing.

The cost is real when you have in-component UI state that should survive an id swap. A spreadsheet view that remembers the selected cell when you switch sheets. A timeline scrubber that keeps its zoom level across documents. If that state isn't in the doc and isn't persisted, `{#key}` will wipe it.

None of our four callsites had that. If one of ours ever does, the nullable-state-plus-effect pattern comes back out of the drawer. Until then it's extra moving parts.

## When we'd actually want the nullable-state pattern

Three conditions, all at once:

One, the id genuinely changes in place within the same component instance (not a prop the parent could key on).

Two, there's meaningful local UI state that would regress if the component remounted.

Three, no small wrapper component could absorb the id boundary without losing that context.

Two of the five callsites, `ReferencesPanel` with its expand-collapse toggle and the honeycrisp page itself, looked like condition one. Both collapsed to Pattern A anyway, because a wrapper component was cheaper than the nullable state.

## The smell, stated plainly

If you see `$state<Handle | null>(null)` followed by a `$effect` that opens the handle, assigns it, and disposes it in cleanup, you're reimplementing a component lifecycle that the parent could own with one `{#key}` or `{#if}`. Push the boundary up. Let the tree do the work.

Related: [Svelte Context Is Not Reactive, But `{#key}` Rebuilds the Tree](./context-is-not-reactive-but-the-tree-is.md), [Svelte skill: External Resource Handles section](../.agents/skills/svelte/SKILL.md), and the commits that landed this across the codebase (`d183f8a8`, `f689ae86`).
