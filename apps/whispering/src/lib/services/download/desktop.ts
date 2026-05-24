import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { getAudioExtension } from '$lib/services/transcription/utils';
import type { DownloadService } from '.';
import { DownloadError } from './types';

export function createDownloadServiceDesktop() {
	return {
		downloadBlob: async ({ name, blob }) => {
			const extension = getAudioExtension(blob.type);
			const { data: path, error: saveError } = await tryAsync({
				try: () =>
					save({
						filters: [{ name, extensions: [extension] }],
					}),
				catch: (error) => DownloadError.SaveDialogFailed({ cause: error }),
			});
			if (saveError) return Err(saveError);
			if (path === null) {
				return DownloadError.SaveCancelled();
			}
			const { error: writeError } = await tryAsync({
				try: async () => {
					const contents = new Uint8Array(await blob.arrayBuffer());
					await writeFile(path, contents);
				},
				catch: (error) => DownloadError.WriteFailed({ cause: error }),
			});
			if (writeError) return Err(writeError);
			return Ok(undefined);
		},
	} satisfies DownloadService;
}
