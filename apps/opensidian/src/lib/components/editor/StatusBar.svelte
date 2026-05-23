<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Popover from '@epicenter/ui/popover';
	import { Switch } from '@epicenter/ui/switch';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { requireOpensidian } from '$lib/session';

	const opensidian = requireOpensidian();
	let { chatOpen = $bindable(false) }: { chatOpen: boolean } = $props();

	let popoverOpen = $state(false);
</script>

<div
	class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
>
	<span
		>Ln {opensidian.state.editor.cursorLine}, Col
		{opensidian.state.editor.cursorCol}</span
	>

	{#if opensidian.state.editor.selectionLength > 0}
		<span>{opensidian.state.editor.selectionLength} selected</span>
	{/if}

	<span>{opensidian.state.editor.wordCount} words</span>
	<span>{opensidian.state.editor.lineCount} lines</span>

	<div class="ml-auto flex items-center gap-1.5">
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={opensidian.state.terminal.open ? 'secondary': 'ghost'}
							size="sm"
							class="h-5 gap-1 px-1.5 text-xs text-muted-foreground"
							onclick={() => opensidian.state.terminal.toggle()}
						>
							<TerminalIcon class="size-3" />
							Terminal
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Toggle terminal (⌘`)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={chatOpen ? 'secondary': 'ghost'}
							size="sm"
							class="h-5 gap-1 px-1.5 text-xs text-muted-foreground"
							onclick={() => (chatOpen = !chatOpen)}
						>
							<MessageSquareIcon class="size-3" />
							AI Chat
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Toggle AI chat (⌘⇧L)</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		{#if opensidian.state.editor.vimEnabled}
			<span class="font-mono text-[10px] font-medium uppercase tracking-wider"
				>vim</span
			>
		{/if}

		<Popover.Root bind:open={popoverOpen}>
			<Popover.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
			>
				<SettingsIcon class="size-3.5" />
			</Popover.Trigger>
			<Popover.Content class="w-64 space-y-3" align="end" side="top">
				<div class="flex items-center justify-between">
					<Label for="vim-mode" class="text-sm">Vim mode</Label>
					<Switch
						id="vim-mode"
						checked={opensidian.state.editor.vimEnabled}
						onCheckedChange={() => opensidian.state.editor.toggleVim()}
					/>
				</div>
				{#if opensidian.state.editor.vimEnabled}
					<p class="text-xs text-muted-foreground">
						Browser extensions like Vimium can intercept Escape and break vim
						keybindings: disable them for this site if keys aren't working.
					</p>
				{/if}
				<div class="flex items-center justify-between">
					<span class="text-sm">Theme</span>
					<LightSwitch variant="ghost" />
				</div>
				<div class="border-t pt-3">
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start"
						href="/about"
					>
						About Opensidian
					</Button>
				</div>
			</Popover.Content>
		</Popover.Root>
	</div>
</div>
