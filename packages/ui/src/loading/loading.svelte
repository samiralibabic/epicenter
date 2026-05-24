<!--
	Centered loading panel: spinner + optional caption. Layout-agnostic so
	the same primitive serves boot screens, flex panes, and block panes.
	Pairs with `Empty.Root`: one is the loading state, the other is the
	empty state of the same surface.

	@example
	```svelte
	<Loading class="h-dvh" />                    full viewport (boot)
	<Loading class="flex-1" />                   fills a flex parent
	<Loading class="h-full" />                   fills a block parent
	<Loading class="h-dvh" label="Loading…" />   with caption
	```
-->
<script lang="ts">
	import * as Empty from '../empty/index.js';
	import { Spinner } from '../spinner/index.js';
	import { cn } from '../utils.js';

	let {
		label,
		class: className,
	}: {
		/** Optional caption rendered below the spinner. */
		label?: string;
		/** Sizing + any extra classes merged onto the wrapper. */
		class?: string;
	} = $props();
</script>

<Empty.Root class={cn('border-0', className)} aria-live="polite">
	<Empty.Header>
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
		{#if label}
			<Empty.Description>{label}</Empty.Description>
		{/if}
	</Empty.Header>
</Empty.Root>
