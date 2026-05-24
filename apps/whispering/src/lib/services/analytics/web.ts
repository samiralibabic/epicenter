import { init, trackEvent } from '@aptabase/web';
import { tryAsync } from 'wellcrafted/result';
import type { AnalyticsService } from './types';
import { AnalyticsError } from './types';

init('A-US-5744332458');

export function createAnalyticsServiceWeb() {
	return {
		logEvent: async (event) =>
			tryAsync({
				try: async () => {
					const { type, ...properties } = event;
					await trackEvent(type, properties);
				},
				catch: (error) => AnalyticsError.LogEventFailed({ cause: error }),
			}),
	} satisfies AnalyticsService;
}
