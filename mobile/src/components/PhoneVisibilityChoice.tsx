import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, StyleSheet, Text, View} from 'react-native';

export const PHONE_VISIBILITY_QUESTION = 'Вас можно найти по номеру телефона?';

const OPTIONS = [
  {value: true, label: 'Да', icon: '📞', hint: 'вас могут найти через поиск, зная ваш номер телефона.'},
  {
    value: false,
    label: 'Нет',
    icon: '🔒',
    hint: 'вас найдут только по никнейму или по имени и фамилии. Номер не увидит никто.',
  },
] as const;

interface Props {
  /** null — ещё не выбрано: значения по умолчанию нет, выбор обязателен. */
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Вопрос над переключателем (в окне он уже в заголовке). */
  showQuestion?: boolean;
}

/** «Да / Нет» с бегунком и расшифровкой вариантов — как на вебе. */
export default function PhoneVisibilityChoice({value, onChange, disabled, showQuestion = true}: Props) {
  const [width, setWidth] = useState(0);
  const pos = useRef(new Animated.Value(value === false ? 1 : 0)).current;
  const shown = useRef(new Animated.Value(value === null ? 0 : 1)).current;

  useEffect(() => {
    if (value !== null) {
      Animated.spring(pos, {toValue: value ? 0 : 1, useNativeDriver: true, friction: 7, tension: 80}).start();
    }
    Animated.timing(shown, {
      toValue: value === null ? 0 : 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [value, pos, shown]);

  const half = Math.max(0, (width - 8) / 2);

  return (
    <View style={s.root}>
      {showQuestion && <Text style={s.question}>{PHONE_VISIBILITY_QUESTION}</Text>}
      <View
        style={[s.track, value === null && s.trackAsk, disabled && s.disabled]}
        onLayout={e => setWidth(e.nativeEvent.layout.width)}
        accessibilityRole="radiogroup"
        accessibilityLabel={PHONE_VISIBILITY_QUESTION}>
        {width > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              s.thumb,
              value === false && s.thumbNo,
              {
                width: half,
                opacity: shown,
                transform: [
                  {translateX: pos.interpolate({inputRange: [0, 1], outputRange: [0, half]})},
                  {scale: shown.interpolate({inputRange: [0, 1], outputRange: [0.85, 1]})},
                ],
              },
            ]}
          />
        )}
        {OPTIONS.map(o => {
          const checked = value === o.value;
          return (
            <Pressable
              key={o.label}
              style={s.option}
              onPress={() => onChange(o.value)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{checked, disabled}}>
              <Text style={[s.optionText, checked && s.optionChecked]}>
                {o.icon} {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {OPTIONS.map(o => (
        <Text
          key={o.label}
          style={[s.legend, value !== null && (value === o.value ? s.legendOn : s.legendOff)]}>
          <Text style={s.legendLabel}>{o.label}</Text> — {o.hint}
        </Text>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  root: {gap: 8},
  question: {color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 2},
  track: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 999,
    backgroundColor: '#0b0d14',
    borderWidth: 1,
    borderColor: '#2a2d3a',
  },
  // Ничего не выбрано — подсвеченная рамка: выбор обязателен.
  trackAsk: {borderColor: 'rgba(108,99,255,0.6)'},
  disabled: {opacity: 0.6},
  thumb: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: 999,
    backgroundColor: '#8b5cf6',
    shadowColor: '#a855f7',
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 0},
    elevation: 6,
  },
  // «Нет» — приватность: холоднее, индиго.
  thumbNo: {backgroundColor: '#6366f1', shadowColor: '#6366f1'},
  option: {flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center'},
  optionText: {color: '#9b93b8', fontSize: 15, fontWeight: '600'},
  optionChecked: {color: '#fff'},
  legend: {color: '#9b93b8', fontSize: 12, lineHeight: 17},
  legendOn: {color: '#e0e0e0'},
  legendOff: {opacity: 0.5},
  legendLabel: {color: '#fff', fontWeight: '600'},
});
