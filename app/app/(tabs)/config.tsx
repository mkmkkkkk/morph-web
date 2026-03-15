import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import InputBar from '../../components/InputBar';
import { deleteCredentials } from '../../lib/credentials';
import { useConnection } from '../../lib/ConnectionContext';
import { getSetting, setSetting, loadScheduledTasks, saveScheduledTasks, addScheduledTask, updateScheduledTask, removeScheduledTask, type ScheduledTask } from '../../lib/settings';
import { ComponentStore, type CanvasSnapshot, type LibraryEntry } from '../../lib/store';

// ===== Quick Actions — programmable one-tap prompts =====
interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  icon: string;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  { id: 'snapshot', label: 'Save Canvas', prompt: '[System] Save a snapshot of the current canvas state.', icon: '◆' },
  { id: 'status', label: 'Status Check', prompt: '[System] Report: connection status, canvas component count, storage usage.', icon: '◇' },
  { id: 'clear', label: 'Clear Canvas', prompt: '[System] Remove all draft components from the canvas.', icon: '×' },
  { id: 'dashboard', label: 'Build Dashboard', prompt: 'Build me a dashboard component with: connection status, component count, last snapshot time, and storage usage.', icon: '▦' },
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

export default function ConfigScreen() {
  const router = useRouter();
  const isDark = useColorScheme() !== 'light';
  const storeRef = useRef(new ComponentStore());

  const {
    connectionState,
    connected,
    credentials,
    lastError,
    sendMessage,
    sendInterrupt,
    connect: reconnect,
    disconnect,
  } = useConnection();

  const [serverUrl, setServerUrl] = useState(getSetting('serverUrl'));
  const [editingServer, setEditingServer] = useState(false);

  // Canvas History
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[]>([]);
  // Component Library
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  // Scheduled Tasks
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // Processing state for system chat bar
  const [isProcessing, setIsProcessing] = useState(false);

  const colors = {
    bg: isDark ? '#000' : '#f2f2f7',
    card: isDark ? '#1c1c1e' : '#fff',
    text: isDark ? '#fff' : '#000',
    secondary: isDark ? '#8e8e93' : '#6e6e73',
    border: isDark ? '#38383a' : '#c6c6c8',
    accent: '#007aff',
    danger: '#ff3b30',
    green: '#30d158',
    purple: '#5e5ce6',
    orange: '#ff9f0a',
  };

  const loadState = useCallback(async () => {
    await storeRef.current.init();
    setSnapshots(await storeRef.current.listSnapshots());
    setLibrary(await storeRef.current.listLibrary());
    setTasks(await loadScheduledTasks());
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  // ===== Task Scheduler — fires enabled tasks when due =====
  useEffect(() => {
    const interval = setInterval(async () => {
      const currentTasks = await loadScheduledTasks();
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
        await saveScheduledTasks(currentTasks);
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
          await deleteCredentials();
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
    setSetting('serverUrl', trimmed);
    setEditingServer(false);
  };

  const handleQuickAction = (action: QuickAction) => {
    Alert.alert(action.label, `Prompt: "${action.prompt}"`, [{ text: 'OK' }]);
  };

  const handleRestoreSnapshot = (snap: CanvasSnapshot) => {
    Alert.alert('Restore Canvas', `Restore "${snap.name}"? Current canvas will be replaced.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        onPress: async () => {
          const ok = await storeRef.current.restoreSnapshot(snap.id);
          if (ok) Alert.alert('Restored', 'Switch to Canvas tab to see the result.');
          else Alert.alert('Error', 'Failed to restore snapshot.');
        },
      },
    ]);
  };

  const handleUseLibraryComponent = async (entry: LibraryEntry) => {
    const componentId = await storeRef.current.useFromLibrary(entry.id);
    if (componentId) {
      Alert.alert('Added', `"${entry.name}" added to canvas as ${componentId}.`);
    }
  };

  const handleExportComponent = async (entry: LibraryEntry) => {
    const json = await storeRef.current.exportLibraryComponent(entry.id);
    if (json) {
      Alert.alert('Export', `Share this JSON to import on another device:\n\n${json.substring(0, 200)}...`);
    }
  };

  const handleAddTask = async () => {
    const existingCount = tasks.length;
    const templates = [
      { name: 'Auto-Save Canvas', prompt: '[System] Save a snapshot of the current canvas state.', intervalMs: 30 * 60 * 1000 },
      { name: 'Health Check', prompt: '[System] Report: connection status, component count, storage usage, last error.', intervalMs: 60 * 60 * 1000 },
      { name: 'Daily Summary', prompt: '[System] Generate a daily summary: what changed on the canvas today, key metrics, and suggestions.', intervalMs: 24 * 60 * 60 * 1000 },
    ];
    const template = templates[existingCount % templates.length];
    const task = await addScheduledTask({ ...template, enabled: false });
    setTasks(prev => [...prev, task]);
    Alert.alert('Task Added', `"${template.name}" added (disabled). Toggle to enable, tap to change interval, long-press to delete.`);
  };

  const handleToggleTask = async (task: ScheduledTask) => {
    await updateScheduledTask(task.id, { enabled: !task.enabled });
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, enabled: !t.enabled } : t));
  };

  const handleDeleteTask = (task: ScheduledTask) => {
    Alert.alert('Delete Task', `Remove "${task.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await removeScheduledTask(task.id);
          setTasks(prev => prev.filter(t => t.id !== task.id));
        },
      },
    ]);
  };

  const handleChangeInterval = (task: ScheduledTask) => {
    const buttons = INTERVAL_OPTIONS.map(opt => ({
      text: opt.label + (task.intervalMs === opt.ms ? ' ✓' : ''),
      onPress: async () => {
        await updateScheduledTask(task.id, { intervalMs: opt.ms });
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, intervalMs: opt.ms } : t));
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
    // Processing will be cleared when user sends stop or next message
    setTimeout(() => setIsProcessing(false), 30_000); // timeout fallback
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
  const statusColor = statusColorMap[displayStatus] || '#888';

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  // ===== Directory expand/collapse =====
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const menuItems = [
    { key: 'actions', label: 'Quick Actions', detail: `${DEFAULT_ACTIONS.length} actions`, icon: '◆' },
    { key: 'tasks', label: 'Scheduled Tasks', detail: `${tasks.filter(t => t.enabled).length}/${tasks.length} active`, icon: '⏱' },
    { key: 'history', label: 'Canvas History', detail: `${snapshots.length} saved`, icon: '◷' },
    { key: 'library', label: 'Component Library', detail: `${library.length} components`, icon: '❖' },
    { key: 'connection', label: 'Connection', detail: displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1), icon: '●' },
    { key: 'server', label: 'Server', detail: serverUrl.replace('https://', '').replace('http://', ''), icon: '⬡' },
    { key: 'about', label: 'About', detail: 'v0.1.0', icon: 'ℹ' },
  ];

  return (
    <View style={[styles.outerContainer, { backgroundColor: colors.bg }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.menuCard}>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {menuItems.map((item, i) => (
              <View key={item.key}>
                {i > 0 && <View style={[styles.separator, { backgroundColor: colors.border }]} />}

                {/* Directory row */}
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => toggle(item.key)}
                  activeOpacity={0.6}
                >
                  <Text style={[styles.menuIcon, { color: item.key === 'connection' ? statusColor : colors.purple }]}>{item.icon}</Text>
                  <Text style={[styles.label, { color: colors.text, flex: 1 }]}>{item.label}</Text>
                  <Text style={[styles.detail, { color: colors.secondary }]}>{item.detail}</Text>
                  <Text style={[styles.chevron, { color: colors.secondary, transform: [{ rotate: expanded[item.key] ? '90deg' : '0deg' }] }]}>{'>'}</Text>
                </TouchableOpacity>

                {/* Expanded: Quick Actions */}
                {expanded[item.key] && item.key === 'actions' && (
                  <View style={styles.expandedContent}>
                    {DEFAULT_ACTIONS.map((action) => (
                      <TouchableOpacity
                        key={action.id}
                        style={styles.subRow}
                        onPress={() => handleQuickAction(action)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.subIcon, { color: colors.purple }]}>{action.icon}</Text>
                        <Text style={[styles.label, { color: colors.text }]}>{action.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Expanded: Scheduled Tasks */}
                {expanded[item.key] && item.key === 'tasks' && (
                  <View style={styles.expandedContent}>
                    {tasks.length === 0 ? (
                      <Text style={[styles.emptyText, { color: colors.secondary }]}>No scheduled tasks</Text>
                    ) : (
                      tasks.map((task) => (
                        <TouchableOpacity
                          key={task.id}
                          style={styles.subRow}
                          onPress={() => handleChangeInterval(task)}
                          onLongPress={() => handleDeleteTask(task)}
                          activeOpacity={0.7}
                        >
                          <View style={{ flex: 1, opacity: task.enabled ? 1 : 0.4 }}>
                            <Text style={[styles.label, { color: colors.text }]}>{task.name}</Text>
                            <Text style={[styles.meta, { color: colors.secondary }]}>
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
                      <Text style={{ color: colors.purple, fontSize: 15, fontWeight: '600' }}>+ Add Task</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Expanded: Canvas History */}
                {expanded[item.key] && item.key === 'history' && (
                  <View style={styles.expandedContent}>
                    {snapshots.length === 0 ? (
                      <Text style={[styles.emptyText, { color: colors.secondary }]}>No saved canvases yet</Text>
                    ) : (
                      snapshots.map((snap) => (
                        <TouchableOpacity key={snap.id} style={styles.subRow} onPress={() => handleRestoreSnapshot(snap)}>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.label, { color: colors.text }]}>{snap.name}</Text>
                            <Text style={[styles.meta, { color: colors.secondary }]}>{snap.componentCount} components · {timeAgo(snap.createdAt)}</Text>
                          </View>
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {/* Expanded: Component Library */}
                {expanded[item.key] && item.key === 'library' && (
                  <View style={styles.expandedContent}>
                    {library.length === 0 ? (
                      <Text style={[styles.emptyText, { color: colors.secondary }]}>No saved components</Text>
                    ) : (
                      library.map((entry) => (
                        <TouchableOpacity
                          key={entry.id}
                          style={styles.subRow}
                          onPress={() => handleUseLibraryComponent(entry)}
                          onLongPress={() => handleExportComponent(entry)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.label, { color: colors.text }]}>{entry.name}</Text>
                            <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>
                              {entry.description || entry.tags.join(', ') || 'No description'}
                            </Text>
                          </View>
                          <Text style={{ color: colors.green, fontSize: 18 }}>+</Text>
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {/* Expanded: Connection */}
                {expanded[item.key] && item.key === 'connection' && (
                  <View style={styles.expandedContent}>
                    <View style={styles.subRow}>
                      <Text style={[styles.label, { color: colors.text }]}>Encryption</Text>
                      <Text style={[styles.detail, { color: colors.secondary }]}>
                        {credentials?.encryption.type === 'legacy' ? 'TweetNaCl' :
                         credentials?.encryption.type === 'dataKey' ? 'AES-256-GCM' : 'N/A'}
                      </Text>
                    </View>
                    {credentials ? (
                      <TouchableOpacity style={styles.subRow} onPress={handleUnpair}>
                        <Text style={[styles.label, { color: colors.danger }]}>Unpair Device</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity style={styles.subRow} onPress={() => router.push('/connect')}>
                        <Text style={[styles.label, { color: colors.accent }]}>Connect to Claude Code</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {/* Expanded: Server */}
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
                            <Text style={{ color: colors.secondary, fontSize: 16 }}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={handleSaveServer}>
                            <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>Save</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity style={styles.subRow} onPress={() => setEditingServer(true)}>
                        <Text style={[styles.label, { color: colors.accent }]}>Edit Server URL</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {/* Expanded: About */}
                {expanded[item.key] && item.key === 'about' && (
                  <View style={styles.expandedContent}>
                    <View style={styles.subRow}>
                      <Text style={[styles.label, { color: colors.text }]}>Build</Text>
                      <Text style={[styles.detail, { color: colors.secondary }]}>Expo SDK 54</Text>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* System Session — identical InputBar as Canvas */}
      <InputBar
        onSend={handleChatSend}
        onStop={handleChatStop}
        connected={connected}
        isProcessing={isProcessing}
        connectionState={connectionState}
        hasCreds={!!credentials}
        onReconnect={() => reconnect().catch(() => {})}
        lastError={lastError}
      />
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
  menuIcon: { fontSize: 16, width: 28 },
  label: { fontSize: 16 },
  detail: { fontSize: 14, marginRight: 8 },
  meta: { fontSize: 13, marginTop: 2 },
  chevron: { fontSize: 16, fontWeight: '300' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 44 },

  expandedContent: { paddingLeft: 28, paddingBottom: 4 },
  subRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, paddingHorizontal: 16, minHeight: 40,
  },
  subIcon: { fontSize: 14, width: 24 },
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
