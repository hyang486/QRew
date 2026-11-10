import {
  type ComponentProps,
  type ComponentRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  LayoutAnimation,
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { colors } from '@/components/ui';
import { keyboardOverlap, revealScrollY, type Span } from '@/lib/keyboard-plan';
import { useHeaderOverlap } from '@/lib/use-header-overlap';

/**
 * Qrew screen scaffold (human rule USER_DECISIONS:168: match Qrew_heytea_UI.pdf). As in Q 01.04:
 * handwritten title at the top of the content with an optional small gray line under it (Q 01.01 "A room for
 * the people you're with."), a scrolling body (cards, art, text) with 24 pt sides and 12 pt gaps, and the
 * screen's actions pinned to the bottom above the home indicator, with an optional caption under them. The nav
 * header keeps only the back button (screens set headerTitle ''). With the keyboard open the pinned actions
 * ride above it (Q 02.01 "Join as guest") and the body scrolls a focused field into view.
 *
 * Keyboard (qa K1/K2): no KeyboardAvoidingView. Its offset came from a layout-time measure, which was wrong in a
 * sheet (K2), and it never scrolled the focused field into view (K1). Instead, at each keyboard move the root is
 * padded by the part of the keyboard on screen (keyboardOverlap: the screen reaches the window bottom, also in a
 * sheet, whose own measures are in sheet space and are never compared with the keyboard's screen coordinates);
 * once the body has its new size, the focused field (plus `keepVisible`, when both fit) is scrolled into view
 * (revealScrollY). One mechanism, so no padding and inset stack up.
 */
export function QScreen({
  title,
  subtitle,
  children,
  actions,
  bottom,
  bottomAlign = 'end',
  refreshControl,
  keepVisible,
}: {
  title?: string;
  /** Small gray line right under the title. */
  subtitle?: string;
  children?: ReactNode;
  /** Pinned bottom block: buttons, then a caption (QCaption). */
  actions?: ReactNode;
  /**
   * Body content anchored to the bottom of the scroll area, just above the actions (Q 01.04: the art sits
   * directly above Join). Free space goes between children and this block; it scrolls normally on overflow.
   */
  bottom?: ReactNode;
  /** 'center' puts the `bottom` block in the middle of the free space instead (Q 01.01, 02.01, 07.03 art). */
  bottomAlign?: 'end' | 'center';
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Kept in view together with the focused field when both fit (K2: a form's submit button under the fields). */
  keepVisible?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const insets = useSafeAreaInsets();
  // Pad the top by the header overlap ourselves instead of contentInsetAdjustmentBehavior "automatic": that
  // inset is added on top of a body that already fills the frame (flexGrow), so the `bottom` block was pushed
  // under the actions by the header height (qa c-nonmember at 1ab2fd1). `top` (where the root really starts)
  // is the keyboard avoider's offset, so an opaque header also lays out right. A screen without a header
  // (Welcome) still clears the status bar.
  const { rootRef, onLayout, overlap } = useHeaderOverlap();
  const { scrollRef, keyboardPad, scrollProps } = useKeyboardReveal(overlap, keepVisible);
  return (
    <View style={[styles.root, { paddingBottom: keyboardPad }]}>
      <View ref={rootRef} onLayout={onLayout} style={styles.flex}>
        <ScrollView
          ref={scrollRef}
          {...scrollProps}
          style={styles.flex}
          refreshControl={refreshControl}
          contentContainerStyle={[styles.body, { paddingTop: Math.max(overlap, insets.top) + 8 }]}
          contentInsetAdjustmentBehavior="never"
          scrollToOverflowEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {title ? (
            <View style={styles.head}>
              <HandTitle>{title}</HandTitle>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
          ) : null}
          {children}
          {bottom ? (
            <>
              <View style={styles.spacer} />
              {bottom}
              {bottomAlign === 'center' ? <View style={styles.spacer} /> : null}
            </>
          ) : null}
        </ScrollView>
        {actions ? <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>{actions}</View> : null}
      </View>
    </View>
  );
}

/** QScreen's keyboard handling (see the QScreen comment). iOS events; Android adds did-show/hide later. */
function useKeyboardReveal(overlap: number, keepVisible?: RefObject<ComponentRef<typeof View> | null>) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const keyboardUp = useRef(false);
  const scrollY = useRef(0);
  const maxY = useRef(0);
  const sizes = useRef({ content: 0, view: 0 });
  const [keyboardPad, setKeyboardPad] = useState(0);
  const overlapRef = useRef(overlap);
  // Only the screen on top reacts: a screen below in the stack keeps its layout while another one types.
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  const keepRef = useRef(keepVisible);
  // Latest values for the keyboard callbacks, synced after commit (refs are not written during render).
  useLayoutEffect(() => {
    overlapRef.current = overlap;
    focusedRef.current = focused;
    keepRef.current = keepVisible;
  }, [overlap, focused, keepVisible]);

  const reveal = useCallback(() => {
    const scroll = scrollRef.current;
    const field = TextInput.State.currentlyFocusedInput();
    if (!focusedRef.current || !keyboardUp.current || !scroll || !field) return;
    scroll.measureInWindow((_sx, sy, _sw, sh) => {
      field.measureInWindow((_fx, fy, _fw, fh) => {
        const visible: Span = { top: sy + overlapRef.current, bottom: sy + sh };
        const fieldSpan: Span = { top: fy, bottom: fy + fh };
        if (fh === 0) return;
        const go = (extra: Span | null) => {
          const y = revealScrollY(scrollY.current, fieldSpan, visible, maxY.current, extra);
          if (y !== null) scroll.scrollTo({ y, animated: true });
        };
        const keep = keepRef.current?.current;
        if (keep) keep.measureInWindow((_kx, ky, _kw, kh) => go(kh > 0 ? { top: ky, bottom: ky + kh } : null));
        else go(null);
      });
    });
  }, []);

  useEffect(() => {
    const move = (e: KeyboardEvent) => {
      if (!focusedRef.current) return;
      const pad = keyboardOverlap(Dimensions.get('window').height, e.endCoordinates);
      keyboardUp.current = pad > 0;
      if (e.duration) {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { duration: e.duration, type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardPad(pad);
    };
    const hide = (e: KeyboardEvent) => {
      keyboardUp.current = false;
      if (e.duration) LayoutAnimation.configureNext({ duration: e.duration, update: { duration: e.duration, type: LayoutAnimation.Types.keyboard } });
      setKeyboardPad(0);
    };
    const subs = [
      Keyboard.addListener('keyboardWillChangeFrame', move),
      Keyboard.addListener('keyboardWillHide', hide),
      // Moving focus between fields with the keyboard already up sends did-show again: reveal the new field.
      Keyboard.addListener('keyboardDidShow', reveal),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [reveal]);

  const updateMax = () => {
    maxY.current = Math.max(0, sizes.current.content - sizes.current.view);
  };
  const scrollProps = {
    scrollEventThrottle: 16,
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollY.current = e.nativeEvent.contentOffset.y;
    },
    // The body shrinks once the padding lands (and a multiline field grows while typing): reveal again then.
    onLayout: (e: { nativeEvent: { layout: { height: number } } }) => {
      sizes.current.view = e.nativeEvent.layout.height;
      updateMax();
      reveal();
    },
    onContentSizeChange: (_w: number, h: number) => {
      sizes.current.content = h;
      updateMax();
      reveal();
    },
  };

  return { scrollRef, keyboardPad, scrollProps };
}

/** The small centered gray line under the pinned actions (Q 01.04 "Guest name comes next."). */
export function QCaption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}

/** Small uppercase gray label over a group (Q 01.03 "YOUR ROOMS", Q 02.02 "ROOM TYPE"). */
export function QLabel({ children }: { children: string }) {
  return (
    <Text style={styles.label} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** Pale card (Q #F6F6F2): rows, notes and settings on Q screens. */
export function QCard({ children, row }: { children: ReactNode; row?: boolean }) {
  return <View style={[styles.card, row && styles.cardRow]}>{children}</View>;
}

/**
 * Q text field (Q 01.02, 02.01): white with a thin border, the label shown as the placeholder and read by
 * VoiceOver as the field's name.
 */
export function QField({ label, style, ...props }: ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <TextInput
      placeholder={label}
      placeholderTextColor={colors.secondaryLabel}
      accessibilityLabel={label}
      style={[styles.field, style]}
      {...props}
    />
  );
}

/** Centered text link (Q 01.02 "New here? Create an account"). */
export function QLink({
  title,
  onPress,
  tone,
  disabled,
}: {
  title: string;
  onPress: () => void;
  /** 'danger': red text button (Q 03.03 "End room for everyone"), read as a button, not a link. */
  tone?: 'danger';
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={tone === 'danger' ? 'button' : 'link'}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.link, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[styles.linkText, tone === 'danger' && { color: colors.danger }]}>{title}</Text>
    </Pressable>
  );
}

export const qSpacing = { side: 24, gap: 12 } as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  body: { flexGrow: 1, paddingHorizontal: qSpacing.side, paddingBottom: 24, gap: qSpacing.gap },
  head: { marginBottom: 6, gap: 4 },
  subtitle: { fontSize: 15, color: colors.secondaryLabel },
  spacer: { flexGrow: 1 },
  caption: { fontSize: 13, color: colors.secondaryLabel, textAlign: 'center', fontVariant: ['tabular-nums'] },
  label: { fontSize: 12, color: colors.secondaryLabel, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6 },
  card: { backgroundColor: colors.field, borderRadius: 12, borderCurve: 'continuous', paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  field: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.separator,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    fontSize: 17,
    color: colors.label,
    backgroundColor: colors.background,
  },
  link: { alignSelf: 'center', paddingVertical: 8 },
  linkText: { fontSize: 15, color: colors.label },
  actions: { paddingHorizontal: qSpacing.side, paddingTop: 12, gap: qSpacing.gap, backgroundColor: colors.background },
});
