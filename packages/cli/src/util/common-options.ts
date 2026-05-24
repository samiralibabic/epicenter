/**
 * Shared project-root option for commands that address a local daemon.
 *
 * By default commands discover the nearest Epicenter project from the
 * current working directory. `-C <dir>` changes the discovery start point.
 */

import { findProjectRoot } from '@epicenter/workspace/node';
import type { Options } from 'yargs';

export const projectOption = {
	type: 'string',
	description:
		'Project root (or any directory under it; discovery walks up to the nearest `epicenter.config.ts`).',
	default: () => process.cwd(),
	defaultDescription: 'current working directory',
	coerce: findProjectRoot,
} satisfies Options;
