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
  bridgeUrl: string;
  theme: 'light' | 'dark' | 'system';
  lastMachineId: string | null;
  lastSessionId: string | null;
  keepAliveEnabled: boolean;
  autoReconnect: boolean;
  proxyUrl: string | null;
  connectionMode: 'happy' | 'direct';
}

const DEFAULTS: AppSettings = {
  serverUrl: 'https://api.cluster-fluster.com',
  bridgeUrl: 'https://morph.mkyang.ai',
  theme: 'system',
  lastMachineId: null,
  lastSessionId: null,
  keepAliveEnabled: true,
  autoReconnect: true,
  proxyUrl: null,
  connectionMode: 'direct',  // v2 direct mode as default
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
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // AsyncStorage native module may not be available — in-memory cache still works
  }
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
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch { /* native module may not be available */ }
}

export const Settings = {
  getServerUrl: (): string => cache.serverUrl,
  setServerUrl: (url: string): void => setSetting('serverUrl', url),
  getAutoReconnect: (): boolean => cache.autoReconnect,
  setAutoReconnect: (value: boolean): void => setSetting('autoReconnect', value),
  getProxyUrl: (): string | null => cache.proxyUrl,
  setProxyUrl: (url: string | null): void => setSetting('proxyUrl', url),
};

// ===== SCHEDULED TASKS =====

const TASKS_STORAGE_KEY = 'morph-scheduled-tasks';

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  lastRun: number | null;
  enabled: boolean;
}

let tasksCache: ScheduledTask[] | null = null;

export async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  if (tasksCache) return tasksCache;
  try {
    const raw = await AsyncStorage.getItem(TASKS_STORAGE_KEY);
    tasksCache = raw ? JSON.parse(raw) : [];
  } catch {
    tasksCache = [];
  }
  return tasksCache!;
}

export async function saveScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  tasksCache = tasks;
  try {
    await AsyncStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
  } catch { /* native module may not be available */ }
}

export async function addScheduledTask(task: Omit<ScheduledTask, 'id' | 'lastRun'>): Promise<ScheduledTask> {
  const tasks = await loadScheduledTasks();
  const newTask: ScheduledTask = {
    ...task,
    id: 'task-' + Date.now(),
    lastRun: null,
  };
  tasks.push(newTask);
  await saveScheduledTasks(tasks);
  return newTask;
}

export async function updateScheduledTask(id: string, updates: Partial<ScheduledTask>): Promise<void> {
  const tasks = await loadScheduledTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx >= 0) {
    tasks[idx] = { ...tasks[idx], ...updates };
    await saveScheduledTasks(tasks);
  }
}

export async function removeScheduledTask(id: string): Promise<void> {
  const tasks = await loadScheduledTasks();
  await saveScheduledTasks(tasks.filter(t => t.id !== id));
}
