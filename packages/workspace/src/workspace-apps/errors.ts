/**
 * Structured errors for daemon route registration and startup.
 *
 * Route validation surfaces `WorkspaceRouteRejected` before any daemon opens.
 * Startup wraps any throw from a daemon's `open(ctx)` in `WorkspaceOpenFailed`
 * so callers can dispose siblings on failure.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { DaemonRouteNameIssue } from '../daemon/route-validation.js';

export const WorkspaceAppError = defineErrors({
	WorkspaceRouteRejected: ({ route, reason }: DaemonRouteNameIssue) => ({
		message:
			reason === 'duplicate'
				? `Duplicate daemon route "${route}" in epicenter.config.ts.`
				: `Invalid daemon route "${route}" in epicenter.config.ts: use letters, numbers, "_" or "-", and avoid reserved object keys.`,
		route,
		reason,
	}),
	WorkspaceAuthSignedOut: () => ({
		message:
			'Cannot open daemon routes while machine auth is signed out. Run `epicenter auth login` first.',
	}),
	WorkspaceOpenFailed: ({
		route,
		cause,
	}: {
		route: string;
		cause: unknown;
	}) => ({
		message: `Daemon route "${route}" failed to open: ${extractErrorMessage(cause)}`,
		route,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
