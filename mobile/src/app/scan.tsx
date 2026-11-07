import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { parseInvite } from '@/lib/rooms';

export default function Scan() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  // onBarcodeScanned fires repeatedly for the same code; act on the first valid one only.
  const handled = useRef(false);

  function onScanned({ data }: BarcodeScanningResult) {
    if (handled.current) return;
    const invite = parseInvite(data);
    if (!invite) {
      setError(en.scan.notInvite);
      return;
    }
    handled.current = true;
    router.replace({ pathname: '/preview', params: invite });
  }

  if (!permission?.granted) {
    return (
      <Screen>
        <Hint>{en.scan.permissionHint}</Hint>
        {permission && !permission.canAskAgain ? (
          <Button title={en.scan.openSettings} onPress={() => Linking.openSettings()} />
        ) : (
          <Button title={en.scan.allow} onPress={requestPermission} />
        )}
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      {error ? (
        <View style={styles.banner}>
          <Hint tone="error">{error}</Hint>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 48,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
});
