/**
 * Shared date/time formatting utilities for Fuji.
 *
 * Centralizes `DateTimeString` → display string conversions so
 * components don't duplicate formatting logic.
 */

import { DateTimeString } from '@epicenter/workspace';
import { formatDistanceToNowStrict } from 'date-fns';

/**
 * Format a `DateTimeString` as a human-readable relative time, e.g.
 * "3 minutes ago", "2 days ago".
 */
export function relativeTime(dts: string): string {
	return formatDistanceToNowStrict(DateTimeString.toDate(dts), {
		addSuffix: true,
	});
}
