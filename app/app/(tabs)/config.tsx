import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';

// Safe-load heavy modules
let InputBar: any = null;
let deleteCredentials: any = null;
let useConnection: any = null;
let settingsLib: any = null;
let ComponentStore: any = null;
let _configLoadError: string | null = null;

try { InputBar = require('../../components/InputBar').default; } catch (e: any) {
  _configLoadError = (_configLoadError || '') + '\nInputBar: ' + e?.message;
}
try { deleteCredentials = require('../../lib/credentials').deleteCredentials; } catch (e: any) {
  _configLoadError = (_configLoadError || '') + '\ncredentials: ' + e?.message;
}
try { useConnection = require('../../lib/ConnectionContext').useConnection; } catch (e: any) {
  _configLoadError = (_configLoadError || '') + '\nConnectionContext: ' + e?.message;
}
try { settingsLib = require('../../lib/settings'); } catch (e: any) {
  _configLoadError = (_configLoadError || '') + '\nsettings: ' + e?.message;
}
try { ComponentStore = require('../../lib/store').ComponentStore; } catch (e: any) {
  _configLoadError = (_configLoadError || '') + '\nstore: ' + e?.message;
}

// ===== Quick Actions — programmable one-tap prompts =====
interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  { id: 'snapshot', label: 'Save Canvas', prompt: '[System] Save a snapshot of the current canvas state.' },
  { id: 'status', label: 'Status Check', prompt: '[System] Report: connection status, canvas component count, storage usage.' },
  { id: 'clear', label: 'Clear Canvas', prompt: '[System] Remove all draft components from the canvas.' },
  { id: 'dashboard', label: 'Build Dashboard', prompt: 'Build me a dashboard component with: connection status, component count, last snapshot time, and storage usage.' },
];

// Interval presets for scheduled tasks
const INTERVAL_OPTIONS = [
  { label: '5 min', ms: 5 * 60 * 1000 },
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '30 min', ms: 30 * 60 * 1000 },
  { label: '1 hr', ms: 60 * 60 * 1000 },
  { label: '6 hr', ms: 6 * 60 * 60 * 1000 },
  { label: '24 hr', ms: 24 * 60 * 60 * 1000 },
];

// Fallback hook when ConnectionContext fails
function useNoopConnection() {
  return {
    connectionState: 'error' as const,
    connected: false,
    credentials: null,
    lastError: 'ConnectionContext not loaded',
    sendMessage: () => {},
    sendInterrupt: () => {},
    connect: async () => {},
    disconnect: () => {},
  };
}

// Stable hook reference for Rules of Hooks compliance
const _useConnection = useConnection || useNoopConnection;

// If critical modules failed, export a simple error screen (avoids hooks issues)
function ConfigErrorScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: '#000', padding: 20, paddingTop: 60 }}>
      <Text selectable style={{ color: '#ff4444', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>
        Config module error
      </Text>
      <ScrollView>
        <Text selectable style={{ color: '#aaa', fontSize: 13, fontFamily: 'Menlo' }}>
          {_configLoadError}
        </Text>
      </ScrollView>
    </View>
  );
}

