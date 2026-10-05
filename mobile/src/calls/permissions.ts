import {PermissionsAndroid, Platform} from 'react-native';

/** Request mic (+ camera for video) before getUserMedia on Android. */
export async function ensureCallPermissions(video: boolean): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const wanted: (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS][] =
    [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (video) {
    wanted.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  }

  try {
    const result = await PermissionsAndroid.requestMultiple(wanted);
    return wanted.every(p => result[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}
