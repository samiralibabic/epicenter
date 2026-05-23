// Route names are config-supplied identifiers. They become the prefix of
// `/list` manifest keys and `/run` action paths (`${route}.${action}`), so
// they must exclude `.` (the route boundary) and start with an alphanumeric.
// The leading-character class also rejects `__proto__` and other
// underscore-led names, so the pattern is the whole route-name rule.
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type DaemonRouteNameIssue = {
	route: string;
	reason: 'invalid' | 'duplicate';
};

export function validateDaemonRouteNames(
	routes: readonly string[],
): DaemonRouteNameIssue | null {
	const seen = new Set<string>();
	for (const route of routes) {
		if (seen.has(route)) return { route, reason: 'duplicate' };
		seen.add(route);
	}
	for (const route of routes) {
		if (!ROUTE_PATTERN.test(route)) {
			return { route, reason: 'invalid' };
		}
	}
	return null;
}
