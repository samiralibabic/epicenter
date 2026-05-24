import { Ok } from 'wellcrafted/result';
import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import { CompletionError } from './types';

/**
 * Custom completion service for local LLM endpoints (Ollama, LM Studio, llama.cpp, etc.)
 * Uses the OpenAI-compatible API pattern that most local servers support.
 */
export const CustomCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'Custom',
		getBaseUrl: (params) => params.baseUrl,
		validateParams: (params) => {
			if (!params.baseUrl) {
				return CompletionError.MissingParam({
					param: 'Custom provider base URL',
				});
			}
			if (!params.model) {
				return CompletionError.MissingParam({
					param: 'Custom provider model name',
				});
			}
			return Ok(undefined);
		},
	});
