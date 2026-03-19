import React, { useState, useRef, useEffect } from 'react';
import {
  View, TextInput, TouchableOpacity, Text, StyleSheet,
  Platform, useColorScheme, ActionSheetIOS, Alert, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/src/legacy/FileSystem';
import { EncodingType } from 'expo-file-system/src/legacy/FileSystem.types';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  onSketch?: () => void;
  onImage?: (base64DataUrl: string) => void;
  onFile?: (file: { name: string; mime: string; base64: string; size: number }) => void;
  connected: boolean;
  connectionState?: 'disconnected' | 'connecting' | 'connected' | 'error';
  isProcessing?: boolean;
  forceDark?: boolean;
  onToggleTerminal?: () => void;
  terminalVisible?: boolean;
  hasNewTerminal?: boolean;
  pendingSketch?: { strokeCount: number } | null;
  onClearSketch?: () => void;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit for happy-wire

__DEV__ && console.log('[InputBar] module loaded');

export default function InputBar({ onSend, onStop, onSketch, onImage, onFile, connected, connectionState, isProcessing, forceDark, onToggleTerminal, terminalVisible, hasNewTerminal, pendingSketch, onClearSketch }: InputBarProps) {
  __DEV__ && console.log('[InputBar] render: connected=', connected, 'connectionState=', connectionState, 'isProcessing=', isProcessing);
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const router = useRouter();
  const isDark = forceDark || useColorScheme() !== 'light';

  // Dot color based on connectionState
  const isConnecting = connectionState === 'connecting';
  const dotColor = connectionState === 'connected' ? '#30d158'
    : connectionState === 'connecting' ? '#ffcc00'
    : connectionState === 'error' ? '#ff4444'
    : '#636366'; // disconnected / undefined

  // Pulse animation for connecting state
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isConnecting) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isConnecting]);

  // Pulse animation for terminal toggle when processing
  const termPulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isProcessing) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(termPulseAnim, { toValue: 0.2, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(termPulseAnim, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      termPulseAnim.setValue(1);
    }
  }, [isProcessing]);

  const canSend = text.trim().length > 0 || !!pendingSketch;

  const handleSend = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    __DEV__ && console.log('[InputBar] handleSend: text=', JSON.stringify(trimmed).slice(0, 100), 'hasSketch=', !!pendingSketch);
    try {
      onSend(trimmed);
      __DEV__ && console.log('[InputBar] onSend callback returned OK');
    } catch (err: any) {
      __DEV__ && console.error('[InputBar] onSend THREW:', err?.message, err?.stack);
      Alert.alert('InputBar Error', String(err?.message || err));
    }
    setText('');
  };

  const pickImage = async (useCamera: boolean) => {
    __DEV__ && console.log('[InputBar] pickImage: useCamera=', useCamera);
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      base64: true,
      quality: 0.7,
      allowsEditing: true,
    };

    const result = useCamera
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);

    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      const mime = asset.mimeType || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${asset.base64}`;
      onImage?.(dataUrl);
    }
  };

  const pickFile = async () => {
    __DEV__ && console.log('[InputBar] pickFile tapped');
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    if (asset.size && asset.size > MAX_FILE_SIZE) {
      Alert.alert('File too large', `Max ${MAX_FILE_SIZE / 1024 / 1024}MB. This file is ${(asset.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }

    const base64 = await readAsStringAsync(asset.uri, {
      encoding: EncodingType.Base64,
    });

    onFile?.({
      name: asset.name,
      mime: asset.mimeType || 'application/octet-stream',
      base64,
      size: asset.size || 0,
    });
  };

  const handleAttach = () => {
    __DEV__ && console.log('[InputBar] handleAttach tapped');
    if (Platform.OS === 'web') {
      // Web: use native file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,.pdf,.txt,.md,.json,.csv';
      input.onchange = async (e: any) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          if (file.type.startsWith('image/')) {
            onImage?.(`data:${file.type};base64,${base64}`);
          } else {
            onFile?.({ name: file.name, mime: file.type, base64, size: file.size });
          }
        };
        reader.readAsDataURL(file);
      };
      input.click();
    } else if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Take Photo', 'Photo Library', 'File', 'Sketch'],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) pickImage(true);
          else if (idx === 2) pickImage(false);
          else if (idx === 3) pickFile();
          else if (idx === 4) onSketch?.();
        },
      );
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Take Photo', onPress: () => pickImage(true) },
        { text: 'Photo Library', onPress: () => pickImage(false) },
        { text: 'File', onPress: pickFile },
        { text: 'Sketch', onPress: onSketch },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  return (
    <View style={isDark ? styles.containerDark : styles.containerLight}>
      {/* Pending sketch chip */}
      {pendingSketch && (
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>
              Sketch{pendingSketch.strokeCount > 0 ? ` · ${pendingSketch.strokeCount} stroke${pendingSketch.strokeCount !== 1 ? 's' : ''}` : ''}
            </Text>
            <TouchableOpacity onPress={onClearSketch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.chipClose}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      <View style={styles.inputRow}>
      <Animated.View style={[styles.dotWrap, { opacity: pulseAnim }]}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      </Animated.View>
        <TouchableOpacity
          style={styles.attachBtn}
          onPress={handleAttach}
          activeOpacity={0.6}
        >
          <Text style={styles.attachIcon}>+</Text>
        </TouchableOpacity>
        {onToggleTerminal && (
          <TouchableOpacity
            style={styles.termToggle}
            onPress={onToggleTerminal}
            activeOpacity={0.6}
          >
            {isProcessing ? (
              <Animated.Text style={[styles.termToggleIcon, hasNewTerminal && styles.termToggleNew, { opacity: termPulseAnim }]}>
                {'›'}
              </Animated.Text>
            ) : (
              <Text style={[styles.termToggleIcon, hasNewTerminal && styles.termToggleNew]}>
                {terminalVisible ? '⌄' : '›'}
              </Text>
            )}
          </TouchableOpacity>
        )}
        {Platform.OS === 'web' ? (
          <textarea
            ref={inputRef as any}
            style={{
              flex: 1,
              minHeight: 34,
              maxHeight: 120,
              borderRadius: 20,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: 7,
              paddingBottom: 7,
              fontSize: 16,
              lineHeight: '20px',
              resize: 'none',
              border: 'none',
              outline: 'none',
              fontFamily: '-apple-system, system-ui, sans-serif',
              backgroundColor: isDark ? '#1c1c1e' : '#e8e8e8',
              color: isDark ? '#fff' : '#000',
              WebkitAppearance: 'none',
              ...(text ? {} : {}),
            } as any}
            value={text}
            onChange={(e: any) => setText(e.target.value)}
            placeholder="Message Claude Code..."
            rows={1}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onInput={(e: any) => {
              // Auto-resize textarea
              e.target.style.height = '34px';
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
            }}
          />
        ) : (
          <TextInput
            ref={inputRef}
            style={[styles.input, isDark ? styles.inputDark : styles.inputLight]}
            value={text}
            onChangeText={setText}
            placeholder="Message Claude Code..."
            placeholderTextColor={isDark ? '#555' : '#999'}
            multiline
            maxLength={10000}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
        )}
        {isProcessing ? (
          <TouchableOpacity
            style={styles.stopBtn}
            onPress={onStop}
            activeOpacity={0.7}
          >
            <View style={styles.stopSquare} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.7}
          >
            <Text style={[styles.sendText, !canSend && styles.sendTextDisabled]}>{'↑'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  containerDark: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  containerLight: {
    backgroundColor: '#f8f8f8',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipRow: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 8,
  },
  chipText: {
    color: '#aaa',
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  chipClose: {
    color: '#666',
    fontSize: 12,
  },
  dotWrap: {
    width: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  attachBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  attachIcon: {
    color: '#666',
    fontSize: 22,
    fontWeight: '400',
    lineHeight: 22,
    textAlign: 'center',
  },
  input: {
    flex: 1,
    minHeight: 34,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 7, // 7+~20(lineHeight)+7=34px, matches 34px buttons
    fontSize: 16,
    maxHeight: 120,
  },
  inputDark: {
    backgroundColor: '#1c1c1e',
    color: '#fff',
  },
  inputLight: {
    backgroundColor: '#e8e8e8',
    color: '#000',
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  sendBtnDisabled: { backgroundColor: '#1c1c1e' },
  sendText: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: -1 },
  sendTextDisabled: { color: '#444' },
  stopBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#ff3b30',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  termToggle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  termToggleIcon: {
    color: '#555',
    fontSize: 14,
    fontWeight: '600',
  },
  termToggleNew: {
    color: '#30d158',
  },
  connectBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  connectText: {
    flex: 1,
    color: '#636366',
    fontSize: 16,
  },
  connectChevron: {
    color: '#636366',
    fontSize: 16,
    fontWeight: '300',
  },
});