function ConfigScreenImpl() {
  const router = useRouter();
  const isDark = true;
  const storeRef = useRef(ComponentStore ? new ComponentStore() : null);

  const {
    connectionState,
    connected,
    credentials,
    lastError,
    sendMessage,
    sendInterrupt,
    connect: reconnect,
    disconnect,
  } = _useConnection();

  const getSetting = settingsLib?.getSetting || (() => 'https://api.cluster-fluster.com');
  const setSetting_ = settingsLib?.setSetting || (() => {});

  const [serverUrl, setServerUrl] = useState(getSetting('serverUrl'));
  const [editingServer, setEditingServer] = useState(false);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [library, setLibrary] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const colors = {
    bg: isDark ? '#000' : '#f2f2f7',
    card: isDark ? '#1c1c1e' : '#fff',
    text: isDark ? '#fff' : '#000',
    secondary: isDark ? '#8e8e93' : '#6e6e73',
    border: isDark ? '#38383a' : '#c6c6c8',
    accent: '#6e6e73',
    danger: '#8b3a3a',
    green: '#4a6a4a',
    purple: '#5a5a6e',
    orange: '#8a7a4a',
  };

  const loadState = useCallback(async () => {
    if (!storeRef.current) return;
    await storeRef.current.init();
    setSnapshots(await storeRef.current.listSnapshots());
    setLibrary(await storeRef.current.listLibrary());
    if (settingsLib?.loadScheduledTasks) {
      setTasks(await settingsLib.loadScheduledTasks());
    }
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  // Task Scheduler
  useEffect(() => {
    if (!settingsLib?.loadScheduledTasks) return;
    const interval = setInterval(async () => {
      const currentTasks = await settingsLib.loadScheduledTasks();
      const now = Date.now();
      let updated = false;

      for (const task of currentTasks) {
        if (!task.enabled) continue;
        const lastRun = task.lastRun || 0;
        if (now - lastRun >= task.intervalMs) {
          console.log(`[Scheduler] Firing task: ${task.name}`);
          task.lastRun = now;
          updated = true;
        }
      }

      if (updated) {
        await settingsLib.saveScheduledTasks(currentTasks);
        setTasks([...currentTasks]);
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  // --- Handlers ---
  const handleUnpair = () => {
    Alert.alert('Unpair Device', 'Remove all credentials? You\'ll need to scan a new QR code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpair', style: 'destructive',
        onPress: async () => {
          disconnect();
          if (deleteCredentials) await deleteCredentials();
        },
      },
    ]);
  };

  const handleSaveServer = () => {
    const trimmed = serverUrl.trim();
    if (!trimmed.startsWith('http')) {
      Alert.alert('Invalid URL', 'Must start with http:// or https://');
      return;
    }
    setSetting_('serverUrl', trimmed);
    setEditingServer(false);
  };

  const handleQuickAction = (action: QuickAction) => {
    Alert.alert(action.label, `Prompt: "${action.prompt}"`, [{ text: 'OK' }]);
  };

  const handleRestoreSnapshot = (snap: any) => {
    Alert.alert('Restore Canvas', `Restore "${snap.name}"? Current canvas will be replaced.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        onPress: async () => {
          const ok = await storeRef.current?.restoreSnapshot(snap.id);
          if (ok) Alert.alert('Restored', 'Switch to Canvas tab to see the result.');
          else Alert.alert('Error', 'Failed to restore snapshot.');
        },
      },
    ]);
  };

  const handleUseLibraryComponent = async (entry: any) => {
    const componentId = await storeRef.current?.useFromLibrary(entry.id);
    if (componentId) {
      Alert.alert('Added', `"${entry.name}" added to canvas as ${componentId}.`);
    }
  };

  const handleExportComponent = async (entry: any) => {
    const json = await storeRef.current?.exportLibraryComponent(entry.id);
    if (json) {
      Alert.alert('Export', `Share this JSON to import on another device:\n\n${json.substring(0, 200)}...`);
    }
  };

  const handleAddTask = async () => {
    if (!settingsLib?.addScheduledTask) return;
    const existingCount = tasks.length;
    const templates = [
      { name: 'Auto-Save Canvas', prompt: '[System] Save a snapshot of the current canvas state.', intervalMs: 30 * 60 * 1000 },
      { name: 'Health Check', prompt: '[System] Report: connection status, component count, storage usage, last error.', intervalMs: 60 * 60 * 1000 },
      { name: 'Daily Summary', prompt: '[System] Generate a daily summary: what changed on the canvas today, key metrics, and suggestions.', intervalMs: 24 * 60 * 60 * 1000 },
    ];
    const template = templates[existingCount % templates.length];
    const task = await settingsLib.addScheduledTask({ ...template, enabled: false });
    setTasks(prev => [...prev, task]);
    Alert.alert('Task Added', `"${template.name}" added (disabled).`);
  };

  const handleToggleTask = async (task: any) => {
    if (!settingsLib?.updateScheduledTask) return;
    await settingsLib.updateScheduledTask(task.id, { enabled: !task.enabled });
    setTasks(prev => prev.map((t: any) => t.id === task.id ? { ...t, enabled: !t.enabled } : t));
  };

  const handleDeleteTask = (task: any) => {
    Alert.alert('Delete Task', `Remove "${task.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          if (settingsLib?.removeScheduledTask) await settingsLib.removeScheduledTask(task.id);
          setTasks(prev => prev.filter((t: any) => t.id !== task.id));
        },
      },
    ]);
  };

  const handleChangeInterval = (task: any) => {
    const buttons = INTERVAL_OPTIONS.map(opt => ({
      text: opt.label + (task.intervalMs === opt.ms ? ' ✓' : ''),
      onPress: async () => {
        if (settingsLib?.updateScheduledTask) await settingsLib.updateScheduledTask(task.id, { intervalMs: opt.ms });
        setTasks(prev => prev.map((t: any) => t.id === task.id ? { ...t, intervalMs: opt.ms } : t));
      },
    }));
    buttons.push({ text: 'Cancel', onPress: async () => {} });
    Alert.alert('Set Interval', `Current: ${formatInterval(task.intervalMs)}`, buttons);
  };

  const formatInterval = (ms: number) => {
    if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)}m`;
    if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h`;
    return `${Math.round(ms / 86400000)}d`;
  };

  const handleChatSend = useCallback((text: string) => {
    if (!connected) return;
    setIsProcessing(true);
    sendMessage(text);
    setTimeout(() => setIsProcessing(false), 30_000);
  }, [connected, sendMessage]);

  const handleChatStop = useCallback(() => {
    sendInterrupt();
    setIsProcessing(false);
  }, [sendInterrupt]);

  const displayStatus = !credentials ? 'unpaired' : connectionState;
  const statusColorMap: Record<string, string> = {
    unpaired: '#888',
    disconnected: '#ff4444',
    connecting: '#ffaa00',
    connected: '#44cc44',
    error: '#ff4444',
  };

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const menuItems = [
    { key: 'actions', label: 'Quick Actions', detail: `${DEFAULT_ACTIONS.length} actions` },
    { key: 'tasks', label: 'Scheduled Tasks', detail: `${tasks.filter((t: any) => t.enabled).length}/${tasks.length} active` },
    { key: 'history', label: 'Canvas History', detail: `${snapshots.length} saved` },
    { key: 'library', label: 'Component Library', detail: `${library.length} components` },
    { key: 'connection', label: 'Connection', detail: displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1) },
    { key: 'server', label: 'Server', detail: serverUrl.replace('https://', '').replace('http://', '') },
    { key: 'about', label: 'About', detail: 'v1.0' },
  ];

  return (
    <View style={[styles.outerContainer, { backgroundColor: colors.bg }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.menuCard}>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {menuItems.map((item, i) => (
              <View key={item.key}>
                {i > 0 && <View style={[styles.separator, { backgroundColor: colors.border }]} />}

                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggle(item.key)}
                  activeOpacity={0.6}
                >
                  <Text selectable style={[styles.label, { color: colors.text, flex: 1 }]}>{item.label}</Text>
                  <Text selectable style={[styles.detail, { color: colors.secondary }]}>{item.detail}</Text>
                  <Text style={[styles.chevron, { color: colors.secondary, transform: [{ rotate: expanded[item.key] ? '90deg' : '0deg' }] }]}>{'>'}</Text>
                </TouchableOpacity>

                {expanded[item.key] && item.key === 'actions' && (
                  <View style={styles.expandedContent}>
                    {DEFAULT_ACTIONS.map((action) => (
                      <TouchableOpacity
                        key={action.id}
                        style={styles.subRow}
                        onPress={() => handleQuickAction(action)}
                        activeOpacity={0.7}
                      >
                        <Text selectable style={[styles.label, { color: colors.text }]}>{action.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {expanded[item.key] && item.key === 'tasks' && (
                  <View style={styles.expandedContent}>
                    {tasks.length === 0 ? (
                      <Text selectable style={[styles.emptyText, { color: colors.secondary }]}>No scheduled tasks</Text>
                    ) : (
                      tasks.map((task: any) => (
                        <TouchableOpacity
                          key={task.id}
                          style={styles.subRow}
                          onPress={() => handleChangeInterval(task)}
                          onLongPress={() => handleDeleteTask(task)}
                          activeOpacity={0.7}
                        >
                          <View style={{ flex: 1, opacity: task.enabled ? 1 : 0.4 }}>
                            <Text selectable style={[styles.label, { color: colors.text }]}>{task.name}</Text>
                            <Text selectable style={[styles.meta, { color: colors.secondary }]}>
                              Every {formatInterval(task.intervalMs)}
                              {task.lastRun ? ` · ${timeAgo(task.lastRun)}` : ''}
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={[styles.toggleBtn, { backgroundColor: task.enabled ? colors.green : colors.border }]}
                            onPress={() => handleToggleTask(task)}
                            activeOpacity={0.6}
                          >
                            <View style={[styles.toggleKnob, { alignSelf: task.enabled ? 'flex-end' : 'flex-start' }]} />
                          </TouchableOpacity>
                        </TouchableOpacity>
                      ))
                    )}
                    <TouchableOpacity style={styles.subRow} onPress={handleAddTask} activeOpacity={0.6}>
                      <Text selectable style={{ color: colors.purple, fontSize: 15, fontWeight: '600' }}>+ Add Task</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {expanded[item.key] && item.key === 'history' && (
                  <View style={styles.expandedContent}>
                    {snapshots.length === 0 ? (
                      <Text selectable style={[styles.emptyText, { color: colors.secondary }]}>No saved canvases yet</Text>
                    ) : (
                      snapshots.map((snap: any) => (
                        <TouchableOpacity key={snap.id} style={styles.subRow} onPress={() => handleRestoreSnapshot(snap)}>
                          <View style={{ flex: 1 }}>
                            <Text selectable style={[styles.label, { color: colors.text }]}>{snap.name}</Text>
                            <Text selectable style={[styles.meta, { color: colors.secondary }]}>{snap.componentCount} components · {timeAgo(snap.createdAt)}</Text>
                          </View>
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {expanded[item.key] && item.key === 'library' && (
                  <View style={styles.expandedContent}>
                    {library.length === 0 ? (
                      <Text selectable style={[styles.emptyText, { color: colors.secondary }]}>No saved components</Text>
                    ) : (
                      library.map((entry: any) => (
                        <TouchableOpacity
                          key={entry.id}
                          style={styles.subRow}
                          onPress={() => handleUseLibraryComponent(entry)}
                          onLongPress={() => handleExportComponent(entry)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text selectable style={[styles.label, { color: colors.text }]}>{entry.name}</Text>
                            <Text selectable style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>
                              {entry.description || entry.tags?.join(', ') || 'No description'}
                            </Text>
                          </View>
                          <Text selectable style={{ color: colors.green, fontSize: 18 }}>+</Text>
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {expanded[item.key] && item.key === 'connection' && (
                  <View style={styles.expandedContent}>
                    <View style={styles.subRow}>
                      <Text selectable style={[styles.label, { color: colors.text }]}>Encryption</Text>
                      <Text selectable style={[styles.detail, { color: colors.secondary }]}>
                        {credentials?.encryption.type === 'legacy' ? 'TweetNaCl' :
                         credentials?.encryption.type === 'dataKey' ? 'AES-256-GCM' : 'N/A'}
                      </Text>
                    </View>
                    {lastError && (
                      <View style={[styles.subRow, { flexDirection: 'column', alignItems: 'flex-start' }]}>
                        <Text selectable style={[styles.label, { color: colors.danger }]}>Error</Text>
                        <Text selectable style={[styles.meta, { color: colors.danger }]} numberOfLines={3}>{lastError}</Text>
                      </View>
                    )}
                    {credentials && connectionState !== 'connected' && (
                      <TouchableOpacity style={styles.subRow} onPress={() => reconnect().catch(() => {})}>
                        <Text selectable style={[styles.label, { color: colors.accent }]}>Reconnect</Text>
                      </TouchableOpacity>
                    )}
                    {credentials ? (
                      <TouchableOpacity style={styles.subRow} onPress={handleUnpair}>
                        <Text selectable style={[styles.label, { color: colors.danger }]}>Unpair Device</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity style={styles.subRow} onPress={() => router.push('/connect')}>
                        <Text selectable style={[styles.label, { color: colors.accent }]}>Connect to Claude Code</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {expanded[item.key] && item.key === 'server' && (
                  <View style={styles.expandedContent}>
                    {editingServer ? (
                      <View style={{ padding: 12 }}>
                        <TextInput
                          style={[styles.serverInput, { color: colors.text, borderColor: colors.border }]}
                          value={serverUrl}
                          onChangeText={setServerUrl}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          placeholder="https://api.cluster-fluster.com"
                          placeholderTextColor={colors.secondary}
                        />
                        <View style={styles.editButtons}>
                          <TouchableOpacity onPress={() => { setEditingServer(false); setServerUrl(getSetting('serverUrl')); }}>
                            <Text selectable style={{ color: colors.secondary, fontSize: 16 }}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={handleSaveServer}>
                            <Text selectable style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>Save</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity style={styles.subRow} onPress={() => setEditingServer(true)}>
                        <Text selectable style={[styles.label, { color: colors.accent }]}>Edit Server URL</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {expanded[item.key] && item.key === 'about' && (
                  <View style={styles.expandedContent}>
                    <View style={styles.subRow}>
                      <Text selectable style={[styles.label, { color: colors.text }]}>Build</Text>
                      <Text selectable style={[styles.detail, { color: colors.secondary }]}>Expo SDK 54</Text>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {InputBar && (
        <InputBar
          onSend={handleChatSend}
          onStop={handleChatStop}
          connected={connected}
          isProcessing={isProcessing}
          forceDark
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { paddingBottom: 20 },

  menuCard: { marginTop: 20, paddingHorizontal: 16 },
  card: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 16, minHeight: 48,
  },
  label: { fontSize: 16 },
  detail: { fontSize: 14, marginRight: 8 },
  meta: { fontSize: 13, marginTop: 2 },
  chevron: { fontSize: 16, fontWeight: '300' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },

  expandedContent: { paddingLeft: 16, paddingBottom: 4 },
  subRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, paddingHorizontal: 16, minHeight: 40,
  },
  emptyText: { paddingHorizontal: 16, paddingVertical: 10, fontSize: 14 },

  toggleBtn: {
    width: 44, height: 26, borderRadius: 13, padding: 2,
    justifyContent: 'center',
  },
  toggleKnob: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
  },

  serverInput: {
    fontSize: 16, borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12,
  },
  editButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20 },
});

// Export error screen if critical modules failed, otherwise the real screen
export default (_configLoadError && !useConnection) ? ConfigErrorScreen : ConfigScreenImpl;
