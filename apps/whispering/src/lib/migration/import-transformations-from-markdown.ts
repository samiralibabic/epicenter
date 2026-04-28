import { join } from '@tauri-apps/api/path';
import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { load } from 'js-yaml';
import { PATHS } from '$lib/constants/paths';
import { whispering } from '$lib/whispering/client';
import type { Transformation, TransformationStep } from '$lib/workspace';

let importPromise: Promise<void> | undefined;

export function importTransformationsFromMarkdown(): Promise<void> {
	if (!window.__TAURI_INTERNALS__) return Promise.resolve();
	importPromise ??= runImport();
	return importPromise;
}

async function runImport() {
	await whispering.whenReady;

	const transformationsDir = await PATHS.DB.TRANSFORMATIONS();
	if (!(await exists(transformationsDir))) return;

	const files = await readDir(transformationsDir);
	const markdownFiles = files.filter((file) => file.name.endsWith('.md'));
	if (markdownFiles.length === 0) return;

	const existingTransformationIds = new Set(
		whispering.tables.transformations.getAllValid().map((row) => row.id),
	);

	const rowsToImport: Array<{
		transformation: Transformation;
		steps: TransformationStep[];
	}> = [];

	for (const file of markdownFiles) {
		const filePath = await join(transformationsDir, file.name);
		const content = await readTextFile(filePath);
		const frontmatter = parseFrontmatter(content);
		if (!frontmatter) continue;

		const transformation = toTransformation(frontmatter);
		if (!transformation) continue;
		if (existingTransformationIds.has(transformation.id)) continue;

		rowsToImport.push({
			transformation,
			steps: toSteps(frontmatter, transformation.id),
		});
	}

	if (rowsToImport.length === 0) return;

	whispering.batch(() => {
		for (const { transformation, steps } of rowsToImport) {
			whispering.tables.transformations.set(transformation);
			for (const step of steps) {
				whispering.tables.transformationSteps.set(step);
			}
		}
	});

	console.info(
		`[transformations-migration] Imported ${rowsToImport.length} transformation(s) from markdown`,
	);
}

function parseFrontmatter(content: string): Record<string, unknown> | undefined {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match?.[1]) return undefined;

	const parsed = load(match[1]);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}

	return parsed as Record<string, unknown>;
}

function toTransformation(raw: Record<string, unknown>): Transformation | undefined {
	const id = getString(raw, 'id');
	if (!id) return undefined;

	return {
		id,
		title: getString(raw, 'title') ?? '',
		description: getString(raw, 'description') ?? '',
		createdAt: getString(raw, 'createdAt') ?? new Date().toISOString(),
		updatedAt: getString(raw, 'updatedAt') ?? new Date().toISOString(),
		_v: 1,
	};
}

function toSteps(
	raw: Record<string, unknown>,
	transformationId: string,
): TransformationStep[] {
	const steps = raw.steps;
	if (!Array.isArray(steps)) return [];

	return steps.flatMap((step, order) => {
		if (typeof step !== 'object' || step === null || Array.isArray(step)) {
			return [];
		}

		const rawStep = step as Record<string, unknown>;
		const id = getString(rawStep, 'id');
		if (!id) return [];

		return {
			id,
			transformationId,
			order,
			type:
				getString(rawStep, 'type') === 'find_replace'
					? 'find_replace'
					: 'prompt_transform',
			inferenceProvider: getInferenceProvider(rawStep),
			openaiModel:
				getString(rawStep, 'prompt_transform.inference.provider.OpenAI.model') ??
				'gpt-4o',
			groqModel:
				getString(rawStep, 'prompt_transform.inference.provider.Groq.model') ??
				'llama-3.3-70b-versatile',
			anthropicModel:
				getString(rawStep, 'prompt_transform.inference.provider.Anthropic.model') ??
				'claude-sonnet-4-0',
			googleModel:
				getString(rawStep, 'prompt_transform.inference.provider.Google.model') ??
				'gemini-2.5-flash',
			openrouterModel:
				getString(rawStep, 'prompt_transform.inference.provider.OpenRouter.model') ??
				'',
			customModel:
				getString(rawStep, 'prompt_transform.inference.provider.Custom.model') ?? '',
			customBaseUrl:
				getString(rawStep, 'prompt_transform.inference.provider.Custom.baseUrl') ??
				'',
			systemPromptTemplate:
				getString(rawStep, 'prompt_transform.systemPromptTemplate') ?? '',
			userPromptTemplate:
				getString(rawStep, 'prompt_transform.userPromptTemplate') ?? '',
			findText: getString(rawStep, 'find_replace.findText') ?? '',
			replaceText: getString(rawStep, 'find_replace.replaceText') ?? '',
			useRegex: getBoolean(rawStep, 'find_replace.useRegex') ?? false,
			_v: 1,
		} satisfies TransformationStep;
	});
}

function getInferenceProvider(raw: Record<string, unknown>) {
	const provider = getString(raw, 'prompt_transform.inference.provider');
	if (
		provider === 'OpenAI' ||
		provider === 'Groq' ||
		provider === 'Anthropic' ||
		provider === 'Google' ||
		provider === 'OpenRouter' ||
		provider === 'Custom'
	) {
		return provider;
	}

	return 'Google';
}

function getString(raw: Record<string, unknown>, key: string) {
	const value = raw[key];
	return typeof value === 'string' ? value : undefined;
}

function getBoolean(raw: Record<string, unknown>, key: string) {
	const value = raw[key];
	return typeof value === 'boolean' ? value : undefined;
}
