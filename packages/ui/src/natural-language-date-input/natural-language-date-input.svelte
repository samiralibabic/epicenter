<script lang="ts" module>
	import { IanaTimeZone } from '@epicenter/workspace';

	export type NaturalLanguageDateInputProps = {
		/**
		 * IANA zone used to interpret bare wall-clock phrases like "5pm" or
		 * "tomorrow at 9". Defaults to the runtime's resolved zone. The
		 * component does not render any timezone UI.
		 */
		timeZone?: IanaTimeZone;
		min?: Date;
		max?: Date;
		placeholder?: string;
		onChoice?: (opts: { label: string; date: Date }) => void;
	};
</script>

<script lang="ts">
	import * as Command from '../command/index.js';
	import { parseInZone } from './parse.js';

	let {
		placeholder = 'E.g. "tomorrow at 5pm" or "in 2 hours"',
		timeZone = IanaTimeZone.current(),
		min,
		max,
		onChoice,
	}: NaturalLanguageDateInputProps = $props();

	let value = $state('');

	const suggestions = $derived(
		parseInZone({
			text: value,
			referenceNow: new Date(),
			timeZone,
			min,
			max,
		}),
	);

	const formatter = $derived(
		new Intl.DateTimeFormat(undefined, {
			timeZone,
			dateStyle: 'medium',
			timeStyle: 'short',
		}),
	);
</script>

<Command.Root shouldFilter={false} class="border-border h-fit border">
	<Command.Input {placeholder} bind:value />
	<Command.List>
		<Command.Group>
			{#each suggestions as suggestion (suggestion)}
				<Command.Item
					onSelect={() => {
						onChoice?.(suggestion);
					}}
				>
					<div class="flex w-full place-items-center justify-between gap-2">
						<span> {suggestion.label} </span>
						<span class="text-muted-foreground">
							{formatter.format(suggestion.date)}
						</span>
					</div>
				</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Root>
