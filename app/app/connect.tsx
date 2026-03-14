import { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  useColorScheme,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { pairFromQR, pairFromJson, type PairResult } from '../lib/auth';
import { useConnection } from '../lib/ConnectionContext';

type Mode = 'scan' | 'manual';

export default function ConnectScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { connect } = useConnection();

  const [mode, setMode] = useState<Mode>('scan');
  const [pairing, setPairing] = useState(false);
  const [pairStatus, setPairStatus] = useState<'idle' | 'pairing' | 'connecting' | 'done' | 'error'>('idle');
  const [statusText, setStatusText] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const colors = {
    bg: isDark ? '#000' : '#f2f2f7',
    card: isDark ? '#1c1c1e' : '#fff',
    text: isDark ? '#fff' : '#000',
    secondary: isDark ? '#8e8e93' : '#6e6e73',
    accent: '#007aff',
    green: '#30d158',
  };

  const handlePairResult = async (result: PairResult) => {
    if (result.success) {
      setPairStatus('connecting');
      setStatusText('Credentials saved. Connecting...');
      try {
        await connect();
        setPairStatus('done');
        setStatusText('Connected to Claude Code');
        // Auto-navigate back after short delay
        setTimeout(() => router.back(), 800);
      } catch {
        setPairStatus('done');
        setStatusText('Paired. Connection will retry automatically.');
        setTimeout(() => router.back(), 1200);
      }
    } else {
      setPairing(false);
      setPairStatus('error');
      setStatusText(result.error);
      scannedRef.current = false;
      Alert.alert('Pairing Failed', result.error);
    }
  };

  const handleQRScanned = async (data: string) => {
    if (scannedRef.current || pairing) return;
    scannedRef.current = true;
    setPairing(true);
    setPairStatus('pairing');
    setStatusText('QR scanned. Saving credentials...');

    try {
      const result = await pairFromQR(data);
      await handlePairResult(result);
    } catch (err: any) {
      setPairing(false);
      setPairStatus('error');
      setStatusText(err?.message || 'Failed to process QR code');
      scannedRef.current = false;
    }
  };

  const handleManualPair = async () => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;
    setPairing(true);
    setPairStatus('pairing');
    setStatusText('Parsing credentials...');

    try {
      const result = await pairFromJson(trimmed);
      await handlePairResult(result);
    } catch (err: any) {
      setPairing(false);
      setPairStatus('error');
      setStatusText(err?.message || 'Failed to parse credentials');
    }
  };

  // Camera permission handling
  if (mode === 'scan' && !permission?.granted) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.permissionBox}>
          <Text style={[styles.permissionTitle, { color: colors.text }]}>Camera Access</Text>
          <Text style={[styles.permissionText, { color: colors.secondary }]}>
            Morph needs camera access to scan the QR code from Claude Code settings.
          </Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.accent }]}
            onPress={requestPermission}
          >
            <Text style={styles.buttonText}>Grant Access</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMode('manual')}>
            <Text style={[styles.linkText, { color: colors.accent }]}>Enter manually instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Mode switcher */}
      <View style={styles.modeSwitch}>
        <TouchableOpacity
          style={[styles.modeTab, mode === 'scan' && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]}
          onPress={() => setMode('scan')}
        >
          <Text style={[styles.modeText, { color: mode === 'scan' ? colors.accent : colors.secondary }]}>
            Scan QR
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeTab, mode === 'manual' && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]}
          onPress={() => setMode('manual')}
        >
          <Text style={[styles.modeText, { color: mode === 'manual' ? colors.accent : colors.secondary }]}>
            Manual
          </Text>
        </TouchableOpacity>
      </View>

      {mode === 'scan' ? (
        <View style={styles.scanContainer}>
          {pairing ? (
            <View style={styles.loadingOverlay}>
              {pairStatus === 'done' ? (
                <Text style={styles.checkmark}>✅</Text>
              ) : pairStatus === 'error' ? (
                <Text style={styles.checkmark}>❌</Text>
              ) : (
                <ActivityIndicator size="large" color={colors.accent} />
              )}
              <Text style={[styles.loadingText, { color: colors.text }]}>{statusText}</Text>
            </View>
          ) : (
            <>
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(result) => handleQRScanned(result.data)}
              />
              <View style={styles.scanOverlay}>
                <View style={styles.scanFrame} />
              </View>
              <Text style={[styles.scanHint, { color: colors.secondary }]}>
                Scan the QR code from HappyCoder settings
              </Text>
            </>
          )}
        </View>
      ) : (
        <View style={styles.manualContainer}>
          <Text style={[styles.manualLabel, { color: colors.text }]}>
            Paste credentials JSON
          </Text>
          <Text style={[styles.manualHint, { color: colors.secondary }]}>
            Copy from ~/.happy/credentials.json on your computer
          </Text>
          <TextInput
            style={[styles.manualInput, { color: colors.text, borderColor: colors.secondary, backgroundColor: colors.card }]}
            multiline
            value={manualInput}
            onChangeText={setManualInput}
            placeholder={'{"token":"...","secret":"..."}'}
            placeholderTextColor={colors.secondary}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.accent, opacity: pairing || !manualInput.trim() ? 0.5 : 1 }]}
            onPress={handleManualPair}
            disabled={pairing || !manualInput.trim()}
          >
            {pairing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Pair</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  modeSwitch: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#38383a',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modeText: { fontSize: 16, fontWeight: '500' },
  scanContainer: { flex: 1 },
  camera: { flex: 1 },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 16,
  },
  scanHint: {
    textAlign: 'center',
    padding: 16,
    fontSize: 14,
  },
  loadingOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: { fontSize: 16, textAlign: 'center', marginTop: 8 },
  checkmark: { fontSize: 48 },
  manualContainer: { flex: 1, padding: 20 },
  manualLabel: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  manualHint: { fontSize: 13, marginBottom: 12 },
  manualInput: {
    flex: 1,
    maxHeight: 200,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  permissionBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    gap: 16,
  },
  permissionTitle: { fontSize: 20, fontWeight: '600' },
  permissionText: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  linkText: { fontSize: 15, marginTop: 8 },
});
