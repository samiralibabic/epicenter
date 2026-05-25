<script lang="ts">
	import * as Avatar from '@epicenter/ui/avatar';
	import GlobeIcon from '@lucide/svelte/icons/globe';

	let { src }: { src: string | null | undefined } = $props();
</script>

<Avatar.Root class="size-6 shrink-0 rounded-sm">
	<Avatar.Image src={src ?? undefined} alt="" />
	<Avatar.Fallback class="rounded-sm">
		<GlobeIcon class="size-3 text-muted-foreground" />
	</Avatar.Fallback>
</Avatar.Root>
