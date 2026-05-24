import * as os from '@tauri-apps/plugin-os';
import type { OsService } from '.';

export function createOsServiceDesktop() {
	return {
		type: () => {
			return os.type();
		},
	} satisfies OsService;
}
