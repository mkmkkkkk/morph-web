import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { loadSettings } from '../lib/settings';

export default function RootLayout() {
  const isDark = useColorScheme() !== 'light';

  useEffect(() => {
    loadSettings();
  }, []);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: isDark ? '#000' : '#f8f8f8' },
          headerTintColor: isDark ? '#fff' : '#000',
          headerShadowVisible: false,
          contentStyle: { backgroundColor: isDark ? '#000' : '#f2f2f7' },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="connect"
          options={{
            presentation: 'modal',
            title: 'Connect',
            headerStyle: { backgroundColor: isDark ? '#1c1c1e' : '#fff' },
          }}
        />
      </Stack>
    </>
  );
}
