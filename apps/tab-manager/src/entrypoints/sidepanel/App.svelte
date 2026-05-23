<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { tabManagerSession } from '$lib/session.svelte';
	import SignedInApp from './SignedInApp.svelte';

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);

	async function startSignIn() {
		signInError = null;
		signingIn = true;
		try {
			const { error } = await tabManagerSession.auth.startSignIn();
			if (error) signInError = error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

{#await tabManagerSession.whenReady}
	<Loading class="h-full" label="Loading tabs…" />
{:then _}
	{#if tabManagerSession.current}
		{#await tabManagerSession.current.idb.whenLoaded}
			<Loading class="h-full" label="Loading tabs…" />
		{:then _}
			<SignedInApp />
		{:catch _error}
			<Empty.Root class="h-full border-0">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description> Try reopening the side panel. </Empty.Description>
			</Empty.Root>
		{/await}
	{:else}
		<main
			class="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
		>
			<div class="space-y-1">
				<p class="text-sm font-medium">Sign in to Epicenter</p>
				<p class="text-xs text-muted-foreground">
					Sync your tabs across devices.
				</p>
			</div>
			{#if signInError}
				<p class="text-xs text-destructive">{signInError}</p>
			{/if}
			<Button
				class="w-full max-w-xs"
				onclick={startSignIn}
				disabled={signingIn}
			>
				{#if signingIn}
					<LoaderCircle class="size-4 animate-spin" />
					Signing in…
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
		</main>
	{/if}
{:catch _error}
	<Empty.Root class="h-full border-0">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load account</Empty.Title>
		<Empty.Description> Try reopening the side panel. </Empty.Description>
	</Empty.Root>
{/await}

<ModeWatcher />
<Toaster position="bottom-center" richColors closeButton />
