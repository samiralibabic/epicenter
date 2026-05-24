/**
 * `/api/ai` sub-app: SSE streaming chat across OpenAI and Gemini.
 *
 * Library-side, billing-free. The deployment composes any plan or credit
 * gating in front of this app via Hono middleware. apps/api wraps this
 * with `autumnPlanGate`; a self-hosted team deployment mounts the sub-app
 * directly with no gate.
 *
 * BYOK: callers may pass `apiKey` in the request body, in which case the
 * deployment's provider key is ignored. No billing implications; the
 * library treats BYOK and house-key the same.
 */

import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type Tool,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createGeminiChat, GeminiTextModels } from '@tanstack/ai-gemini';
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { Env } from '../types.js';

const chatOptions = type({
	'systemPrompts?': 'string[] | undefined',
	'temperature?': 'number | undefined',
	'maxTokens?': 'number | undefined',
	'topP?': 'number | undefined',
	'metadata?': 'Record<string, unknown> | undefined',
	'conversationId?': 'string | undefined',
	'tools?': 'object[] | undefined',
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(
		type.or(
			{ provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
			{ provider: "'gemini'", model: type.enumerated(...GeminiTextModels) },
		),
	),
	/** Caller-provided API key for BYOK. When present, the deployment's house key is bypassed. */
	'apiKey?': 'string | undefined',
});

/**
 * Build the `/api/ai` sub-app.
 *
 * Mounts `POST /chat` only; auth is supplied by the parent composition
 * (cloud's bearer-only middleware, team's cookie-or-bearer middleware).
 */
export function createAiApp(): Hono<Env> {
	return new Hono<Env>().post(
		'/chat',
		describeRoute({
			description: 'Stream AI chat completions via SSE',
			tags: ['ai'],
		}),
		sValidator('json', aiChatBody),
		async (c) => {
			const { messages, data, apiKey: userApiKey } = c.req.valid('json');
			const { provider, tools, ...options } = data;

			let adapter: AnyTextAdapter;
			switch (data.provider) {
				case 'openai': {
					const apiKey = userApiKey ?? c.env.OPENAI_API_KEY;
					if (!apiKey)
						return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
					adapter = createOpenaiChat(data.model, apiKey);
					break;
				}
				case 'gemini': {
					const apiKey = userApiKey ?? c.env.GEMINI_API_KEY;
					if (!apiKey)
						return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
					adapter = createGeminiChat(data.model, apiKey);
					break;
				}
				default:
					return data satisfies never;
			}

			const abortController = new AbortController();
			const stream = chat({
				adapter,
				messages: messages as Array<ModelMessage>,
				...options,
				tools: tools as Array<Tool> | undefined,
				abortController,
			});

			return toServerSentEventsResponse(stream, { abortController });
		},
	);
}
