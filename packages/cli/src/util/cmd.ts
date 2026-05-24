import type {
	ArgumentsCamelCase,
	Argv,
	CommandModule,
	InferredOptionTypes,
	Options,
} from 'yargs';

type EmptyArgs = Record<never, never>;
type OptionsBuilder = Record<string, Options>;

type BuilderArgs<TBuilder> = TBuilder extends (
	yargs: Argv<EmptyArgs>,
) => Argv<infer TArgs>
	? TArgs
	: TBuilder extends (yargs: Argv<EmptyArgs>) => PromiseLike<Argv<infer TArgs>>
		? TArgs
		: never;

type CommandBuilderFunction = (
	yargs: Argv<EmptyArgs>,
) => Argv<unknown> | PromiseLike<Argv<unknown>>;

type CommandFromOptions<TOptions extends OptionsBuilder> = Omit<
	CommandModule<EmptyArgs, InferredOptionTypes<TOptions>>,
	'builder' | 'handler'
> & {
	builder: TOptions;
	handler: (
		argv: ArgumentsCamelCase<InferredOptionTypes<TOptions>>,
	) => void | Promise<void>;
};

type CommandFromBuilder<TBuilder extends CommandBuilderFunction> = Omit<
	CommandModule<EmptyArgs, BuilderArgs<TBuilder>>,
	'builder' | 'handler'
> & {
	builder: TBuilder;
	handler: (
		argv: ArgumentsCamelCase<BuilderArgs<TBuilder>>,
	) => void | Promise<void>;
};

type CommandWithoutBuilder = Omit<
	CommandModule<EmptyArgs, EmptyArgs>,
	'builder' | 'handler'
> & {
	builder?: undefined;
	handler: (argv: ArgumentsCamelCase<EmptyArgs>) => void | Promise<void>;
};

export function cmd<TOptions extends OptionsBuilder>(
	command: CommandFromOptions<TOptions>,
): CommandModule<EmptyArgs, InferredOptionTypes<TOptions>>;
export function cmd<TBuilder extends CommandBuilderFunction>(
	command: CommandFromBuilder<TBuilder>,
): CommandModule<EmptyArgs, BuilderArgs<TBuilder>>;
export function cmd(
	command: CommandWithoutBuilder,
): CommandModule<EmptyArgs, EmptyArgs>;
export function cmd(command: unknown) {
	return command;
}
