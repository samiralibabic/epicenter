<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { skills } from '$lib/skills/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const doc = fromDisposableCache(skills.instructionsDocs, () => skillId);
</script>

<CodeMirrorEditor ytext={doc.current.instructions.binding} />
