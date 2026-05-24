/**
 * Zhongwen workspace schema: id, branded types, tables, kv, and actions.
 * Pure data. No Y.Doc, no encryption, no openers.
 *
 * Distribution: this file is the `@epicenter/zhongwen` package root export.
 * Browser and daemon entrypoints import the schema from here and compose
 * runtime-specific attachments around it. The table and KV shapes here are
 * the wire contract for sync; forking a column shape breaks sync
 * compatibility with peers running the canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/zhongwen/src/routes/(signed-in)/zhongwen/browser.ts`
 *      → `openZhongwenBrowser({ signedIn, installationId })`
 *  - `apps/zhongwen/daemon.ts` → `openZhongwenDaemon(ctx)`
 */

import {
	defineKv,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
	type Tables,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';

export const ZHONGWEN_ID = 'epicenter.zhongwen';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Schema Records
// ─────────────────────────────────────────────────────────────────────────────

export const zhongwenTables = {
	conversations: conversationsTable,
	chatMessages: chatMessagesTable,
};
export type ZhongwenTables = Tables<typeof zhongwenTables>;

export const zhongwenKv = {
	showPinyin: defineKv(type('boolean'), true),
};
