import { cmd } from '../util/cmd.js';
import { downCommand } from './down.js';
import { logsCommand } from './logs.js';
import { psCommand } from './ps.js';
import { upCommand } from './up.js';

export const daemonCommand = cmd({
	command: 'daemon',
	describe: 'Operate the local Epicenter daemon.',
	builder: (yargs) =>
		yargs
			.command(upCommand)
			.command(downCommand)
			.command(psCommand)
			.command(logsCommand)
			.demandCommand(1, 'Specify a subcommand: up, down, ps, or logs')
			.strict()
			.help(),
	handler: () => {},
});
