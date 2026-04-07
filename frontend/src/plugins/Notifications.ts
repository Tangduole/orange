import { LocalNotifications, LocalNotificationSchema } from '@capacitor/local-notifications';

const CHANNEL_ID = 'orange-downloads';

/**
 * Initialize the notifications plugin
 */
export async function initNotifications(): Promise<boolean> {
  try {
    const result = await LocalNotifications.requestPermissions();
    if (result.display === 'granted') {
      // Register the channel for Android
      await LocalNotifications.registerActionTypes({
        types: [
          {
            id: 'download-complete',
            actions: [
              { id: 'open', title: 'Open' },
            ],
          },
        ],
      });
      return true;
    }
    return false;
  } catch (e) {
    console.error('[Notifications] Init failed:', e);
    return false;
  }
}

/**
 * Show download progress notification
 */
export async function showDownloadProgress(taskId: string, title: string, progress: number) {
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: taskId.hashCode ? taskId.hashCode() : hashString(taskId),
          title: '📥 Downloading',
          body: `${truncateTitle(title)} - ${progress}%`,
          ongoing: true,
          smallIcon: 'ic_notification',
          channelId: CHANNEL_ID,
        },
      ],
    });
  } catch (e) {
    console.error('[Notifications] Progress failed:', e);
  }
}

/**
 * Show download complete notification
 */
export async function showDownloadComplete(taskId: string, title: string, hasError = false) {
  try {
    // Cancel the progress notification first
    await LocalNotifications.cancel({ notifications: [{ id: hashString(taskId) }] });
    
    await LocalNotifications.schedule({
      notifications: [
        {
          id: hashString(taskId),
          title: hasError ? '❌ Download Failed' : '✅ Download Complete',
          body: hasError ? `${truncateTitle(title)} - Failed` : truncateTitle(title),
          smallIcon: 'ic_notification',
          channelId: CHANNEL_ID,
        },
      ],
    });
  } catch (e) {
    console.error('[Notifications] Complete failed:', e);
  }
}

/**
 * Cancel a download notification
 */
export async function cancelNotification(taskId: string) {
  try {
    await LocalNotifications.cancel({ notifications: [{ id: hashString(taskId) }] });
  } catch (e) {
    console.error('[Notifications] Cancel failed:', e);
  }
}

function truncateTitle(title: string, max = 50): string {
  if (!title) return 'Untitled';
  return title.length > max ? title.substring(0, max) + '...' : title;
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Listen for notification taps
LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
  console.log('[Notifications] Tapped:', notification);
  // Could navigate to the download or open the file here
});
