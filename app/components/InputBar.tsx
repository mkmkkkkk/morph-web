import React, { useState, useRef } from 'react';
import {
  View, TextInput, TouchableOpacity, Text, StyleSheet,
  KeyboardAvoidingView, Platform, useColorScheme, ActionSheetIOS, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

interface InputBarProps {
  onSend: (text: string) => void;
  onSketch?: () => void;
  onImage?: (base64DataUrl: string) => void;
  connected: boolean;
}

export default function InputBar({ onSend, onSketch, onImage, connected }: InputBarProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const router = useRouter();
  const isDark = useColorScheme() !== 'light';

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const pickImage = async (useCamera: boolean) => {
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

  const handleAttach = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Take Photo', 'Choose from Library', 'Sketch'],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) pickImage(true);
          else if (idx === 2) pickImage(false);
          else if (idx === 3) onSketch?.();
        },
      );
    } else {
      // Android: show simple alert as action sheet
      Alert.alert('Attach', undefined, [
        { text: 'Take Photo', onPress: () => pickImage(true) },
        { text: 'Choose from Library', onPress: () => pickImage(false) },
        { text: 'Sketch', onPress: onSketch },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={[styles.container, isDark ? styles.containerDark : styles.containerLight]}>
        {connected ? (
          <>
            <View style={[styles.dot, styles.dotConnected]} />
            <TouchableOpacity
              style={styles.attachBtn}
              onPress={handleAttach}
              activeOpacity={0.6}
            >
              <Text style={styles.attachIcon}>+</Text>
            </TouchableOpacity>
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
            <TouchableOpacity
              style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!text.trim()}
              activeOpacity={0.7}
            >
              <Text style={[styles.sendText, !text.trim() && styles.sendTextDisabled]}>{'↑'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.connectBar}
            onPress={() => router.push('/connect')}
            activeOpacity={0.7}
          >
            <View style={[styles.dot, styles.dotDisconnected]} />
            <Text style={styles.connectText}>Connect to Claude Code</Text>
            <Text style={styles.connectChevron}>{'>'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  containerDark: {
    backgroundColor: '#0a0a0a',
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  containerLight: {
    backgroundColor: '#f8f8f8',
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 6,
    marginBottom: 14,
  },
  dotConnected: { backgroundColor: '#30d158' },
  dotDisconnected: { backgroundColor: '#636366' },
  attachBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(94,92,230,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  attachIcon: {
    color: '#818cf8',
    fontSize: 22,
    fontWeight: '400',
    marginTop: -1,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
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
    backgroundColor: '#30d158',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  sendBtnDisabled: { backgroundColor: '#1c1c1e' },
  sendText: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: -1 },
  sendTextDisabled: { color: '#444' },
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
