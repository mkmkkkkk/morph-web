/**
 * App settings via AsyncStorage with in-memory cache.
 *
 * Non-sensitive app preferences (server URL, theme, etc.).
 * Sensitive data (tokens, keys) goes in credentials.ts (SecureStore).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'morph-settings';

export interface AppSettings {
  serverUrl: string;
  theme: 'light' | 'dark' | 'system';
  lastMachineId: string | null;
  lastSessionId: string | null;
  keepAliveEnabled: boolean;
  autoReconnect: boolean;
  proxyUrl: string | null;
}

const DEFAULTS: AppSettings = {
  serverUrl: 'https://api.cluster-fluster.com',
  theme: 'system',
  lastMachineId: null,
  lastSessionId: null,
  keepAliveEnabled: true,
  autoReconnect: true,
  proxyUrl: null,
};

// In-memory cache — loaded once at startup, then synchronous reads
let cache: AppSettings = { ...DEFAULTS };
let loaded = false;

/** Load settings from disk into cache. Call once at app startup. */
export async function loadSettings(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      cache = { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch {
    cache = { ...DEFAULTS };
  }
  loaded = true;
}

/** Persist current cache to disk */
async function persist(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return cache[key];
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  cache[key] = value;
  persist();
}

export function getServerUrl(): string {
  return cache.serverUrl;
}

export function setServerUrl(url: string): void {
  setSetting('serverUrl', url);
}

export function getAllSettings(): AppSettings {
  return { ...cache };
}

export async function resetSettings(): Promise<void> {
  cache = { ...DEFAULTS };
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export const Settings = {
  getServerUrl: (): string => cache.serverUrl,
  setServerUrl: (url: string): void => setSetting('serverUrl', url),
  getAutoReconnect: (): boolean => cache.autoReconnect,
  setAutoReconnect: (value: boolean): void => setSetting('autoReconnect', value),
  getProxyUrl: (): string | null => cache.proxyUrl,
  setProxyUrl: (url: string | null): void => setSetting('proxyUrl', url),
};
