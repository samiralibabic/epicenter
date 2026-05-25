/**
 * Per-model credit cost table for AI chat billing.
 *
 * One credit = $0.01 at Pro overage ($1 / 100 credits). Costs are sized
 * to hold ~50%+ margin against provider list prices, assuming an
 * average chat call of 750 input + 1500 output tokens. Models absent
 * from this map are rejected with a 400 at the AI gate, which both
 * gates entitlement and locks out prohibitively expensive models the
 * cloud will not subsidize (e.g. `o1-pro` at $150/$600 per million
 * tokens).
 */

import type { GeminiTextModels } from '@tanstack/ai-gemini';
import type { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

type SupportedModel =
	| (typeof OPENAI_CHAT_MODELS)[number]
	| (typeof GeminiTextModels)[number];

export const MODEL_CREDITS: Partial<Record<SupportedModel, number>> = {
	// OpenAI: nano/mini (1 credit)
	'gpt-5-nano': 1,
	'gpt-4.1-nano': 1,
	'gpt-4o-mini': 1,
	'gpt-5-mini': 1,
	'gpt-4.1-mini': 1,
	'gpt-3.5-turbo': 1,

	// OpenAI: reasoning mini (2 credits)
	'o4-mini': 2,
	'o3-mini': 2,

	// OpenAI: standard (3 credits)
	'gpt-5': 3,
	'gpt-5.1': 3,
	'gpt-5-codex': 3,
	'gpt-5.1-codex': 3,
	'gpt-4.1': 3,
	o3: 3,
	'o4-mini-deep-research': 3,

	// OpenAI: enhanced (4 to 5 credits)
	'gpt-4o': 4,
	'gpt-5.2': 5,
	'gpt-5.2-chat-latest': 5,
	'computer-use-preview': 5,

	// OpenAI: audio
	'gpt-audio': 4,
	'gpt-audio-mini': 2,
	'gpt-4o-audio': 4,
	'gpt-4o-mini-audio': 1,

	// OpenAI: chat/search variants
	'gpt-5.1-chat-latest': 3,
	'gpt-5-chat-latest': 3,
	'chatgpt-4o-latest': 4,
	'gpt-4o-search-preview': 4,
	'gpt-4o-mini-search-preview': 1,
	'gpt-5.1-codex-mini': 1,
	'codex-mini-latest': 1,

	// OpenAI: legacy (expensive)
	'gpt-4-turbo': 12,
	'gpt-4': 25,

	// OpenAI: premium reasoning
	o1: 25,
	'o3-deep-research': 15,
	'o3-pro': 30,

	// OpenAI: pro tier (very expensive). o1-pro intentionally absent
	// at $150/$600 per million tokens.
	'gpt-5-pro': 40,
	'gpt-5.2-pro': 55,

	// Gemini: flash lite (1 credit)
	'gemini-3.1-flash-lite-preview': 1,
	'gemini-2.5-flash-lite': 1,
	'gemini-2.0-flash-lite': 1,

	// Gemini: flash (1 to 2 credits)
	'gemini-3-flash-preview': 2,
	'gemini-2.5-flash': 1,
	'gemini-2.0-flash': 1,

	// Gemini: pro (5 credits)
	'gemini-3.1-pro-preview': 5,
	'gemini-3-pro-preview': 5,
	'gemini-2.5-pro': 5,
};

/** Coarse provider classification used by the dashboard model-cost
 *  table. Models that do not match any prefix are labeled "Unknown"
 *  rather than guessed at, so a misclassification never quietly ships. */
export function providerOf(
	model: string,
): 'OpenAI' | 'Google' | 'xAI' | 'Unknown' {
	if (
		model.startsWith('gpt') ||
		model.startsWith('o1') ||
		model.startsWith('o3') ||
		model.startsWith('o4') ||
		model.startsWith('computer-use') ||
		model.startsWith('chatgpt') ||
		model.startsWith('codex')
	) {
		return 'OpenAI';
	}
	if (model.startsWith('gemini')) return 'Google';
	if (model.startsWith('grok')) return 'xAI';
	return 'Unknown';
}
