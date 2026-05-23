<script lang="ts">
	import { requireFuji } from '$lib/session';
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { viewState } from './state/view.svelte';

	const fuji = requireFuji();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={fuji.entries.active} />
{:else}
	<EntriesTimeline entries={fuji.entries.active} />
{/if}
