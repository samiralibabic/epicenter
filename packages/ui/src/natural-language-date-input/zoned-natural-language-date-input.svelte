<script lang="ts" module>
	import { type DateTimeString, IanaTimeZone } from '@epicenter/workspace';

	export type ZonedDateTimeChoice = {
		label: string;
		date: DateTimeString;
		dateZone: IanaTimeZone;
	};

	export type ZonedNaturalLanguageDateInputProps = {
		/**
		 * Seed zone. The component owns the draft internally; later changes to
		 * this prop do not update the displayed zone.
		 */
		initialDateZone?: IanaTimeZone;
		min?: Date;
		max?: Date;
		placeholder?: string;
		onChoice: (choice: ZonedDateTimeChoice) => void;
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { TimezoneCombobox } from '../timezone-combobox/index.js';
	import NaturalLanguageDateInput from './natural-language-date-input.svelte';

	let {
		initialDateZone,
		min,
		max,
		placeholder,
		onChoice,
	}: ZonedNaturalLanguageDateInputProps = $props();

	let dateZone = $state<IanaTimeZone>(
		untrack(() => initialDateZone) ?? IanaTimeZone.current(),
	);
</script>

<div class="space-y-2">
	<NaturalLanguageDateInput
		timeZone={dateZone}
		{min}
		{max}
		{placeholder}
		onChoice={({ label, date }) => {
			onChoice({
				label,
				date: date.toISOString() as DateTimeString,
				dateZone,
			});
		}}
	/>
	<TimezoneCombobox bind:value={dateZone} />
</div>
