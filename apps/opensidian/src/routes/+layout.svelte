<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />

{@render children()}
