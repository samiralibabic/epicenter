<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
	import type { ToolResultPart as TanStackToolResultPart } from '@tanstack/ai-client';

	let {
		part,
	}: {
		part: TanStackToolResultPart;
	} = $props();
</script>

<!--
	Tool results for completed calls are already shown inside ToolCallPart's
	collapsible Details section. Only render streaming/error states here.
-->
{#if part.state === 'streaming'}
	<div class="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
		<Spinner class="size-3" />
		Processing…
	</div>
{:else if part.state === 'error'}
	<div
		class="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
	>
		<AlertCircleIcon class="size-3 shrink-0" />
		<span>{part.error ?? 'Tool execution failed'}</span>
	</div>
{/if}
