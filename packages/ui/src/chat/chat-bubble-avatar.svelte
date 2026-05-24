<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import { Root } from '../avatar/index.js';
	import { cn } from '../utils.js';

	let {
		class: className,
		ref = $bindable(null),
		...restProps
	}: AvatarPrimitive.RootProps = $props();
</script>

<Root
	bind:ref
	class={cn(
		"order-1 group-data-[variant='sent']/chat-bubble:order-2",
		className,
	)}
	{...restProps}
/>
