import React, { useState, useRef } from 'react';
import {
  View, TextInput, TouchableOpacity, Text, StyleSheet,
  KeyboardAvoidingView, Platform, useColorScheme, ActionSheetIOS, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/build/legacy';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  onSketch?: () => void;
  onImage?: (base64DataUrl: string) => void;
  onFile?: (file: { name: string; mime: string; base64: string; size: number }) => void;
  connected: boolean;
  isProcessing?: boolean;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit for happy-wire

export default function InputBar({ onSend, onStop, onSketch, onImage, onFile, connected, isProcessing }: InputBarProps) {
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

  const pickFile = async () => {
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
    if (Platform.OS === 'ios') {
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
                style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
                onPress={handleSend}
                disabled={!text.trim()}
                activeOpacity={0.7}
              >
                <Text style={[styles.sendText, !text.trim() && styles.sendTextDisabled]}>{'↑'}</Text>
              </TouchableOpacity>
            )}
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
