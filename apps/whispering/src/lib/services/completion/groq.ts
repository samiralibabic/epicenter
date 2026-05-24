import { createOpenAiCompatibleCompletionService } from './openai-compatible';

export const GroqCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'Groq',
		getBaseUrl: () => 'https://api.groq.com/openai/v1',
	});
