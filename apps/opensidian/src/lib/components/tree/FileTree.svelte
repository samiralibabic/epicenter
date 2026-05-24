<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { requireOpensidian } from '$lib/session';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	const opensidian = requireOpensidian();
	/**
	 * Flat list of visible item IDs in visual order.
	 * Respects folder expansion state: collapsed folders hide their descendants.
	 */
	const visibleIds = $derived.by(() => {
		return opensidian.state.files.walkTree<FileId>((id, row) => ({
			collect: id,
			descend: row.type === 'folder' && opensidian.state.files.isExpanded(id),
		}));
	});

	/** Whether an inline create/rename is active (suppresses tree keyboard shortcuts). */
	const isEditing = $derived(
		opensidian.state.files.inlineCreate !== null ||
			opensidian.state.files.renamingId !== null,
	);

	function handleKeydown(e: KeyboardEvent) {
		// Don't intercept keys while inline editing is active
		if (isEditing) return;

		const current = opensidian.state.files.focusedId;
		const currentIndex = current ? visibleIds.indexOf(current) : -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				if (currentIndex === -1) {
					opensidian.state.files.focus(visibleIds[0] ?? null);
				} else {
					const next =
						visibleIds[Math.min(currentIndex + 1, visibleIds.length - 1)];
					opensidian.state.files.focus(next ?? null);
				}
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				if (currentIndex === -1) {
					opensidian.state.files.focus(visibleIds[0] ?? null);
				} else {
					const prev = visibleIds[Math.max(currentIndex - 1, 0)];
					opensidian.state.files.focus(prev ?? null);
				}
				break;
			}
			case 'ArrowRight': {
				e.preventDefault();
				if (!current) break;
				const row = opensidian.state.files.getFile(current);
				if (row?.type !== 'folder') break;
				if (!opensidian.state.files.isExpanded(current)) {
					opensidian.state.files.toggleExpand(current);
				} else {
					const children = opensidian.state.files.getChildren(current);
					if (children.length > 0)
						opensidian.state.files.focus(children[0] ?? null);
				}
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				if (!current) break;
				const row = opensidian.state.files.getFile(current);
				if (
					row?.type === 'folder' &&
					opensidian.state.files.isExpanded(current)
				) {
					opensidian.state.files.toggleExpand(current);
				} else if (row?.parentId) {
					opensidian.state.files.focus(row.parentId);
				}
				break;
			}
			case 'Enter':
			case ' ': {
				e.preventDefault();
				if (!current) break;
				const row = opensidian.state.files.getFile(current);
				if (row?.type === 'file') {
					opensidian.state.files.selectFile(current);
				} else if (row?.type === 'folder') {
					opensidian.state.files.toggleExpand(current);
				}
				break;
			}
			case 'Home': {
				e.preventDefault();
				opensidian.state.files.focus(visibleIds[0] ?? null);
				break;
			}
			case 'End': {
				e.preventDefault();
				opensidian.state.files.focus(visibleIds.at(-1) ?? null);
				break;
			}
			// ── Inline editing shortcuts ──────────────────────────────
			case 'n':
			case 'N': {
				e.preventDefault();
				opensidian.state.files.startCreate(e.shiftKey ? 'folder' : 'file');
				break;
			}
			case 'F2': {
				e.preventDefault();
				if (current) opensidian.state.files.startRename(current);
				break;
			}
			case 'Delete':
			case 'Backspace': {
				e.preventDefault();
				if (!current) break;
				const row = opensidian.state.files.getFile(current);
				const name = row?.name ?? 'this item';
				const isFolder = row?.type === 'folder';
				confirmationDialog.open({
					title: `Delete ${name}?`,
					description: isFolder
						? 'This will delete the folder and all its contents. This action cannot be undone.'
						: 'This will delete the file. This action cannot be undone.',
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => opensidian.state.files.deleteFile(current),
				});
				break;
			}
			default:
				return; // don't prevent default for unhandled keys
		}
	}
</script>

{#if opensidian.state.files.rootChildIds.length === 0 && !opensidian.state.files.inlineCreate}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No files yet</Empty.Title>
			<Empty.Description
				>Create files or load sample data to get started</Empty.Description
			>
		</Empty.Header>
		<Button
			variant="outline"
			size="sm"
			onclick={() => opensidian.state.sampleData.load()}
			disabled={opensidian.state.sampleData.seeding}
		>
			{#if opensidian.state.sampleData.seeding}
				<Spinner class="size-3.5" />
			{:else}
				Load Sample Data
			{/if}
		</Button>
	</Empty.Root>
{:else}
	<TreeView.Root
		tabindex={0}
		aria-label="File explorer"
		onkeydown={handleKeydown}
	>
		{#each opensidian.state.files.rootChildIds as childId (childId)}
			<FileTreeItem id={childId} />
		{/each}
		{#if opensidian.state.files.inlineCreate?.parentId === null}
			<InlineNameInput
				icon={opensidian.state.files.inlineCreate.type}
				onConfirm={opensidian.state.files.confirmCreate}
				onCancel={opensidian.state.files.cancelCreate}
			/>
		{/if}
	</TreeView.Root>
{/if}
