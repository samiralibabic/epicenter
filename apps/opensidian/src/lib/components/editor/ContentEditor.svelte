<script lang="ts">
	import { autocompletion } from '@codemirror/autocomplete';
	import type { FileId } from '@epicenter/filesystem';
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import { requireOpensidian } from '$lib/session';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';
	import { linkDecorations } from './extensions/link-decorations';
	import { wikilinkAutocomplete } from './extensions/wikilink-autocomplete';

	const opensidian = requireOpensidian();

	let {
		fileId,
	}: {
		fileId: FileId;
	} = $props();
	const filename = $derived(
		opensidian.state.files.getFile(fileId)?.name ?? 'untitled.md',
	);
	const isMarkdown = $derived(
		filename.endsWith('.md') || !filename.includes('.'),
	);

	const doc = fromDisposableCache(opensidian.fileContentDocs, () => fileId);

	const sharedLinkDecorations = linkDecorations({
		onNavigate: (ref) => opensidian.state.files.selectFile(ref.id as FileId),
		resolveTitle: (ref) =>
			opensidian.state.files.getFile(ref.id as FileId)?.name ?? null,
	});

	const extensions = $derived(
		isMarkdown
			? [
					sharedLinkDecorations,
					wikilinkAutocomplete({
						workspaceId: opensidian.ydoc.guid,
						tableName: 'files',
						getFiles: () =>
							opensidian.tables.files
								.getAllValid()
								.filter((r) => r.type === 'file')
								.map((r) => ({ id: r.id, name: r.name })),
					}),
				]
			: [sharedLinkDecorations, autocompletion()],
	);
</script>

<!--
	Gate on idb hydration: `asText()` on Timeline mutates when the doc is empty
	(it pushes an entry). Calling it before idb hydrates races the replay
	and can corrupt the timeline (phantom text entry alongside the real
	stored entries).
-->
{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then}
	<CodeMirrorEditor
		ytext={doc.current.content.asText()}
		{extensions}
		{filename}
	/>
{/await}
