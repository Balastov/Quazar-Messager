import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import LottieView from 'lottie-react-native';
import {stickerFileUrl, type StickerInfo} from '../api/stickers';

interface Props {
  sticker: StickerInfo;
  size: number;
  /** false — первый кадр (панель выбора: десятки анимаций сразу тяжело). */
  animate: boolean;
}

/** Lottie-стикер; пока анимация грузится — эмодзи. */
export default function Sticker({sticker, size, animate}: Props) {
  const [ready, setReady] = React.useState(false);
  return (
    <View
      style={{width: size, height: size}}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Стикер ${sticker.emoji}`}>
      {!ready && (
        <Text style={[styles.placeholder, {fontSize: size * 0.55, lineHeight: size}]}>
          {sticker.emoji || '🙂'}
        </Text>
      )}
      <LottieView
        source={{uri: stickerFileUrl(sticker)}}
        autoPlay={animate}
        loop={animate}
        progress={animate ? undefined : 0}
        onAnimationLoaded={() => setReady(true)}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {textAlign: 'center', opacity: 0.55},
});
