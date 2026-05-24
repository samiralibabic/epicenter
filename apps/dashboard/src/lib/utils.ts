/**
 * Capitalize the first letter of a string.
 *
 * Used for deriving display names from plan IDs (e.g. "ultra" → "Ultra").
 *
 * @example
 * ```typescript
 * capitalize('ultra'); // "Ultra"
 * capitalize('free');  // "Free"
 * capitalize('');      // ""
 * ```
 */
export function capitalize(str: string): string {
	if (str.length === 0) return '';
	return str.charAt(0).toUpperCase() + str.slice(1);
}
