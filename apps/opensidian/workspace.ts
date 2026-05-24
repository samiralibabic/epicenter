/**
 * Opensidian workspace schema: id, branded types, tables, actions factory, and
 * per-row derived guids. Pure data. No Y.Doc, no encryption, no openers.
 *
 * Distribution: `apps/opensidian/package.json` exports this file as the
 * `opensidian` package root. Browser code, daemon code, and tests all import
 * from here. The table shapes here are the wire contract for sync; forking a
 * column shape breaks sync compatibility with peers running the canonical
 * schema.
 *
 * Composition lives elsewhere:
 *  - `apps/opensidian/src/lib/opensidian/browser.ts` -> `openOpensidianBrowser({ signedIn, installationId })`
 *  - `apps/opensidian/daemon.ts`                     -> `openOpensidianDaemon(ctx)`
 */

import {
	type FileId,
	fileContentDocGuid,
	filesTable,
} from '@epicenter/filesystem';
import {
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
	type Tables,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';

export const OPENSIDIAN_ID = 'epicenter.opensidian';

/**
 * Branded conversation ID for a single chat thread.
 *
 * Used as the primary key for conversations and as the foreign key for all
 * messages that belong to that thread. The brand prevents accidental mixing
 * with message IDs or other plain strings.
 */
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();

/**
 * Generate a unique {@link ConversationId} for a new conversation row.
 *
 * This keeps call sites from casting raw strings and makes the ID source of
 * truth obvious wherever a conversation is created.
 */
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

/**
 * Branded chat message ID for one persisted assistant, user, or system message.
 *
 * The brand keeps message IDs distinct from conversation IDs so references
 * stay type-safe across joins and edits.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();

/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * This mirrors {@link generateConversationId} and centralizes the branded ID
 * cast in one place.
 */
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;

/**
 * Conversations: metadata for each chat thread.
 *
 * Stores the thread title, optional parent/subpage relationship, source
 * message linkage, and the model/provider metadata needed to resume or audit
 * the conversation later.
 */
const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		'parentId?': ConversationId.or('undefined'),
		'sourceMessageId?': ChatMessageId.or('undefined'),
		'systemPrompt?': 'string | undefined',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

/**
 * Chat messages: the persisted content of each conversation turn.
 *
 * Stores the role, structured content parts, and creation timestamp so the UI
 * can replay the exact chat history without depending on live model state.
 */
const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant' | 'system'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

/**
 * Tool trust: per-tool approval preferences for chat actions.
 *
 * Tracks whether a tool should keep asking for approval or be auto-approved,
 * which lets Opensidian remember the user's trust decisions across sessions.
 */
const toolTrustTable = defineTable(
	type({
		id: 'string',
		trust: "'ask' | 'always'",
		_v: '1',
	}),
);
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

/**
 * Opensidian workspace table schema.
 *
 * Combines the filesystem-backed notes table with the chat tables so the app
 * can store notes, conversations, messages, and tool approvals in one schema.
 */
export const opensidianTables = {
	files: filesTable,
	conversations: conversationsTable,
	chatMessages: chatMessagesTable,
	toolTrust: toolTrustTable,
};
export type OpensidianTables = Tables<typeof opensidianTables>;

/**
 * Deterministic guid of a file's content sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity. Thin wrapper
 * around {@link fileContentDocGuid} that pins the workspace id.
 */
export function opensidianFileContentDocGuid(fileId: FileId): string {
	return fileContentDocGuid({
		workspaceId: OPENSIDIAN_ID,
		fileId,
	});
}
