import React from 'react';
import {FlatList, Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import type {StickerInfo} from '../api/stickers';
import {useStickersStore} from '../store/stickers';
import Sticker from './Sticker';

interface Props {
  onPick: (packId: string, sticker: StickerInfo) => void;
}

/** Панель стикеров вместо клавиатуры: вкладки паков и сетка, нажатие — отправка. */
export default function StickerPanel({onPick}: Props) {
  const packs = useStickersStore(st => st.packs);
  const loaded = useStickersStore(st => st.loaded);
  const load = useStickersStore(st => st.load);
  const [packId, setPackId] = React.useState<string | null>(null);

  React.useEffect(() => {
    void load();
  }, [load]);

  const pack = packs.find(p => p.id === packId) ?? packs[0];

  return (
    <View style={s.panel}>
      {packs.length > 1 && (
        <View style={s.tabs}>
          {packs.map(p => (
            <Pressable
              key={p.id}
              onPress={() => setPackId(p.id)}
              style={[s.tab, p.id === pack?.id && s.tabActive]}>
              <Text style={s.tabText}>{p.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {!loaded ? (
        <Text style={s.hint}>Загружаем стикеры…</Text>
      ) : (
        <FlatList
          data={pack?.stickers ?? []}
          keyExtractor={st => st.id}
          numColumns={4}
          contentContainerStyle={s.grid}
          renderItem={({item}) => (
            <Pressable
              style={({pressed}) => [s.cell, pressed && s.cellPressed]}
              onPress={() => pack && onPick(pack.id, item)}
              accessibilityLabel={`Отправить стикер ${item.emoji}`}>
              <Sticker sticker={item} size={64} animate={false} />
            </Pressable>
          )}
        />
      )}
      {pack && (
        <Text
          style={s.credit}
          onPress={() => pack.license_url && void Linking.openURL(pack.license_url).catch(() => {})}>
          {[pack.title, pack.author, pack.license].filter(Boolean).join(' · ')}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  panel: {height: 280, backgroundColor: '#1a1d27'},
  tabs: {flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingTop: 8},
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2a2d3a',
  },
  tabActive: {backgroundColor: '#6c63ff', borderColor: '#6c63ff'},
  tabText: {color: '#fff', fontSize: 12},
  grid: {padding: 8},
  cell: {
    flex: 1 / 4,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  cellPressed: {backgroundColor: 'rgba(255,255,255,0.08)'},
  hint: {color: '#9b93b8', textAlign: 'center', marginTop: 24},
  credit: {
    color: '#6f678c',
    fontSize: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#2a2d3a',
  },
});
