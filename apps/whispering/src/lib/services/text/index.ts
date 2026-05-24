import { createTextServiceDesktop } from './desktop';
import type { TextService } from './types';
import { createTextServiceWeb } from './web';

export type { TextError, TextService } from './types';

export const TextServiceLive: TextService = window.__TAURI_INTERNALS__
	? createTextServiceDesktop()
	: createTextServiceWeb();
