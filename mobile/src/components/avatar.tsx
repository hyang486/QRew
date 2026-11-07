import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { avatarUrl } from '@/lib/avatar';
import { authHeaders } from '@/lib/media';

type Props = { path: string | null | undefined; name: string; size?: number };

/**
 * A member's profile photo, or their initial when there is none or it cannot be read
 * (for example after the shared room ended, when Storage no longer allows the read).
 */
export function Avatar({ path, name, size = 32 }: Props) {
  const { session } = useAuth();
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const round = { width: size, height: size, borderRadius: size / 2 };

  if (path && session && failedPath !== path) {
    return (
      <Image
        style={round}
        source={{ uri: avatarUrl(path), headers: authHeaders(session.access_token), cacheKey: path }}
        // AV1: memory only, so other members' photos never stay on disk after the room ends or sign-out.
        cachePolicy="memory"
        onError={() => setFailedPath(path)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[round, styles.empty]}>
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>
        {(name.trim() || '?').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { backgroundColor: colors.separator, alignItems: 'center', justifyContent: 'center' },
  initial: { fontWeight: '600', color: colors.secondaryLabel },
});
