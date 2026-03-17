// Polyfill crypto.getRandomValues for React Native (must be before crypto imports)
try { require('react-native-get-random-values'); } catch {}

import React from 'react';
import { View, Text, ScrollView, LogBox, Alert } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

LogBox.ignoreLogs(['Using an insecure random number generator']);

// Catch unhandled promise rejections — show as alert instead of crashing
if (typeof global !== 'undefined') {
  const origHandler = (global as any).HermesInternal?.hasPromise?.()
    ? undefined
    : (global as any).onunhandledrejection;
  (global as any).onunhandledrejection = (e: any) => {
    const reason = e?.reason || e;
    const msg = reason?.message || String(reason);
    console.error('[Morph] Unhandled rejection:', msg);
    Alert.alert('Unhandled Error', msg + '\n' + (reason?.stack || ''));
    if (origHandler) origHandler(e);
  };
}

let ConnectionProvider: React.ComponentType<{ children: React.ReactNode }> | null = null;
let _err: string | null = null;

try {
  ConnectionProvider = require('../lib/ConnectionContext').ConnectionProvider;
} catch (e: any) {
  _err = (_err || '') + '\nConnectionContext: ' + e?.message;
}

try {
  const { loadSettings } = require('../lib/settings');
  loadSettings().catch(() => {});
} catch (e: any) {
  _err = (_err || '') + '\nSettings: ' + e?.message;
}

export default function RootLayout() {
  if (_err && !ConnectionProvider) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0a0a', padding: 20, paddingTop: 60 }}>
        <Text selectable style={{ color: '#ff4444', fontSize: 16, fontWeight: 'bold' }}>Load Error</Text>
        <ScrollView>
          <Text selectable style={{ color: '#aaa', fontSize: 13, fontFamily: 'Menlo', marginTop: 12 }}>{_err}</Text>
        </ScrollView>
      </View>
    );
  }

  const shell = (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: '#000' },
        headerTintColor: '#fff',
        headerShadowVisible: false,
        contentStyle: { backgroundColor: '#000' },
      }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ presentation: 'modal', title: 'Connect', headerStyle: { backgroundColor: '#1c1c1e' } }} />
      </Stack>
    </>
  );

  return ConnectionProvider ? <ConnectionProvider>{shell}</ConnectionProvider> : shell;
}
