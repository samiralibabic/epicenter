<script lang="ts">
	import type { HTMLTdAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		variant = 'default',
		...restProps
	}: WithElementRef<HTMLTdAttributes> & {
		variant?: 'default' | 'muted' | 'numeric';
	} = $props();
</script>

<td
	bind:this={ref}
	data-slot="table-cell"
	class={cn(
		'whitespace-nowrap bg-clip-padding p-2 align-middle [&:has([role=checkbox])]:pe-0',
		variant === 'muted' && 'text-muted-foreground',
		variant === 'numeric' && 'text-right font-mono',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</td>
