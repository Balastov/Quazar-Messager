import React from 'react';
import {StyleSheet, View} from 'react-native';
import {usePresenceKind} from '../store/presence';

/** Точка на аватаре: зелёная — в сети, жёлтая — отошёл(ла), красная — на встрече / не беспокоить. */
export default function PresenceDot({userId}: {userId: string | null | undefined}) {
  const kind = usePresenceKind(userId);
  if (kind === 'busy') {
    return <View style={[s.dot, s.busy]} accessibilityLabel="занят" />;
  }
  if (kind === 'online') {
    return <View style={s.dot} accessibilityLabel="в сети" />;
  }
  if (kind === 'away') {
    return <View style={[s.dot, s.away]} accessibilityLabel="отошёл(ла)" />;
  }
  return null;
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
  away: {backgroundColor: '#fbbf24'},
  busy: {backgroundColor: '#f87171'},
});
