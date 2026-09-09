import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { AccountId, ApnsEnvironment, NotificationModule } from '@ldr/core';

/** Why an APNs registration attempt did not write a token. */
export type ApnsRegistrationResult =
  'registered' | 'unsupported' | 'permission-denied' | 'unavailable';

/** APNs device tokens are non-empty byte strings represented as hexadecimal. */
export function isApnsDeviceToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
  );
}

function hasIosNotificationPermission(
  permission: Notifications.NotificationPermissionsStatus,
): boolean {
  const status = permission.ios?.status;
  return (
    status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

async function persistApnsToken(
  notifications: Pick<NotificationModule, 'setApnsDeviceToken'>,
  accountId: AccountId,
  token: { readonly type: string; readonly data: unknown },
): Promise<boolean> {
  if (token.type !== 'ios' || !isApnsDeviceToken(token.data)) return false;
  const environment: ApnsEnvironment | null =
    await Application.getIosPushNotificationServiceEnvironmentAsync();
  if (environment === null) return false;
  return (await notifications.setApnsDeviceToken(accountId, token.data, environment)) !== null;
}

/**
 * Register this iOS installation with the direct-APNs path.
 *
 * `requestPermission` is intentionally explicit: boot passes false so it can
 * silently refresh an already-authorized token, while Settings passes true so
 * the user controls the only permission prompt in the app.
 */
export async function registerApnsToken(
  notifications: Pick<NotificationModule, 'setApnsDeviceToken'>,
  accountId: AccountId,
  requestPermission: boolean,
): Promise<ApnsRegistrationResult> {
  if (Platform.OS !== 'ios' || !Device.isDevice) return 'unsupported';

  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!hasIosNotificationPermission(permission) && requestPermission) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!hasIosNotificationPermission(permission)) return 'permission-denied';

    const token = await Notifications.getDevicePushTokenAsync();
    return (await persistApnsToken(notifications, accountId, token)) ? 'registered' : 'unavailable';
  } catch {
    // Notification APIs are unavailable in Expo Go/simulators and can reject
    // while iOS is still registering the device. Registration is best effort;
    // the next boot or Settings attempt can retry without blocking sign-in.
    return 'unavailable';
  }
}

/**
 * Forward APNs token rotations while this account is active. The token is not
 * cached locally: every rotation is written through the epoch-guarded sync
 * path, and the returned subscription is scoped to the current account.
 */
export function subscribeApnsTokenRotation(
  notifications: Pick<NotificationModule, 'setApnsDeviceToken'>,
  accountId: AccountId,
): () => void {
  if (Platform.OS !== 'ios' || !Device.isDevice) return () => undefined;

  const subscription = Notifications.addPushTokenListener((token) => {
    void (async () => {
      try {
        const permission = await Notifications.getPermissionsAsync();
        if (!hasIosNotificationPermission(permission)) return;
        await persistApnsToken(notifications, accountId, token);
      } catch {
        // A token rotation is best effort; the next boot can retry it.
      }
    })();
  });
  return () => subscription.remove();
}
