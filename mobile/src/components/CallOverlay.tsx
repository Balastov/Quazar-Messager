import React, {useMemo} from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {RTCView} from 'react-native-webrtc';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useCallStore} from '../store/call';

function statusLabel(
  phase: string,
  error: string | null,
  endReason: string | null,
  isVideo: boolean,
) {
  if (error) {
    return error;
  }
  switch (phase) {
    case 'outgoing':
      return isVideo ? 'Видеовызов…' : 'Вызов…';
    case 'incoming':
      return isVideo ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'connecting':
      return 'Соединение…';
    case 'active':
      return isVideo ? 'Видеосвязь' : 'Разговор';
    case 'ended':
      if (endReason === 'busy') {
        return 'Занято';
      }
      if (endReason === 'unavailable') {
        return 'Недоступен';
      }
      if (endReason === 'reject') {
        return 'Отклонён';
      }
      if (endReason === 'failed') {
        return 'Сбой соединения';
      }
      if (endReason === 'timeout') {
        return 'Нет ответа';
      }
      return 'Звонок завершён';
    default:
      return '';
  }
}

export default function CallOverlay() {
  const phase = useCallStore(st => st.phase);
  const peerUsername = useCallStore(st => st.peerUsername);
  const media = useCallStore(st => st.media);
  const muted = useCallStore(st => st.muted);
  const cameraOff = useCallStore(st => st.cameraOff);
  const remoteStream = useCallStore(st => st.remoteStream);
  const localStream = useCallStore(st => st.localStream);
  const error = useCallStore(st => st.error);
  const endReason = useCallStore(st => st.endReason);
  const accept = useCallStore(st => st.accept);
  const reject = useCallStore(st => st.reject);
  const hangup = useCallStore(st => st.hangup);
  const toggleMute = useCallStore(st => st.toggleMute);
  const toggleCamera = useCallStore(st => st.toggleCamera);
  const flipCamera = useCallStore(st => st.flipCamera);
  const clearEnded = useCallStore(st => st.clearEnded);
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();

  const isVideo = media.video === true;
  const visible = phase !== 'idle';
  const name = peerUsername || 'Собеседник';
  const inCall =
    phase === 'outgoing' || phase === 'connecting' || phase === 'active';

  const remoteUrl = useMemo(() => {
    try {
      return remoteStream?.toURL?.() ?? null;
    } catch {
      return null;
    }
  }, [remoteStream]);

  const localUrl = useMemo(() => {
    try {
      return localStream && !cameraOff ? localStream.toURL?.() ?? null : null;
    } catch {
      return null;
    }
  }, [localStream, cameraOff]);

  if (!visible) {
    return null;
  }

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen">
      <View style={[s.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
        {isVideo && remoteUrl ? (
          <RTCView streamURL={remoteUrl} style={s.remote} objectFit="cover" />
        ) : (
          <View style={s.placeholder}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{name[0]?.toUpperCase() ?? '?'}</Text>
            </View>
            <Text style={s.name}>{name}</Text>
            <Text style={s.status}>
              {statusLabel(phase, error, endReason, isVideo)}
            </Text>
          </View>
        )}

        {isVideo && localUrl ? (
          <RTCView
            streamURL={localUrl}
            style={[s.pip, {width: Math.min(120, width * 0.28)}]}
            objectFit="cover"
            mirror
          />
        ) : null}

        {isVideo && remoteUrl ? (
          <View style={s.chrome}>
            <Text style={s.name}>{name}</Text>
            <Text style={s.status}>
              {statusLabel(phase, error, endReason, isVideo)}
            </Text>
          </View>
        ) : null}

        <View style={s.actions}>
          {phase === 'incoming' && (
            <>
              <Pressable style={s.reject} onPress={reject}>
                <Text style={s.btnText}>✕</Text>
              </Pressable>
              <Pressable style={s.accept} onPress={() => void accept()}>
                <Text style={s.btnText}>✓</Text>
              </Pressable>
            </>
          )}

          {inCall && (
            <>
              <Pressable
                style={[s.chip, muted && s.chipOn]}
                onPress={toggleMute}>
                <Text style={s.chipText}>{muted ? 'Mic off' : 'Mic'}</Text>
              </Pressable>
              {isVideo && (
                <>
                  <Pressable
                    style={[s.chip, cameraOff && s.chipOn]}
                    onPress={toggleCamera}>
                    <Text style={s.chipText}>
                      {cameraOff ? 'Cam off' : 'Cam'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={s.chip}
                    onPress={() => void flipCamera()}
                    disabled={cameraOff}>
                    <Text style={s.chipText}>Flip</Text>
                  </Pressable>
                </>
              )}
              <Pressable style={s.reject} onPress={hangup}>
                <Text style={s.btnText}>✕</Text>
              </Pressable>
            </>
          )}

          {phase === 'ended' && (
            <Pressable style={s.dismiss} onPress={clearEnded}>
              <Text style={s.chipText}>Закрыть</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#07060f',
    justifyContent: 'flex-end',
  },
  remote: {
    ...StyleSheet.absoluteFillObject,
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#0a0814',
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {color: '#fff', fontSize: 36, fontWeight: '700'},
  name: {
    color: '#f4f1ff',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  status: {
    color: '#9b93b8',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
  pip: {
    position: 'absolute',
    top: 56,
    right: 16,
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(168,140,255,0.45)',
    backgroundColor: '#000',
  },
  chrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 110,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingBottom: 24,
    flexWrap: 'wrap',
  },
  accept: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#059669',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reject: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {color: '#fff', fontSize: 22, fontWeight: '700'},
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(168,140,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: {
    backgroundColor: 'rgba(248,113,113,0.18)',
    borderColor: 'rgba(248,113,113,0.45)',
  },
  chipText: {color: '#fff', fontSize: 13, fontWeight: '600'},
  dismiss: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: 'rgba(168,85,247,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(168,140,255,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
