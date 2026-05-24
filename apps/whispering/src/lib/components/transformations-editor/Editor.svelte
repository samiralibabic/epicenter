<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import type { Transformation, TransformationStep } from '$lib/workspace';
	import Configuration from './Configuration.svelte';
	import Runs from './Runs.svelte';
	import Test from './Test.svelte';

	let {
		transformation = $bindable(),
		steps = $bindable(),
	}: {
		transformation: Transformation;
		steps: TransformationStep[];
	} = $props();

	const runs = $derived(
		transformationRuns.getByTransformationId(transformation.id),
	);
</script>

<Resizable.PaneGroup direction="horizontal">
	<Resizable.Pane>
		<Configuration bind:transformation bind:steps />
	</Resizable.Pane>
	<Resizable.Handle withHandle />
	<Resizable.Pane>
		<Resizable.PaneGroup direction="vertical">
			<Resizable.Pane> <Test {transformation} {steps} /> </Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane> <Runs {runs} /> </Resizable.Pane>
		</Resizable.PaneGroup>
	</Resizable.Pane>
</Resizable.PaneGroup>
