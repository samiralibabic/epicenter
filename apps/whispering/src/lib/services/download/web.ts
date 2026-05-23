import { tryAsync } from 'wellcrafted/result';
import type { DownloadService } from '.';
import { DownloadError } from './types';

export function createDownloadServiceWeb() {
	return {
		downloadBlob: ({ name, blob }) =>
			tryAsync({
				try: async () => {
					const file = new File([blob], name, { type: blob.type });
					const url = URL.createObjectURL(file);
					const anchor = document.createElement('a');
					anchor.href = url;
					anchor.download = name;
					document.body.appendChild(anchor);
					anchor.click();
					document.body.removeChild(anchor);
					URL.revokeObjectURL(url);
				},
				catch: (error) => DownloadError.BrowserDownloadFailed({ cause: error }),
			}),
	} satisfies DownloadService;
}
