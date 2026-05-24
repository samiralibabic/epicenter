#!/usr/bin/env bun

import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';

try {
	await createCLI().run(hideBin(process.argv));
} catch (error) {
	console.error('Error:', String(error));
	process.exit(1); // usage (see README: Exit codes)
}
