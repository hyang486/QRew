import { AppleMaps, type CameraMoveEvent } from 'expo-maps';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RouteDrawLayer } from '@/components/route-draw-layer';
import { colors } from '@/components/ui';
import { en } from '@/i18n/en';
import { type Camera, type LatLng, MAX_ROUTE_POINTS } from '@/lib/location-plan';
import { NO_POIS } from '@/lib/map-pois';
import { appendStroke, isFlatNorthUp, joinStrokes, type MapRegion, type Point, type Size, strokeToRoute } from '@/lib/route-draw';

const ROUTE_COLOR = '#FF9500';
/** R1-A: how long a Pen press waits for its camera move to report back. */
const PEN_WAIT_MS = 2000;

type PenNote = 'none' | 'wait' | 'northUp' | 'truncated';

/**
 * R1-C: the full-screen route editor. A Modal sits outside the navigation stack, so the iOS back-swipe cannot
 * take a stroke (the repro lost every left-to-right stroke to it), and the map fills the screen with Cancel,
 * Done, Pen, Undo and Clear always in reach instead of below a locked, unscrollable page. It has its own map
 * and region; the room map screen behind it is not touched until Done saves.
 */
export function RouteEditor({
  savedRoute,
  startCamera,
  saving,
  onCancel,
  onSave,
}: {
  savedRoute: LatLng[];
  /** Where the editor's map opens: the room map's current view when known. */
  startCamera: Camera | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (route: LatLng[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<AppleMaps.MapView>(null);
  // The strokes drawn so far; the saved route is the first one. Undo never takes back the saved route
  // (Clear does that).
  const [draft, setDraft] = useState<LatLng[][]>(() => (savedRoute.length > 0 ? [savedRoute] : []));
  const [undoFloor, setUndoFloor] = useState(() => (savedRoute.length > 0 ? 1 : 0));
  const [pen, setPen] = useState(false);
  const [note, setNote] = useState<PenNote>('none');
  const route = useMemo(() => joinStrokes(draft), [draft]);

  // The visible region after the last camera move: needed to turn screen points into coordinates.
  const region = useRef<MapRegion | null>(null);
  // A Pen press that has to move the camera first waits for that move's report, and only for it.
  const penPending = useRef(false);
  const penTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pen comes on by itself once, after the map first reports a flat north-up region.
  const autoPen = useRef(true);
  function clearPending() {
    penPending.current = false;
    if (penTimer.current) clearTimeout(penTimer.current);
    penTimer.current = null;
  }
  useEffect(() => clearPending, []);

  function onCameraMove(event: CameraMoveEvent) {
    const { latitude, longitude } = event.coordinates;
    if (latitude == null || longitude == null) return;
    const next: MapRegion = {
      center: { latitude, longitude },
      longitudeDelta: event.longitudeDelta,
      zoom: event.zoom,
      bearing: event.bearing,
      tilt: event.tilt,
    };
    region.current = next;
    if (autoPen.current) {
      autoPen.current = false;
      if (isFlatNorthUp(next)) setPen(true);
      return;
    }
    if (!penPending.current) return;
    clearPending();
    if (isFlatNorthUp(next)) setPen(true);
    else setNote('northUp');
  }

  /**
   * Screen points convert exactly only on a flat, north-up map, so a rotated or tilted camera is first moved
   * to a zoom camera (north-up and flat in expo-maps), and the pen comes on when that move reports back flat.
   */
  function penOn() {
    autoPen.current = false;
    setNote('none');
    clearPending();
    const current = region.current;
    if (current && isFlatNorthUp(current)) {
      setPen(true);
      return;
    }
    const target: Camera | null = current ? { coordinates: current.center, zoom: current.zoom } : startCamera;
    if (!target) {
      setNote('wait');
      return;
    }
    const failNote = current ? 'northUp' : 'wait';
    penPending.current = true;
    penTimer.current = setTimeout(() => {
      if (!penPending.current) return;
      clearPending();
      setNote(failNote);
    }, PEN_WAIT_MS);
    mapRef.current?.setCameraPosition(target).catch(() => {
      clearPending();
      setNote(failNote);
    });
  }

  function penOff() {
    autoPen.current = false;
    clearPending();
    setPen(false);
  }

  function onStroke(stroke: Point[], size: Size) {
    const current = region.current;
    if (!current) return;
    // R1-D: the map fills the Modal under the status bar and home indicator, and MapKit reports its region for
    // the safe area inside it, so the stroke is converted in that frame (the draw layer covers the whole Modal).
    const next = appendStroke(draft, strokeToRoute(stroke, size, current, insets), MAX_ROUTE_POINTS);
    if (next.truncated) setNote('truncated');
    setDraft(next.strokes);
  }

  const canUndo = draft.length > undoFloor;
  const hint =
    note === 'wait'
      ? en.map.penWait
      : note === 'northUp'
        ? en.map.penNorthUp
        : note === 'truncated'
          ? en.map.routeTooLong(MAX_ROUTE_POINTS)
          : pen
            ? en.map.penOnHint
            : en.map.penOffHint;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      {/* A Modal is its own native root: gesture-handler needs a root view inside it. */}
      <GestureHandlerRootView style={styles.root}>
        <AppleMaps.View
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          cameraPosition={startCamera ?? undefined}
          polylines={route.length > 1 ? [{ id: 'draft', coordinates: route, color: ROUTE_COLOR, width: 4 }] : []}
          // No Apple Maps place card when a store/POI is under a tap (human iPhone check, R-1). selectionEnabled:false
          // alone still showed the card (qa, c4058f9), so POIs are hidden (NO_POIS) and none can be tapped.
          properties={{ selectionEnabled: false, pointsOfInterest: NO_POIS }}
          onCameraMove={onCameraMove}
        />
        {pen ? <RouteDrawLayer color={ROUTE_COLOR} onStroke={onStroke} /> : null}

        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable accessibilityRole="button" onPress={onCancel} disabled={saving} style={styles.barButton}>
            <Text style={styles.link}>{en.map.cancel}</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            {en.map.route}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => onSave(route)}
            disabled={saving}
            style={[styles.barButton, styles.barButtonEnd]}
          >
            {saving ? <ActivityIndicator /> : <Text style={[styles.link, styles.bold]}>{en.map.done}</Text>}
          </Pressable>
        </View>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
          <Text style={[styles.hint, note !== 'none' && styles.hintError]}>{hint}</Text>
          <View style={styles.tools}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={en.map.pen}
              accessibilityState={{ selected: pen }}
              onPress={() => (pen ? penOff() : penOn())}
              style={[styles.tool, pen && styles.toolOn]}
            >
              <SymbolView name="pencil.tip" size={18} tintColor={pen ? 'white' : colors.tint} />
              <Text style={[styles.link, pen && styles.toolOnText]}>{en.map.pen}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!canUndo}
              onPress={() => {
                setNote('none');
                setDraft((d) => (d.length > undoFloor ? d.slice(0, -1) : d));
              }}
              style={styles.tool}
            >
              <Text style={[styles.link, !canUndo && styles.disabledLink]}>{en.map.undo}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setNote('none');
                setDraft([]);
                setUndoFloor(0);
              }}
              style={styles.tool}
            >
              <Text style={styles.link}>{en.map.clear}</Text>
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: colors.field,
  },
  barButton: { minWidth: 72, minHeight: 44, justifyContent: 'center' },
  barButtonEnd: { alignItems: 'flex-end' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.label },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
    backgroundColor: colors.field,
  },
  hint: { fontSize: 14, color: colors.secondaryLabel },
  hintError: { color: colors.danger },
  tools: { flexDirection: 'row', gap: 12 },
  tool: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderCurve: 'continuous',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.background,
  },
  toolOn: { backgroundColor: colors.tint },
  toolOnText: { color: 'white' },
  link: { fontSize: 17, color: colors.tint },
  bold: { fontWeight: '600' },
  disabledLink: { color: colors.secondaryLabel },
});
