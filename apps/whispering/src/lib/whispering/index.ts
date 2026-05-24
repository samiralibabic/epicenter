import { attachKv, attachTables } from '@epicenter/workspace';
import * as Y from 'yjs';
import { whisperingKv, whisperingTables } from '$lib/workspace';

export function openWhispering() {
	const ydoc = new Y.Doc({ guid: 'whispering', gc: true });
	const tables = attachTables(ydoc, whisperingTables);
	const kv = attachKv(ydoc, whisperingKv);
	return {
		ydoc,
		tables,
		kv,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
