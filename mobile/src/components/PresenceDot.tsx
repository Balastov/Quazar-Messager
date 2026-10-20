import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useOnline} from '../store/presence';

/** Зелёная точка «в сети» — кладётся внутрь круглого аватара. */
export default function PresenceDot({userId}: {userId: string | null | undefined}) {
  const online = useOnline(userId);
  if (!online) {
    return null;
  }
  return <View style={s.dot} accessibilityLabel="в сети" />;
}

const s = StyleSheet.create({
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#34d399',
    borderWidth: 2,
    borderColor: '#0f1117',
  },
});
