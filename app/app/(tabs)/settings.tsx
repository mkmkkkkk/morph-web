import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { loadCredentials, deleteCredentials, type HappyCredentials } from '../../lib/credentials';
import { getSetting, setSetting } from '../../lib/settings';

type ConnectionStatus = 'unpaired' | 'disconnected' | 'connecting' | 'connected';

export default function SettingsScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [credentials, setCredentials] = useState<HappyCredentials | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unpaired');
  const [serverUrl, setServerUrl] = useState(getSetting('serverUrl'));
  const [editingServer, setEditingServer] = useState(false);

  const loadState = useCallback(async () => {
    const creds = await loadCredentials();
    setCredentials(creds);
    setConnectionStatus(creds ? 'disconnected' : 'unpaired');
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const handleUnpair = () => {
    Alert.alert(
      'Unpair Device',
      'This will remove all stored credentials. You will need to scan a new QR code to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            await deleteCredentials();
            setCredentials(null);
            setConnectionStatus('unpaired');
          },
        },
      ],
    );
  };

  const handleSaveServer = () => {
    const trimmed = serverUrl.trim();
    if (!trimmed.startsWith('http')) {
      Alert.alert('Invalid URL', 'Server URL must start with http:// or https://');
      return;
    }
    setSetting('serverUrl', trimmed);
    setEditingServer(false);
  };

  const statusColor = {
    unpaired: '#888',
    disconnected: '#ff4444',
    connecting: '#ffaa00',
    connected: '#44cc44',
  }[connectionStatus];

  const colors = {
    bg: isDark ? '#000' : '#f2f2f7',
    card: isDark ? '#1c1c1e' : '#fff',
    text: isDark ? '#fff' : '#000',
    secondary: isDark ? '#8e8e93' : '#6e6e73',
    border: isDark ? '#38383a' : '#c6c6c8',
    accent: '#007aff',
    danger: '#ff3b30',
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Connection Status */}
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

      {/* Pairing */}
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
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push('/connect')}
            >
              <Text style={[styles.label, { color: colors.accent }]}>Connect to Claude Code</Text>
              <Text style={[styles.chevron, { color: colors.secondary }]}>{'>'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Server */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.secondary }]}>SERVER</Text>
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          {editingServer ? (
            <View style={styles.editRow}>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.border }]}
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

      {/* App Info */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.secondary }]}>ABOUT</Text>
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.text }]}>Version</Text>
            <Text style={[styles.value, { color: colors.secondary }]}>0.1.0</Text>
          </View>
        </View>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { marginTop: 24, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '500', marginBottom: 6, marginLeft: 16 },
  card: { borderRadius: 10, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  label: { fontSize: 16 },
  value: { fontSize: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  chevron: { fontSize: 18, fontWeight: '300' },
  editRow: { padding: 16 },
  input: {
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  editButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
});
