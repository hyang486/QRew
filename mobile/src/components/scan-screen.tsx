import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { openInvite, parseInvite } from '@/lib/invite';

export function ScanScreen() {
  const router = useRouter();
  const signedIn = !!useAuth().session;
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
    // Signed in: the preview replaces the scanner. Signed out (start/scan, item 10): the invite is held and the
    // name step replaces the scanner, so Back from the name returns to the code screen.
    openInvite(invite, signedIn, {
      preview: (i) => router.replace({ pathname: '/preview', params: i }),
      name: () => router.replace('/guest'),
    });
  }

  // Qrew Q 08.01: "Scan an invite", one line, the camera in a rounded square with corner marks, and Enter code
  // instead pinned at the bottom (back to the code screen, the only place that opens Scan). The permission
  // request and the Settings path are unchanged; they show in the camera's place until it is allowed.
  return (
    <QScreen
      title={en.scan.title}
      subtitle={en.scan.subtitle}
      actions={<Button title={en.scan.enterCode} variant="secondary" onPress={() => router.back()} />}
    >
      {permission?.granted ? (
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
          <View style={styles.marks} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[styles.mark, styles.tl]} />
            <View style={[styles.mark, styles.tr]} />
            <View style={[styles.mark, styles.bl]} />
            <View style={[styles.mark, styles.br]} />
          </View>
        </View>
      ) : (
        <>
          <Hint>{en.scan.permissionHint}</Hint>
          {permission && !permission.canAskAgain ? (
            <Button title={en.scan.openSettings} onPress={() => Linking.openSettings()} />
          ) : (
            <Button title={en.scan.allow} onPress={requestPermission} />
          )}
        </>
      )}
      {error ? <Hint tone="error">{error}</Hint> : null}
    </QScreen>
  );
}

const MARK = 26;
const styles = StyleSheet.create({
  camera: { aspectRatio: 0.93, borderRadius: 14, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: '#22231F' },
  marks: { position: 'absolute', top: '22%', bottom: '22%', left: '20%', right: '20%' },
  mark: { position: 'absolute', width: MARK, height: MARK, borderColor: 'white' },
  tl: { top: 0, left: 0, borderTopWidth: 2.5, borderLeftWidth: 2.5 },
  tr: { top: 0, right: 0, borderTopWidth: 2.5, borderRightWidth: 2.5 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 2.5, borderLeftWidth: 2.5 },
  br: { bottom: 0, right: 0, borderBottomWidth: 2.5, borderRightWidth: 2.5 },
});
