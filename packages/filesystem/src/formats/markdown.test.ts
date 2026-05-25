/**
 * Markdown Tests
 *
 * Covers markdown/frontmatter parsing and Yjs conversion helpers used by markdown-mode
 * files. These tests protect fidelity between plain markdown content and structured Yjs
 * state used by the filesystem layer.
 *
 * Key behaviors:
 * - Frontmatter and markdown body round-trip predictably across parse/serialize helpers.
 * - Y.Map and Y.XmlFragment adapters preserve expected document content.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	parseFrontmatter,
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	updateYMapFromRecord,
	updateYXmlFragmentFromString,
	yMapToRecord,
} from './markdown.js';

describe('parseFrontmatter', () => {
	test('parseFrontmatter returns empty metadata when front matter is absent', () => {
		const result = parseFrontmatter('# Hello World');
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe('# Hello World');
	});

	test('parseFrontmatter extracts front matter and markdown body', () => {
		const input = '---\ntitle: Hello\ndate: 2026-02-09\n---\n# Content';
		const result = parseFrontmatter(input);
		expect(result.frontmatter).toEqual({ title: 'Hello', date: '2026-02-09' });
		expect(result.body).toBe('# Content');
	});

	test('front matter with types', () => {
		const input = '---\ncount: 42\nactive: true\ntags: [a, b, c]\n---\nBody';
		const result = parseFrontmatter(input);
		expect(result.frontmatter.count).toBe(42);
		expect(result.frontmatter.active).toBe(true);
		expect(result.frontmatter.tags).toEqual(['a', 'b', 'c']);
	});

	test('empty body with front matter', () => {
		const input = '---\ntitle: Test\n---\n';
		const result = parseFrontmatter(input);
		expect(result.frontmatter).toEqual({ title: 'Test' });
		expect(result.body).toBe('');
	});
});

describe('serializeMarkdownWithFrontmatter', () => {
	test('empty frontmatter returns body only', () => {
		const result = serializeMarkdownWithFrontmatter({}, '# Hello');
		expect(result).toBe('# Hello');
	});

	test('serializeMarkdownWithFrontmatter emits YAML block before body', () => {
		const result = serializeMarkdownWithFrontmatter(
			{ title: 'Test' },
			'# Hello',
		);
		expect(result).toBe('---\ntitle: Test\n---\n# Hello');
	});
});

describe('Y.Map helpers', () => {
	test('updateYMapFromRecord sets keys', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');

		updateYMapFromRecord(ymap, { a: 1, b: 'hello', c: true });

		expect(ymap.get('a')).toBe(1);
		expect(ymap.get('b')).toBe('hello');
		expect(ymap.get('c')).toBe(true);
	});

	test('updateYMapFromRecord deletes missing keys', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');
		ymap.set('old', 'value');

		updateYMapFromRecord(ymap, { new: 'value' });

		expect(ymap.has('old')).toBe(false);
		expect(ymap.get('new')).toBe('value');
	});

	test('yMapToRecord round-trip', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');
		updateYMapFromRecord(ymap, { title: 'Hello', count: 42 });

		const record = yMapToRecord(ymap);
		expect(record).toEqual({ title: 'Hello', count: 42 });
	});
});

describe('XmlFragment serialization', () => {
	test('round-trip: markdown → XmlFragment → markdown', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		const original = '# Hello World\n\nThis is a paragraph.\n';
		updateYXmlFragmentFromString(fragment, original);

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		// ProseMirror may normalize slightly, but structure should be preserved
		expect(serialized).toContain('Hello World');
		expect(serialized).toContain('This is a paragraph.');
	});

	test('empty markdown still serializes XmlFragment to a string', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		updateYXmlFragmentFromString(fragment, '');

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		expect(typeof serialized).toBe('string');
	});

	test('formatted markdown preserves visible text through XmlFragment conversion', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		updateYXmlFragmentFromString(fragment, '**bold** and *italic*\n');

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		expect(serialized).toContain('bold');
		expect(serialized).toContain('italic');
	});
});
