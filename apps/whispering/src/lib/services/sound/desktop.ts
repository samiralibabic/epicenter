import { tryAsync } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { audioElements } from './assets';
import { SoundError } from './types';

export function createPlaySoundServiceDesktop() {
	return {
		playSound: async (soundName) =>
			tryAsync({
				try: async () => {
					await audioElements[soundName].play();
				},
				catch: (error) => SoundError.Play({ cause: error }),
			}),
	} satisfies PlaySoundService;
}
