/**
 * `attachKv()` — bind KV definitions to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('kv')` and
 * wraps it with a typed `Kv`. KV uses validate-or-default semantics:
 * invalid or missing values return the result of the definition's
 * `defaultValue()` factory.
 *
 * For encrypted storage, call `encryption.attachKv` on the coordinator
 * returned by `attachEncryption(ydoc, { keyring })`.
 *
 * `attachKv` and `createKv` accept an optional `{ logger? }`: when provided,
 * validation failures emit `logger.warn(KvError.ValidationFailed({ key, raw }))`
 * without changing the return contract. When omitted, behavior is silent.
 */

import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { KV_KEY } from './keys';
import {
	type KvStoreChange,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index';

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Change event for KV observation. */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

/**
 * Errors emitted to the optional logger. The default value is still returned
 * (the silent-by-default contract), but consumers that provide a logger see
 * a structured `ValidationFailed` event.
 */
export const KvError = defineErrors({
	ValidationFailed: ({ key, raw }: { key: string; raw: unknown }) => ({
		message: `[kv] Stored value for "${key}" failed schema validation; returning default`,
		key,
		raw,
	}),
});
export type KvError = InferErrors<typeof KvError>;

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by `defineKv(schema, defaultValue)`.
 *
 * `defaultValue` is always a factory: the library calls it on every default
 * firing, so each call returns a fresh value safe to mutate.
 */
export type KvDefinition<S extends TSchema = TSchema> = {
	schema: S;
	defaultValue: () => Static<S>;
};

/** Extract the value type from a KvDefinition. */
export type InferKvValue<T> =
	T extends KvDefinition<infer S> ? Static<S> : never;

/** Map of KV definitions (uses `any` to allow variance in generic parameters). */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/** Optional knobs for `attachKv` / `createKv`. */
export type KvOptions = {
	/**
	 * Logger that captures validation failures via
	 * `logger.warn(KvError.ValidationFailed({ key, raw }))`. Omit for silent
	 * behavior; no module-level default logger is installed.
	 */
	logger?: Logger;
};

/**
 * Dictionary-style typed handle over a KV store.
 */
export type Kv<TKvDefinitions extends KvDefinitions> = ReturnType<
	typeof createKv<TKvDefinitions>
>;

/**
 * Bind a record of KV definitions to a Y.Doc and return a typed Kv.
 */
export function attachKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
	opts?: KvOptions,
): Kv<TKvDefinitions> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createKv(ykv, definitions, opts);
}

/**
 * Build a Kv helper over any `ObservableKvStore`. Exported so
 * `@epicenter/workspace` can reuse the helper logic over its encrypted
 * store wrapper.
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ykv: ObservableKvStore<unknown>,
	definitions: TKvDefinitions,
	opts?: KvOptions,
) {
	const logger = opts?.logger;
	return {
		get<K extends keyof TKvDefinitions & string>(
			key: K,
		): InferKvValue<TKvDefinitions[K]> {
			const definition = definitions[key]!;
			const raw = ykv.get(key);
			if (raw === undefined) {
				return definition.defaultValue() as InferKvValue<TKvDefinitions[K]>;
			}
			if (Value.Check(definition.schema, raw)) {
				return raw as InferKvValue<TKvDefinitions[K]>;
			}
			logger?.warn(KvError.ValidationFailed({ key, raw }));
			return definition.defaultValue() as InferKvValue<TKvDefinitions[K]>;
		},

		set<K extends keyof TKvDefinitions & string>(
			key: K,
			value: InferKvValue<TKvDefinitions[K]>,
		): void {
			ykv.set(key, value);
		},

		delete<K extends keyof TKvDefinitions & string>(key: K): void {
			ykv.delete(key);
		},

		observe<K extends keyof TKvDefinitions & string>(
			key: K,
			callback: (
				change: KvChange<InferKvValue<TKvDefinitions[K]>>,
				origin?: unknown,
			) => void,
		): () => void {
			const definition = definitions[key]!;

			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, origin);
						break;
					case 'add':
					case 'update': {
						if (Value.Check(definition.schema, change.newValue)) {
							callback(
								{
									type: 'set',
									value: change.newValue as InferKvValue<TKvDefinitions[K]>,
								},
								origin,
							);
						}
						break;
					}
					default:
						change satisfies never;
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		observeAll(
			callback: (
				changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
				origin?: unknown,
			) => void,
		): () => void {
			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const parsed = new Map<string, KvChange<unknown>>();
				for (const [key, change] of changes) {
					const definition = definitions[key];
					if (!definition) continue;
					if (change.action === 'delete') {
						parsed.set(key, { type: 'delete' });
					} else if (Value.Check(definition.schema, change.newValue)) {
						parsed.set(key, { type: 'set', value: change.newValue });
					}
				}
				if (parsed.size > 0) {
					callback(
						parsed as Map<keyof TKvDefinitions & string, KvChange<unknown>>,
						origin,
					);
				}
			};
			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		getAll(): {
			[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
		} {
			const result = {} as {
				[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
			};
			for (const key of Object.keys(definitions)) {
				const typedKey = key as keyof TKvDefinitions & string;
				result[typedKey] = this.get(typedKey);
			}
			return result;
		},
	};
}
