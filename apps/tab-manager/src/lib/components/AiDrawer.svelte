<script lang="ts">
	import * as Drawer from '@epicenter/ui/drawer';
	import AiChat from '$lib/components/chat/AiChat.svelte';
	import TrustSettings from '$lib/components/chat/TrustSettings.svelte';

	let { open: drawerOpen = $bindable(false) }: { open: boolean } = $props();
</script>

<Drawer.Root
	bind:open={drawerOpen}
	direction="bottom"
	shouldScaleBackground={false}
>
	<Drawer.Content class="max-h-[80vh]">
		<Drawer.Header class="text-left">
			<div class="flex items-center justify-between">
				<Drawer.Title>AI Chat</Drawer.Title>
				<TrustSettings />
			</div>
			<Drawer.Description class="sr-only">
				Chat with AI about your tabs
			</Drawer.Description>
		</Drawer.Header>
		<div class="h-[clamp(300px,50vh,600px)] px-4 pb-4"><AiChat /></div>
	</Drawer.Content>
</Drawer.Root>
