import type { ReactElement, ReactNode } from 'react';
import {
  ActivityIndicator,
  PlatformColor,
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

export const colors = {
  label: PlatformColor('label'),
  secondaryLabel: PlatformColor('secondaryLabel'),
  background: PlatformColor('systemGroupedBackground'),
  field: PlatformColor('secondarySystemGroupedBackground'),
  separator: PlatformColor('separator'),
  tint: PlatformColor('systemBlue'),
  danger: PlatformColor('systemRed'),
  warning: PlatformColor('systemOrange'),
};

/**
 * J-1: under the translucent iOS 26 header the scroll view rests at a negative offset
 * (-adjustedContentInset.top). On every keyboard frame change, RN 0.88's automaticallyAdjustKeyboardInsets
 * calls scrollTo, which clamps y to >= -contentInset.top (the raw inset, 0) and ignores the automatic
 * inset, so the content jumped up under the header and stayed there after the keyboard closed.
 * scrollToOverflowEnabled skips that clamp; the keyboard handler still scrolls a hidden field into view.
 */
export function Screen({ children, refreshControl }: { children: ReactNode; refreshControl?: ReactElement<RefreshControlProps> }) {
  return (
    <ScrollView
      refreshControl={refreshControl}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      scrollToOverflowEnabled
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.secondaryLabel}
        style={styles.field}
        accessibilityLabel={label}
        {...props}
      />
    </View>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive';
  busy?: boolean;
  disabled?: boolean;
};

export function Button({ title, onPress, variant = 'primary', busy, disabled }: ButtonProps) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        isPrimary ? { backgroundColor: colors.tint } : { backgroundColor: colors.field },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isPrimary ? 'white' : undefined} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            {
              color: isPrimary ? 'white' : variant === 'destructive' ? colors.danger : colors.tint,
            },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Hint({ children, tone = 'normal' }: { children: ReactNode; tone?: 'normal' | 'error' }) {
  return (
    <Text
      selectable
      style={[styles.hint, tone === 'error' && { color: colors.danger }]}
      accessibilityLiveRegion={tone === 'error' ? 'polite' : 'none'}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 16 },
  fieldWrap: { gap: 6 },
  fieldLabel: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  field: {
    backgroundColor: colors.field,
    color: colors.label,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
  },
  button: {
    minHeight: 50,
    borderRadius: 12,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 15, color: colors.secondaryLabel },
});
