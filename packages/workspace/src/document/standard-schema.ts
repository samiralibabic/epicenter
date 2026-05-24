import type {
	StandardJSONSchemaV1,
	StandardSchemaV1,
} from '@standard-schema/spec';

/**
 * Schema type that implements both StandardSchema (validation) and StandardJSONSchema (conversion).
 *
 * ArkType, Zod (v4.2+), and Valibot (with adapter) all implement both specs.
 */
export type CombinedStandardSchema<TInput = unknown, TOutput = TInput> = {
	'~standard': StandardSchemaV1.Props<TInput, TOutput> &
		StandardJSONSchemaV1.Props<TInput, TOutput>;
};
