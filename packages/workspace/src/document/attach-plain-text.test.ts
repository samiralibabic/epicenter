import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachPlainText } from './attach-plain-text.js';

describe('attachPlainText', () => {
	test('reserves the default "content" key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachPlainText(ydoc);

		expect(binding).toBe(ydoc.getText('content'));
	});

	test('honors a custom key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachPlainText(ydoc, 'code');

		expect(binding).toBe(ydoc.getText('code'));
	});

	test('read() returns the current text', () => {
		const ydoc = new Y.Doc();
		const { binding, read } = attachPlainText(ydoc);
		binding.insert(0, 'hello world');

		expect(read()).toBe('hello world');
	});

	test('read() returns empty string when fresh', () => {
		const ydoc = new Y.Doc();
		const { read } = attachPlainText(ydoc);

		expect(read()).toBe('');
	});

	test('write() replaces content atomically', () => {
		const ydoc = new Y.Doc();
		const { read, write, binding } = attachPlainText(ydoc);
		binding.insert(0, 'old');

		let txCount = 0;
		ydoc.on('afterTransaction', () => {
			txCount++;
		});

		write('new text');

		expect(read()).toBe('new text');
		// Single transaction covers delete+insert; no intermediate empty state visible.
		expect(txCount).toBe(1);
	});

	test('different keys on the same ydoc produce different bindings', () => {
		const ydoc = new Y.Doc();
		const a = attachPlainText(ydoc, 'a');
		const b = attachPlainText(ydoc, 'b');

		expect(a.binding).not.toBe(b.binding);
	});
});
