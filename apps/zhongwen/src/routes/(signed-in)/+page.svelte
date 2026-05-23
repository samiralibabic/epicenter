<script lang="ts">
	import { fromKv } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { requireZhongwen } from '$lib/session';
	import { auth } from '$platform/auth';
	import { createChatState } from './chat/chat-state.svelte';
	import ChatInput from './components/ChatInput.svelte';
	import ChatMessage from './components/ChatMessage.svelte';
	import ModelPicker from './components/ModelPicker.svelte';
	import ZhongwenSidebar from './components/ZhongwenSidebar.svelte';

	const zhongwen = requireZhongwen();
	const showPinyin = fromKv(zhongwen.kv, 'showPinyin');
	const chatState = createChatState();
	let dismissedError = $state(false);

	onDestroy(() => {
		chatState[Symbol.dispose]();
	});

	function openForgetDeviceDialog() {
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local Zhongwen data on this device. Account data on the server stays in your account.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				try {
					await zhongwen.wipe();
					await auth.signOut();
				} catch (error) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(error),
					});
				}
			},
		});
	}
</script>

<Sidebar.Provider>
	<ZhongwenSidebar {chatState} />

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
				{#if chatState.active}
					<ModelPicker handle={chatState.active} />
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showPinyin.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (showPinyin.current = !showPinyin.current)}
					aria-pressed={showPinyin.current}
					aria-label="Toggle pinyin annotations"
				>
					{showPinyin.current ? 'Hide Pinyin' : 'Show Pinyin'}
				</Button>

				<Button variant="ghost" size="sm" onclick={openForgetDeviceDialog}>
					Forget device
				</Button>
			</div>
		</header>

		{#if chatState.active}
			<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
				{#if chatState.active.messages.length === 0}
					<div
						class="flex flex-1 items-center justify-center text-muted-foreground"
					>
						<p>
							Ask a question in English and get a response in Chinese and
							English.
						</p>
					</div>
				{:else}
					{#each chatState.active.messages as message, i (message.id)}
						<ChatMessage
							{message}
							showPinyin={showPinyin.current}
							isStreaming={chatState.active.isLoading}
							isLast={i === chatState.active.messages.length - 1}
							onRegenerate={() => chatState.active?.reload()}
						/>
					{/each}
				{/if}

				{#if chatState.active.isLoading}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage typing />
					</Chat.Bubble>
				{/if}

				{#if chatState.active.error && !dismissedError}
					<div
						class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
					>
						<span class="flex-1">{chatState.active.error.message}</span>
						<Button
							size="sm"
							variant="outline"
							onclick={() => chatState.active?.reload()}
							>Retry</Button
						>
						<Button
							size="sm"
							variant="ghost"
							onclick={() => (dismissedError = true)}
							>✕</Button
						>
					</div>
				{/if}
			</Chat.List>

			<ChatInput handle={chatState.active} />
		{/if}
	</main>
</Sidebar.Provider>
