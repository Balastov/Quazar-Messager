import React from 'react';
import {Linking, Platform, ScrollView, StyleSheet, Text, View, type TextStyle} from 'react-native';
import {hasMarkup, parseBlocks, type Block, type Inline, type ListItem} from '../chat/markdown';
import {highlight, resolveLang, type TokenKind} from '../chat/highlight';
import {splitLinks} from '../utils/linkify';

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

interface Props {
  text: string;
  /** Свой пузырь (фиолетовый) или чужой — от этого цвет ссылок. */
  isOwn: boolean;
  /** Базовый стиль текста сообщения. */
  style: TextStyle;
}

/** Обычный текст: ссылки нажимаются и открываются в браузере. */
function Leaf({text, isOwn}: {text: string; isOwn: boolean}) {
  const parts = React.useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.type === 'link' ? (
          <Text
            key={i}
            style={[s.link, isOwn ? s.linkOwn : s.linkOther]}
            onPress={() => void Linking.openURL(part.href).catch(() => {})}
            accessibilityRole="link">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function Inlines({parts, isOwn}: {parts: Inline[]; isOwn: boolean}) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === 'text') {
          return <Leaf key={i} text={p.text} isOwn={isOwn} />;
        }
        if (p.t === 'code') {
          return (
            <Text key={i} style={s.code}>
              {p.text}
            </Text>
          );
        }
        const style = p.t === 'bold' ? s.bold : p.t === 'italic' ? s.italic : s.strike;
        return (
          <Text key={i} style={style}>
            <Inlines parts={p.children} isOwn={isOwn} />
          </Text>
        );
      })}
    </>
  );
}

const TOKEN_COLORS: Record<TokenKind, string> = {
  kw: '#c792ea',
  str: '#c3e88d',
  num: '#f78c6c',
  com: '#7f7a99',
  fn: '#82aaff',
  lit: '#ff9cac',
  prop: '#80cbc4',
  tag: '#f07178',
  attr: '#ffcb6b',
  meta: '#89ddff',
  add: '#a5e075',
  del: '#ff8b8b',
};

function CodeBlock({lang, text}: {lang: string; text: string}) {
  const tokens = React.useMemo(() => highlight(text, resolveLang(lang, text)), [lang, text]);
  return (
    <View style={s.pre}>
      {!!lang && <Text style={s.lang}>{lang}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={s.preText}>
          {tokens.map((t, i) =>
            t.kind ? (
              <Text key={i} style={{color: TOKEN_COLORS[t.kind], fontStyle: t.kind === 'com' ? 'italic' : 'normal'}}>
                {t.text}
              </Text>
            ) : (
              t.text
            ),
          )}
        </Text>
      </ScrollView>
    </View>
  );
}

function List({ordered, items, isOwn, style}: {ordered: boolean; items: ListItem[]; isOwn: boolean; style: TextStyle}) {
  return (
    <View style={s.list}>
      {items.map((item, i) => (
        <View key={i} style={[s.listItem, {paddingLeft: item.depth * 14}]}>
          <Text style={[style, s.marker, ordered && s.markerNumber]}>
            {ordered ? `${item.n}.` : item.depth % 2 ? '◦' : '•'}
          </Text>
          <Text style={[style, s.listText]}>
            <Inlines parts={item.children} isOwn={isOwn} />
          </Text>
        </View>
      ))}
    </View>
  );
}

function Blocks({blocks, isOwn, style}: {blocks: Block[]; isOwn: boolean; style: TextStyle}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === 'para') {
          return (
            <Text key={i} style={style}>
              <Inlines parts={b.children} isOwn={isOwn} />
            </Text>
          );
        }
        if (b.t === 'code') {
          return <CodeBlock key={i} lang={b.lang} text={b.text} />;
        }
        if (b.t === 'quote') {
          return (
            <View key={i} style={s.quote}>
              <Blocks blocks={b.children} isOwn={isOwn} style={StyleSheet.flatten([style, s.quoteText])} />
            </View>
          );
        }
        return <List key={i} ordered={b.ordered} items={b.items} isOwn={isOwn} style={style} />;
      })}
    </>
  );
}

/**
 * Текст сообщения с разметкой (как в вебе): **жирный**, _курсив_, ~~зачёркнутый~~, `код`,
 * блоки кода с подсветкой, цитаты и списки. Без разметки — просто текст со ссылками.
 */
export default function FormattedText({text, isOwn, style}: Props) {
  const blocks = React.useMemo(() => (hasMarkup(text) ? parseBlocks(text) : null), [text]);
  if (!blocks) {
    return (
      <Text style={style}>
        <Leaf text={text} isOwn={isOwn} />
      </Text>
    );
  }
  return (
    <View style={s.root}>
      <Blocks blocks={blocks} isOwn={isOwn} style={style} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {gap: 6},
  bold: {fontWeight: '700'},
  italic: {fontStyle: 'italic'},
  strike: {textDecorationLine: 'line-through'},
  code: {fontFamily: MONO, fontSize: 13, backgroundColor: 'rgba(0,0,0,0.28)'},
  link: {textDecorationLine: 'underline'},
  linkOwn: {color: '#fff'},
  linkOther: {color: '#d8c8ff'},
  pre: {
    borderRadius: 10,
    backgroundColor: 'rgba(8,6,18,0.62)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  lang: {color: 'rgba(255,255,255,0.5)', fontSize: 11, fontFamily: MONO, marginBottom: 2},
  preText: {color: '#e7e3f7', fontFamily: MONO, fontSize: 12, lineHeight: 18},
  quote: {borderLeftWidth: 3, borderLeftColor: 'rgba(216,200,255,0.6)', paddingLeft: 10, gap: 6},
  quoteText: {color: 'rgba(255,255,255,0.82)'},
  list: {gap: 2},
  listItem: {flexDirection: 'row'},
  marker: {width: 16, color: '#d8c8ff'},
  markerNumber: {width: 24},
  listText: {flex: 1},
});
