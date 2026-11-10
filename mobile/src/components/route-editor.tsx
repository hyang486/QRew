import { AppleMaps, type CameraMoveEvent } from 'expo-maps';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RouteDrawLayer } from '@/components/route-draw-layer';
import { HandTitle } from '@/components/hand-title';
import { qSpacing } from '@/components/q-screen';
import { Button, colors, radius } from '@/components/ui';
import { en } from '@/i18n/en';
import { type Camera, formatRouteKm, type LatLng, MAX_ROUTE_POINTS } from '@/lib/location-plan';
import { NO_POIS } from '@/lib/map-pois';
import { appendStroke, isFlatNorthUp, joinStrokes, type MapRegion, type Point, type Size, strokeToRoute } from '@/lib/route-draw';

const ROUTE_COLOR = '#FF9500';
/** R1-A: how long a Pen press waits for its camera move to report back. */
const PEN_WAIT_MS = 2000;

type PenNote = 'none' | 'wait' | 'northUp' | 'truncated';

/**
 * R1-C: the full-screen route editor. A Modal sits outside the navigation stack, so the iOS back-swipe cannot
 * take a stroke (the repro lost every left-to-right stroke to it). Laid out as Q 04.01 (unit 4 F2): back arrow
 * (= Cancel), title and room name, the map card, Draw / Undo / Clear, the hint, and Save route (= Done) pinned
 * at the bottom, all in reach without scrolling. It has its own map and region; the room map screen behind it
 * is not touched until Save route saves. Draw on locks the map (no pinch while drawing, work list A8).
 */
export function RouteEditor({
  roomName,
  savedRoute,
  startCamera,
  saving,
  showsMyLocation,
  memberMarkers,
  memberPhotos,
  onCancel,
  onSave,
}: {
  /** Shown under the title (Q 04.01). */
  roomName: string;
  savedRoute: LatLng[];
  /** Where the editor's map opens: the room map's current view when known. */
  startCamera: Camera | null;
  saving: boolean;
  /**
   * #10: show the user's own position, exactly when the room map does (permission already granted and Share
   * or Show my location on). Read-only: the editor never asks for the location permission.
   */
  showsMyLocation: boolean;
  /** #10: the room map's live member pins (markers, and photo pins as annotations), read-only. */
  memberMarkers: AppleMaps.Marker[];
  memberPhotos: AppleMaps.Annotation[];
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
  // #10: the length of the line drawn so far, live as strokes are added; hidden with fewer than 2 points.
  const routeKm = useMemo(() => formatRouteKm(route), [route]);

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
    // R1-D / U4 F2: the map is a card inside the safe area (no status bar or home indicator over it), so MapKit's
    // region is the whole card, and the draw layer covers exactly the card: no inset correction.
    const next = appendStroke(draft, strokeToRoute(stroke, size, current), MAX_ROUTE_POINTS);
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
        {/* Qrew unit 4 F2 (Q 04.01): back arrow (= Cancel), handwritten title and room name, the map as a card,
            Draw / Undo / Clear pills, the hint line, and Save route (= Done) pinned at the bottom. */}
        <View style={[styles.page, { paddingTop: insets.top + 8 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={en.map.cancel}
            onPress={onCancel}
            disabled={saving}
            hitSlop={8}
            style={({ pressed }) => [styles.back, (pressed || saving) && styles.dimmed]}
          >
            <SymbolView name="chevron.left" size={20} weight="semibold" tintColor={colors.label} />
          </Pressable>
          <View style={styles.head}>
            <HandTitle>{en.map.editRoute}</HandTitle>
            <Text style={styles.roomName} numberOfLines={2}>
              {roomName}
            </Text>
          </View>

          <View style={styles.mapCard}>
            <AppleMaps.View
              ref={mapRef}
              style={StyleSheet.absoluteFill}
              cameraPosition={startCamera ?? undefined}
              markers={memberMarkers}
              annotations={memberPhotos}
              polylines={route.length > 1 ? [{ id: 'draft', coordinates: route, color: ROUTE_COLOR, width: 4 }] : []}
              // No Apple Maps place card when a store/POI is under a tap (human iPhone check, R-1). selectionEnabled:false
              // alone still showed the card (qa, c4058f9), so POIs are hidden (NO_POIS) and none can be tapped.
              properties={{ selectionEnabled: false, pointsOfInterest: NO_POIS, isMyLocationEnabled: showsMyLocation }}
              onCameraMove={onCameraMove}
            />
            {pen ? <RouteDrawLayer color={ROUTE_COLOR} onStroke={onStroke} /> : null}
            {/* Q 04.01 "5.2 km loop": the length only (the app does not know loops); read as "Route 5.2 km". */}
            {routeKm ? (
              <View style={styles.distanceChip} pointerEvents="none" accessible accessibilityLabel={en.map.routeDistance(routeKm)}>
                <Text style={styles.distance} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {routeKm}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.tools}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={en.map.draw}
              accessibilityState={{ selected: pen }}
              onPress={() => (pen ? penOff() : penOn())}
              style={[styles.tool, pen && styles.toolOn]}
            >
              <Text style={[styles.toolText, pen && styles.toolOnText]} numberOfLines={1}>
                {en.map.draw}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canUndo }}
              disabled={!canUndo}
              onPress={() => {
                setNote('none');
                setDraft((d) => (d.length > undoFloor ? d.slice(0, -1) : d));
              }}
              style={styles.tool}
            >
              <Text style={[styles.toolText, !canUndo && styles.disabledText]} numberOfLines={1}>
                {en.map.undo}
              </Text>
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
              <Text style={styles.toolText} numberOfLines={1}>
                {en.map.clear}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.hint, note !== 'none' && styles.hintError]}>{hint}</Text>
        </View>

        <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
          <Button title={en.map.saveRoute} busy={saving} onPress={() => onSave(route)} />
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  page: { flex: 1, paddingHorizontal: qSpacing.side, gap: qSpacing.gap },
  back: {
    width: 44,
    height: 44,
    marginLeft: -8,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmed: { opacity: 0.5 },
  head: { gap: 4 },
  roomName: { fontSize: 15, color: colors.secondaryLabel },
  // The map takes the space left between the head and the pills, never less than a usable drawing area.
  mapCard: { flex: 1, minHeight: 220, borderRadius: 12, borderCurve: 'continuous', overflow: 'hidden' },
  distanceChip: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: colors.tint,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  distance: { fontSize: 15, fontWeight: '600', color: colors.onTint, fontVariant: ['tabular-nums'] },
  // Three equal pills (Q 04.01); Draw is filled while it is on.
  tools: { flexDirection: 'row', gap: 8 },
  tool: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.field,
  },
  toolOn: { backgroundColor: colors.tint },
  toolText: { fontSize: 15, fontWeight: '500', color: colors.label },
  toolOnText: { color: colors.onTint },
  disabledText: { color: colors.secondaryLabel },
  hint: { fontSize: 14, color: colors.secondaryLabel },
  hintError: { color: colors.danger },
  actions: { paddingHorizontal: qSpacing.side, paddingTop: 12, backgroundColor: colors.background },
});
