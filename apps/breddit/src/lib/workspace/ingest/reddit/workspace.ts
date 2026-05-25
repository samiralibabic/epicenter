/**
 * Reddit Workspace Definition
 *
 * Workspace definition with 1:1 CSV → table mapping for Reddit GDPR export data.
 * (Singleton/settings-like CSVs map to the KV store instead of tables.)
 * Uses TypeBox `column.*` schemas for type validation and inference.
 */

import {
	attachKv,
	attachTables,
	column,
	defineKv,
	defineTable,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import * as Y from 'yjs';

const redditTables = {
	/** posts.csv */
	posts: defineTable({
		id: column.string(),
		permalink: column.nullable(column.string()),
		date: column.nullable(column.string()),
		subreddit: column.string(),
		gildings: column.number(),
		title: column.nullable(column.string()),
		url: column.nullable(column.string()),
		body: column.nullable(column.string()),
	}),

	/** comments.csv */
	comments: defineTable({
		id: column.string(), // Composite: `${targetType}:${targetId}`
		permalink: column.nullable(column.string()),
		date: column.nullable(column.string()),
		subreddit: column.string(),
		gildings: column.number(),
		link: column.string(),
		parent: column.nullable(column.string()),
		body: column.nullable(column.string()),
		media: column.nullable(column.string()),
	}),

	/** drafts.csv */
	drafts: defineTable({
		id: column.string(),
		title: column.nullable(column.string()),
		body: column.nullable(column.string()),
		kind: column.nullable(column.string()),
		created: column.nullable(column.string()),
		spoiler: column.nullable(column.string()),
		nsfw: column.nullable(column.string()),
		original_content: column.nullable(column.string()),
		content_category: column.nullable(column.string()),
		flair_id: column.nullable(column.string()),
		flair_text: column.nullable(column.string()),
		send_replies: column.nullable(column.string()),
		subreddit: column.nullable(column.string()),
		is_public_link: column.nullable(column.string()),
	}),

	/** post_votes.csv */
	postVotes: defineTable({
		id: column.string(),
		permalink: column.string(),
		direction: column.enum(['up', 'down', 'none', 'removed']),
	}),

	/** comment_votes.csv */
	commentVotes: defineTable({
		id: column.string(),
		permalink: column.string(),
		direction: column.enum(['up', 'down', 'none', 'removed']),
	}),

	/** poll_votes.csv */
	pollVotes: defineTable({
		id: column.string(), // Composite: `${post_id}|${user_selection ?? ''}|${text ?? ''}`
		post_id: column.string(),
		user_selection: column.nullable(column.string()),
		text: column.nullable(column.string()),
		image_url: column.nullable(column.string()),
		is_prediction: column.nullable(column.string()),
		stake_amount: column.nullable(column.string()),
	}),

	/** saved_posts.csv */
	savedPosts: defineTable({
		id: column.string(),
		permalink: column.string(),
	}),

	/** saved_comments.csv */
	savedComments: defineTable({
		id: column.string(),
		permalink: column.string(),
	}),

	/** hidden_posts.csv */
	hiddenPosts: defineTable({
		id: column.string(),
		permalink: column.string(),
	}),

	/** messages.csv (optional) */
	messages: defineTable({
		id: column.string(),
		permalink: column.string(),
		thread_id: column.nullable(column.string()),
		date: column.nullable(column.string()),
		from: column.nullable(column.string()),
		to: column.nullable(column.string()),
		subject: column.nullable(column.string()),
		body: column.nullable(column.string()),
	}),

	/** messages_archive.csv */
	messagesArchive: defineTable({
		id: column.string(),
		permalink: column.string(),
		thread_id: column.nullable(column.string()),
		date: column.nullable(column.string()),
		from: column.nullable(column.string()),
		to: column.nullable(column.string()),
		subject: column.nullable(column.string()),
		body: column.nullable(column.string()),
	}),

	/** chat_history.csv */
	chatHistory: defineTable({
		id: column.string(), // message_id from CSV
		created_at: column.nullable(column.string()),
		updated_at: column.nullable(column.string()),
		username: column.nullable(column.string()),
		message: column.nullable(column.string()),
		thread_parent_message_id: column.nullable(column.string()),
		channel_url: column.nullable(column.string()),
		subreddit: column.nullable(column.string()),
		channel_name: column.nullable(column.string()),
		conversation_type: column.nullable(column.string()),
	}),

	/** subscribed_subreddits.csv */
	subscribedSubreddits: defineTable({
		id: column.string(), // subreddit
		subreddit: column.string(),
	}),

	/** moderated_subreddits.csv */
	moderatedSubreddits: defineTable({
		id: column.string(), // subreddit
		subreddit: column.string(),
	}),

	/** approved_submitter_subreddits.csv */
	approvedSubmitterSubreddits: defineTable({
		id: column.string(), // subreddit
		subreddit: column.string(),
	}),

	/** multireddits.csv */
	multireddits: defineTable({
		id: column.string(),
		display_name: column.nullable(column.string()),
		date: column.nullable(column.string()),
		description: column.nullable(column.string()),
		privacy: column.nullable(column.string()),
		subreddits: column.nullable(column.string()), // Comma-separated list
		image_url: column.nullable(column.string()),
		is_owner: column.nullable(column.string()),
		favorited: column.nullable(column.string()),
		followers: column.nullable(column.string()),
	}),

	/** gilded_content.csv */
	gildedContent: defineTable({
		id: column.string(), // Composite: `${content_link}|${date ?? ''}|${award ?? ''}|${amount ?? ''}`
		content_link: column.string(),
		award: column.nullable(column.string()),
		amount: column.nullable(column.string()),
		date: column.nullable(column.string()),
	}),

	/** gold_received.csv */
	goldReceived: defineTable({
		id: column.string(), // Composite: `${content_link}|${date ?? ''}|${gold_received ?? ''}|${gilder_username ?? ''}`
		content_link: column.string(),
		gold_received: column.nullable(column.string()),
		gilder_username: column.nullable(column.string()),
		date: column.nullable(column.string()),
	}),

	/** purchases.csv */
	purchases: defineTable({
		id: column.string(), // transaction_id
		processor: column.nullable(column.string()),
		transaction_id: column.string(),
		product: column.nullable(column.string()),
		date: column.nullable(column.string()),
		cost: column.nullable(column.string()),
		currency: column.nullable(column.string()),
		status: column.nullable(column.string()),
	}),

	/** subscriptions.csv */
	subscriptions: defineTable({
		id: column.string(), // subscription_id
		processor: column.nullable(column.string()),
		subscription_id: column.string(),
		product: column.nullable(column.string()),
		product_id: column.nullable(column.string()),
		product_name: column.nullable(column.string()),
		status: column.nullable(column.string()),
		start_date: column.nullable(column.string()),
		end_date: column.nullable(column.string()),
	}),

	/** payouts.csv */
	payouts: defineTable({
		id: column.string(), // payout_id ?? date
		payout_amount_usd: column.nullable(column.string()),
		date: column.nullable(column.string()),
		payout_id: column.nullable(column.string()),
	}),

	/** friends.csv */
	friends: defineTable({
		id: column.string(), // username
		username: column.string(),
		note: column.nullable(column.string()),
	}),

	/** announcements.csv */
	announcements: defineTable({
		id: column.string(), // announcement_id from CSV
		announcement_id: column.string(),
		sent_at: column.nullable(column.string()),
		read_at: column.nullable(column.string()),
		from_id: column.nullable(column.string()),
		from_username: column.nullable(column.string()),
		subject: column.nullable(column.string()),
		body: column.nullable(column.string()),
		url: column.nullable(column.string()),
	}),

	/** scheduled_posts.csv */
	scheduledPosts: defineTable({
		id: column.string(), // scheduled_post_id from CSV
		scheduled_post_id: column.string(),
		subreddit: column.nullable(column.string()),
		title: column.nullable(column.string()),
		body: column.nullable(column.string()),
		url: column.nullable(column.string()),
		submission_time: column.nullable(column.string()),
		recurrence: column.nullable(column.string()),
	}),
};

/**
 * KV singletons store one JSON-encoded payload per key. Both entries hold a
 * flat `Record<string, string>` (or `null` when the source CSV was absent),
 * so the schema is JSON-encoded via `column.json` and the union with
 * `Type.Null()` carries the "no data" state.
 */
const redditKv = {
	// Singleton values from CSV files
	statistics: defineKv(
		column.json(
			Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
		),
		(): Record<string, string> | null => null,
	),
	preferences: defineKv(
		column.json(
			Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
		),
		(): Record<string, string> | null => null,
	),
};

export function openReddit() {
	const id = 'reddit';
	const ydoc = new Y.Doc({ guid: id, gc: true });
	const tables = attachTables(ydoc, redditTables);
	const kv = attachKv(ydoc, redditKv);
	// no persistence/sync/encryption: in-memory-only importer target
	return {
		ydoc,
		tables,
		kv,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const redditWorkspace = openReddit();

export type RedditWorkspace = typeof redditWorkspace;
