<script lang="ts">
	import { tick } from 'svelte';

	import { requireOpensidian } from '$lib/session';

	const opensidian = requireOpensidian();
	let value = $state('');
	let inputEl: HTMLInputElement | undefined = $state();

	async function handleSubmit() {
		const cmd = value;
		value = '';
		await opensidian.state.terminal.exec(cmd);
		if (opensidian.state.terminal.open) {
			await tick();
			inputEl?.focus();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			const prev = opensidian.state.terminal.previousCommand();
			if (prev !== undefined) value = prev;
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			const next = opensidian.state.terminal.nextCommand();
			value = next ?? '';
		}
	}

	/**
	 * Focus the input element. Called by TerminalPanel when the
	 * terminal opens so the user can type immediately.
	 */
	export function focus() {
		inputEl?.focus();
	}
</script>

<div class="flex items-center border-t px-3 py-2">
	<span class="mr-2 text-green-500">$</span>
	<input
		bind:this={inputEl}
		bind:value
		onkeydown={handleKeydown}
		disabled={opensidian.state.terminal.running}
		placeholder={opensidian.state.terminal.running ? 'Running...': 'Type a command...'}
		aria-label="Terminal command input"
		class="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
		spellcheck="false"
		autocomplete="off"
	>
</div>
