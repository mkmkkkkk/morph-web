import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, useColorScheme, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { loadCredentials, deleteCredentials, type HappyCredentials } from '../../lib/credentials';
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

type ConnectionStatus = 'unpaired' | 'disconnected' | 'connecting' | 'connected';

export default function ConfigScreen() {
  const router = useRouter();
  const isDark = useColorScheme() !== 'light';
  const storeRef = useRef(new ComponentStore());

  const [credentials, setCredentials] = useState<HappyCredentials | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unpaired');
  const [serverUrl, setServerUrl] = useState(getSetting('serverUrl'));
  const [editingServer, setEditingServer] = useState(false);

  // Canvas History
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[]>([]);
  // Component Library
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  // Scheduled Tasks
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // Chat input
  const [chatText, setChatText] = useState('');

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
    inputBg: isDark ? '#1c1c1e' : '#e8e8e8',
  };

  const loadState = useCallback(async () => {
    const creds = await loadCredentials();
    setCredentials(creds);
    setConnectionStatus(creds ? 'disconnected' : 'unpaired');

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
          // TODO: Send task.prompt to system session when wired
          // For now, mark as run and log
          console.log(`[Scheduler] Firing task: ${task.name}`);
          task.lastRun = now;
          updated = true;
        }
      }

      if (updated) {
        await saveScheduledTasks(currentTasks);
        setTasks([...currentTasks]);
      }
    }, 30_000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, []);

  // --- Handlers ---
  const handleUnpair = () => {
    Alert.alert('Unpair Device', 'Remove all credentials? You\'ll need to scan a new QR code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpair', style: 'destructive',
        onPress: async () => {
          await deleteCredentials();
          setCredentials(null);
          setConnectionStatus('unpaired');
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
    // TODO: Send to system session when connected
    // For now, show what would be sent
    Alert.alert(action.label, `Prompt: "${action.prompt}"`, [
      { text: 'OK' },
    ]);
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
      // Copy-like behavior: show the JSON for sharing
      Alert.alert('Export', `Share this JSON to import on another device:\n\n${json.substring(0, 200)}...`);
    }
  };

  const handleAddTask = async () => {
    // Add a default example task — user can customize via system session
    const existingCount = tasks.length;
    const templates = [
      { name: 'Auto-Save Canvas', prompt: '[System] Save a snapshot of the current canvas state.', intervalMs: 30 * 60 * 1000 },
      { name: 'Health Check', prompt: '[System] Report: connection status, component count, storage usage, last error.', intervalMs: 60 * 60 * 1000 },
      { name: 'Daily Summary', prompt: '[System] Generate a daily summary: what changed on the canvas today, key metrics, and suggestions.', intervalMs: 24 * 60 * 60 * 1000 },
    ];
    const template = templates[existingCount % templates.length];
    const task = await addScheduledTask({ ...template, enabled: false });
    setTasks(prev => [...prev, task]);
    Alert.alert('Task Added', `"${template.name}" added (disabled). Tap toggle to enable, tap row to change interval, long-press to delete.`);
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

  const handleChatSend = () => {
    const trimmed = chatText.trim();
    if (!trimmed) return;
    // TODO: Send to system session
    Alert.alert('System Session', `Would send: "${trimmed}"`);
    setChatText('');
  };

  const statusColor = {
    unpaired: '#888',
    disconnected: '#ff4444',
    connecting: '#ffaa00',
    connected: '#44cc44',
  }[connectionStatus];

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <View style={[styles.outerContainer, { backgroundColor: colors.bg }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>

        {/* ===== QUICK ACTIONS ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>QUICK ACTIONS</Text>
          <View style={styles.actionsGrid}>
            {DEFAULT_ACTIONS.map((action) => (
              <TouchableOpacity
                key={action.id}
                style={[styles.actionCard, { backgroundColor: colors.card }]}
                onPress={() => handleQuickAction(action)}
                activeOpacity={0.7}
              >
                <Text style={[styles.actionIcon, { color: colors.purple }]}>{action.icon}</Text>
                <Text style={[styles.actionLabel, { color: colors.text }]} numberOfLines={1}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ===== SCHEDULED TASKS ===== */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.secondary, marginBottom: 0, marginLeft: 0 }]}>SCHEDULED TASKS</Text>
            <TouchableOpacity onPress={handleAddTask} activeOpacity={0.6}>
              <Text style={{ color: colors.purple, fontSize: 15, fontWeight: '600' }}>+ Add</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {tasks.length === 0 ? (
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.secondary }]}>No scheduled tasks</Text>
              </View>
            ) : (
              tasks.map((task, i) => (
                <View key={task.id}>
                  {i > 0 && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => handleChangeInterval(task)}
                    onLongPress={() => handleDeleteTask(task)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1, opacity: task.enabled ? 1 : 0.4 }}>
                      <Text style={[styles.label, { color: colors.text }]}>{task.name}</Text>
                      <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>
                        Every {formatInterval(task.intervalMs)}
                        {task.lastRun ? ` · ran ${timeAgo(task.lastRun)}` : ' · never ran'}
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
                </View>
              ))
            )}
          </View>
        </View>

        {/* ===== CANVAS HISTORY ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>CANVAS HISTORY</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {snapshots.length === 0 ? (
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.secondary }]}>No saved canvases yet</Text>
              </View>
            ) : (
              snapshots.map((snap, i) => (
                <View key={snap.id}>
                  {i > 0 && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
                  <TouchableOpacity style={styles.row} onPress={() => handleRestoreSnapshot(snap)}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.label, { color: colors.text }]}>{snap.name}</Text>
                      <Text style={[styles.meta, { color: colors.secondary }]}>
                        {snap.componentCount} components · {timeAgo(snap.createdAt)}
                      </Text>
                    </View>
                    <Text style={[styles.chevron, { color: colors.secondary }]}>{'>'}</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>

        {/* ===== COMPONENT LIBRARY ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>COMPONENT LIBRARY</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {library.length === 0 ? (
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.secondary }]}>No saved components</Text>
              </View>
            ) : (
              library.map((entry, i) => (
                <View key={entry.id}>
                  {i > 0 && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => handleUseLibraryComponent(entry)}
                    onLongPress={() => handleExportComponent(entry)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.label, { color: colors.text }]}>{entry.name}</Text>
                      <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>
                        {entry.description || entry.tags.join(', ') || 'No description'}
                      </Text>
                    </View>
                    <Text style={[styles.chevron, { color: colors.green }]}>+</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>

        {/* ===== CONNECTION ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>CONNECTION</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <View style={styles.row}>
              <Text style={[styles.label, { color: colors.text }]}>Status</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.value, { color: colors.secondary }]}>
                  {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
                </Text>
              </View>
            </View>
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
            <View style={styles.row}>
              <Text style={[styles.label, { color: colors.text }]}>Encryption</Text>
              <Text style={[styles.value, { color: colors.secondary }]}>
                {credentials?.encryption.type === 'legacy' ? 'TweetNaCl' :
                 credentials?.encryption.type === 'dataKey' ? 'AES-256-GCM' : 'N/A'}
              </Text>
            </View>
          </View>
        </View>

        {/* ===== PAIRING ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>PAIRING</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {credentials ? (
              <>
                <View style={styles.row}>
                  <Text style={[styles.label, { color: colors.text }]}>Device</Text>
                  <Text style={[styles.value, { color: colors.secondary }]}>Paired</Text>
                </View>
                <View style={[styles.separator, { backgroundColor: colors.border }]} />
                <TouchableOpacity style={styles.row} onPress={handleUnpair}>
                  <Text style={[styles.label, { color: colors.danger }]}>Unpair Device</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.row} onPress={() => router.push('/connect')}>
                <Text style={[styles.label, { color: colors.accent }]}>Connect to Claude Code</Text>
                <Text style={[styles.chevron, { color: colors.secondary }]}>{'>'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ===== SERVER ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>SERVER</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            {editingServer ? (
              <View style={styles.editRow}>
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
              <TouchableOpacity style={styles.row} onPress={() => setEditingServer(true)}>
                <Text style={[styles.label, { color: colors.text }]}>Server URL</Text>
                <Text style={[styles.value, { color: colors.secondary }]} numberOfLines={1}>
                  {serverUrl.replace('https://', '')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ===== ABOUT ===== */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>ABOUT</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <View style={styles.row}>
              <Text style={[styles.label, { color: colors.text }]}>Version</Text>
              <Text style={[styles.value, { color: colors.secondary }]}>0.1.0</Text>
            </View>
          </View>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* ===== SYSTEM SESSION CHAT BAR ===== */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <View style={[styles.chatBar, { backgroundColor: isDark ? '#0a0a0a' : '#f8f8f8', borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)' }]}>
          <View style={[styles.sessionDot, { backgroundColor: connectionStatus === 'connected' ? colors.green : '#636366' }]} />
          <TextInput
            style={[styles.chatInput, { backgroundColor: colors.inputBg, color: colors.text }]}
            value={chatText}
            onChangeText={setChatText}
            placeholder="System session..."
            placeholderTextColor={colors.secondary}
            multiline
            maxLength={10000}
            returnKeyType="send"
            onSubmitEditing={handleChatSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.chatSendBtn, !chatText.trim() && styles.chatSendDisabled]}
            onPress={handleChatSend}
            disabled={!chatText.trim()}
            activeOpacity={0.7}
          >
            <Text style={[styles.chatSendText, !chatText.trim() && { color: '#444' }]}>{'↑'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { paddingBottom: 20 },

  section: { marginTop: 20, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '500', marginBottom: 6, marginLeft: 16, letterSpacing: 0.5 },
  card: { borderRadius: 10, overflow: 'hidden' },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 16, minHeight: 44,
  },
  label: { fontSize: 16 },
  value: { fontSize: 16 },
  meta: { fontSize: 13, marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  chevron: { fontSize: 18, fontWeight: '300' },

  // Section header with right-side button
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6, marginLeft: 16, marginRight: 16,
  },

  // Toggle switch
  toggleBtn: {
    width: 44, height: 26, borderRadius: 13, padding: 2,
    justifyContent: 'center',
  },
  toggleKnob: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
  },

  // Quick Actions grid
  actionsGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
  },
  actionCard: {
    width: '48%' as any,
    flexBasis: '47%',
    flexGrow: 1,
    borderRadius: 12, padding: 14,
    alignItems: 'center', gap: 6,
  },
  actionIcon: { fontSize: 22 },
  actionLabel: { fontSize: 13, fontWeight: '500' },

  // Server edit
  editRow: { padding: 16 },
  serverInput: {
    fontSize: 16, borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12,
  },
  editButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 20 },

  // Chat bar
  chatBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 10, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sessionDot: {
    width: 7, height: 7, borderRadius: 3.5, marginRight: 6, marginBottom: 14,
  },
  chatInput: {
    flex: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 16, maxHeight: 120,
  },
  chatSendBtn: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: '#5e5ce6',
    justifyContent: 'center', alignItems: 'center', marginLeft: 6,
  },
  chatSendDisabled: { backgroundColor: '#1c1c1e' },
  chatSendText: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: -1 },
});
