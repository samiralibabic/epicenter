<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="item-content"
	class={cn(
		'flex flex-1 flex-col gap-1 [&+[data-slot=item-content]]:flex-none',
		// Custom override: enables text truncation inside flex containers
		'min-w-0',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
