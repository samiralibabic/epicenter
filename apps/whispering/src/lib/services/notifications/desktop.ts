import {
	active,
	isPermissionGranted,
	removeActive,
	requestPermission,
	sendNotification,
} from '@tauri-apps/plugin-notification';
import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { NotificationService, UnifiedNotificationOptions } from './types';
import {
	hashNanoidToNumber,
	NotificationError,
	toTauriNotification,
} from './types';

/**
 * Creates a desktop notification service implementation using Tauri's notification plugin.
 * Handles permission requests, notification display, and cleanup of active notifications.
 */
export function createNotificationServiceDesktop() {
	/**
	 * Removes a notification by its numeric ID from the active notifications list.
	 * Retrieves all active notifications, finds the matching one, and removes it if found.
	 *
	 * @param id - The numeric ID of the notification to remove
	 */
	const removeNotificationById = async (
		id: number,
	): Promise<Result<void, NotificationError>> => {
		const { data: activeNotifications, error: activeNotificationsError } =
			await tryAsync({
				try: async () => await active(),
				catch: (error) => NotificationError.ListActiveFailed({ cause: error }),
			});
		if (activeNotificationsError) return Err(activeNotificationsError);
		const matchingActiveNotification = activeNotifications.find(
			(notification) => notification.id === id,
		);
		if (matchingActiveNotification) {
			const { error: removeActiveError } = await tryAsync({
				try: async () => await removeActive([matchingActiveNotification]),
				catch: (error) => NotificationError.RemoveFailed({ id, cause: error }),
			});
			if (removeActiveError) return Err(removeActiveError);
		}
		return Ok(undefined);
	};

	return {
		/**
		 * Displays a desktop notification with the provided options.
		 * Generates a unique ID if none provided, requests permissions if needed,
		 * removes any existing notification with the same ID, then sends the new notification.
		 *
		 * @param options - Notification configuration including title, description, and optional ID
		 */
		async notify({
			id: notificationId,
			...notificationOptions
		}: UnifiedNotificationOptions) {
			const idStringified = notificationId ?? nanoid();
			const id = hashNanoidToNumber(idStringified);

			await removeNotificationById(id);

			const { error: notifyError } = await tryAsync({
				try: async () => {
					let permissionGranted = await isPermissionGranted();
					if (!permissionGranted) {
						const permission = await requestPermission();
						permissionGranted = permission === 'granted';
					}
					if (permissionGranted) {
						const tauriOptions = toTauriNotification({
							id: notificationId,
							...notificationOptions,
						});
						sendNotification({
							...tauriOptions,
							id, // Override with our numeric id
						});
					}
				},
				catch: (error) => NotificationError.SendFailed({ cause: error }),
			});
			if (notifyError) return Err(notifyError);
			return Ok(idStringified);
		},
		/**
		 * Clears a notification by its string ID.
		 * Converts the string ID to a numeric hash and removes the corresponding notification.
		 *
		 * @param idStringified - The string ID of the notification to clear
		 */
		clear: async (idStringified) => {
			const removeNotificationResult = await removeNotificationById(
				hashNanoidToNumber(idStringified),
			);
			return removeNotificationResult;
		},
	} satisfies NotificationService;
}
