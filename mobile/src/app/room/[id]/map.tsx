import { AppleMaps, type CameraMoveEvent } from 'expo-maps';
import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { RouteEditor } from '@/components/route-editor';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import {
  getMyPosition,
  hasForegroundPermission,
  locateMe,
  type Presence,
  requestForegroundPermission,
  saveRoute,
  setActivityState,
  setLocationAllowed,
  setShareLocation,
  useLivePresence,
  useMyShare,
  useSharingState,
} from '@/lib/location';
import {
  type Camera,
  fitRoomCamera,
  formatAge,
  formatSpeedKmh,
  isStale,
  labelPins,
  type LatLng,
  MAX_CAMERA_ZOOM,
  parseRoute,
  type PinInput,
  planLabels,
  planPins,
  ROOM_MAP_SIZE,
  type Viewport,
  viewportFromCamera,
  viewportFromRegion,
  type ViewSize,
  wantedIconPaths,
} from '@/lib/location-plan';
import { useMarkerIcons } from '@/lib/marker-icons';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, listMembers, type Room } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; names: Map<string, string>; avatars: Map<string, string | null> };

const STALE_TINT = '#8E8E93';
const ROUTE_COLOR = '#007AFF';
// P2: the member label pill. Fixed light colors (not the app theme) so it reads the same on light and dark maps.
const LABEL_BACKGROUND = '#FFFFFF';
const LABEL_TEXT = '#000000';
const LABEL_STALE_TEXT = '#6C6C70';

export default function RoomMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const room = await getRoom(id);
      if (!room) {
        setState({ status: 'gone' });
        return;
      }
      const members = await listMembers(id);
      setState({
        status: 'ready',
        room,
        names: new Map(members.map((m) => [m.user_id, m.display_name])),
        avatars: new Map(members.map((m) => [m.user_id, m.avatar_path])),
      });
    } catch (e) {
      setState((s) => (s.status === 'ready' ? s : { status: 'error', message: errorMessage(e) }));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Location setting, activity state, route and membership all live on rooms / room_members.
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') load();
  });

  if (state.status === 'loading') return <ActivityIndicator style={styles.loading} />;
  if (state.status === 'gone') {
    return (
      <View style={styles.center}>
        <Text style={styles.goneTitle}>{en.room.gone}</Text>
        <Hint>{en.room.goneHint}</Hint>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={styles.center}>
        <Hint tone="error">{state.message}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </View>
    );
  }
  return <RoomMap room={state.room} names={state.names} avatars={state.avatars} />;
}

function RoomMap({
  room,
  names,
  avatars,
}: {
  room: Room;
  names: Map<string, string>;
  avatars: Map<string, string | null>;
}) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const isHost = room.host_id === userId;
  const now = useNow(15_000);
  const mapRef = useRef<AppleMaps.MapView>(null);

  const allowed = room.location_allowed;
  const active = allowed && room.activity_state === 'active';

  const my = useMyShare(room.id, userId);
  const [busy, setBusy] = useState<string | null>(null);
  // M2: the app-level LocationReporters does the reporting; this screen only reads its state.
  const sharingState = useSharingState(room.id);

  // M5: the permission is read again whenever the app returns to the foreground (e.g. from Settings).
  const [granted, setGranted] = useState<boolean | null>(null);
  const [askDenied, setAskDenied] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () =>
      hasForegroundPermission()
        .then((ok) => {
          if (live) setGranted(ok);
        })
        .catch(() => {});
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  const permissionDenied = granted === false && (askDenied || sharingState === 'no-permission');

  const presence = useLivePresence(room.id, active);
  const savedRoute = useMemo(() => parseRoute(room.route), [room.route]);
  // R1-C: the host edits the route in a full-screen editor (a Modal outside the stack, with its own map).
  // Holds where the editor's map opens, captured when it opens; null when not editing.
  const [editor, setEditor] = useState<{ start: Camera | null } | null>(null);
  const shownRoute = savedRoute;

  // F5-5b: the map's real size once it is laid out (the fit and the label grouping measure against it).
  const [mapSize, setMapSize] = useState<ViewSize>(ROOM_MAP_SIZE);
  // The room map's view after its last camera move: the editor opens on the same view.
  const lastView = useRef<Camera | null>(null);
  // P2: what the map showed when its camera last stopped (expo-maps reports a move only at its end), used to
  // group the member labels on screen. Null until the first move ends.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  function onCameraMove(event: CameraMoveEvent) {
    const { latitude, longitude } = event.coordinates;
    if (latitude == null || longitude == null) return;
    lastView.current = { coordinates: { latitude, longitude }, zoom: event.zoom };
    const next = viewportFromRegion(event, mapSize);
    // Only a real change re-renders (an equal event must not loop through a new pin layout).
    setViewport((prev) =>
      next &&
      (!prev ||
        prev.scale !== next.scale ||
        prev.bearing !== next.bearing ||
        prev.center.latitude !== next.center.latitude ||
        prev.center.longitude !== next.center.longitude)
        ? next
        : prev,
    );
  }

  // M1: a fresh member with a profile photo is an annotation with the photo as its icon (square: expo-maps
  // draws the icon as a plain 50 pt image and cannot round it). No photo, still loading or a failed load:
  // an initials marker. Stale: a grey clock marker with no speed (C4), photo or not. Only current members
  // (`avatars` comes from listMembers) get a photo. P2: the pins have no title (MapKit hid one of two close
  // titles); the name · speed labels are text annotations, one pill per group of pins that are close on
  // screen, under the group's lowest pin (planLabels). expo-maps' SwiftUI Map has no tap callout, and pins
  // and labels have no tap action.
  const pinInputs: PinInput[] = presence.rows.map((row) => ({
    userId: row.user_id,
    coordinates: { latitude: row.lat, longitude: row.lng },
    updatedAt: row.updated_at,
    speedMps: row.speed_mps,
    label: displayName(row, userId, names),
    initialsOf: names.get(row.user_id) ?? '',
    avatarPath: avatars.get(row.user_id) ?? null,
  }));
  const icons = useMarkerIcons(wantedIconPaths(pinInputs, now), session?.access_token);
  const pins = planPins(pinInputs, now, icons, en.map.stalePin);
  const labelInputs = labelPins(pins);
  const markers = pins.flatMap((pin) =>
    pin.kind === 'photo'
      ? []
      : [
          {
            id: pin.id,
            coordinates: pin.coordinates,
            ...(pin.kind === 'stale' ? { systemImage: 'clock', tintColor: STALE_TINT } : { monogram: pin.monogram }),
          },
        ],
  );

  // M6: with no route or positions yet, the map starts on the user's own position (no prompt).
  const [myPosition, setMyPosition] = useState<LatLng | null>(null);
  useEffect(() => {
    if (!granted) return;
    let live = true;
    getMyPosition().then((pos) => {
      if (live && pos) setMyPosition(pos);
    });
    return () => {
      live = false;
    };
  }, [granted]);

  // Center once on the first route or position (or, until there is one, on the user's own position);
  // after that only the Recenter button moves the camera. F5-3: the zoom fits the points' span.
  // F5-4: the first centering goes through the cameraPosition prop, which expo-maps applies once the
  // native view exists; an imperative call right after mount could reject ("Unable to find the view").
  // F5-5b: the fit keeps the points clear of the overlay buttons and of the pins' own icons and labels,
  // measured against the map's real size once it is laid out.
  // P2: the fit also leaves room for the member labels it will draw (grouped pills grow downward).
  // Cheap (a few pins), so it is recomputed on each render rather than memoized on the per-render pin list.
  const pointsCamera = fitRoomCamera(
    [...savedRoute, ...presence.rows.map((r) => ({ latitude: r.lat, longitude: r.lng }))],
    labelInputs,
    mapSize,
  );
  const camera = roomCamera(pointsCamera, myPosition);
  const [initialCamera, setInitialCamera] = useState<Camera | null>(null);
  const centeredOn = useRef<'none' | 'mine' | 'points'>('none');
  useEffect(() => {
    if (centeredOn.current === 'points' || !camera) return;
    if (!pointsCamera && centeredOn.current === 'mine') return;
    centeredOn.current = pointsCamera ? 'points' : 'mine';
    // A one-time snapshot: later moves of the points must not move the camera.
    setInitialCamera(camera);
  }, [camera, pointsCamera]);

  function recenter() {
    if (camera) mapRef.current?.setCameraPosition(camera).catch(() => {});
  }

  // F5-1: "Show my location" works with Share off. The permission prompt comes only from this tap;
  // the position is read once, kept on this screen, and never sent (no RPC, no sharing-store change).
  const [locate, setLocate] = useState<'idle' | 'busy' | 'denied' | 'settings' | 'unavailable'>('idle');
  const [showingMine, setShowingMine] = useState(false);
  async function showMyLocation() {
    if (locate === 'busy') return;
    setLocate('busy');
    const result = await locateMe();
    if (result.kind === 'denied') {
      setGranted(false);
      setShowingMine(false);
      setLocate(result.canAskAgain ? 'denied' : 'settings');
      return;
    }
    if (result.kind === 'unavailable') {
      setLocate('unavailable');
      return;
    }
    setGranted(true);
    setMyPosition(result.position);
    setShowingMine(true);
    setLocate('idle');
    mapRef.current
      ?.setCameraPosition({ coordinates: result.position, zoom: MAX_CAMERA_ZOOM })
      .catch(() => {});
  }

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      Alert.alert(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  // C1: the device permission comes first, so the reporter never starts without it and undoes the opt-in.
  function toggleShare(next: boolean) {
    run('share', async () => {
      if (next) {
        const ok = await requestForegroundPermission();
        setGranted(ok);
        setAskDenied(!ok);
        if (!ok) return;
      }
      await setShareLocation(room.id, next);
      my.setShareLocal(next);
    });
  }

  function toggleAllowed(next: boolean) {
    if (next) {
      run('allowed', () => setLocationAllowed(room.id, true));
      return;
    }
    Alert.alert(en.map.endConfirmTitle, en.map.allowLocationHint, [
      { text: en.map.cancel, style: 'cancel' },
      { text: en.map.endActivity, style: 'destructive', onPress: () => run('allowed', () => setLocationAllowed(room.id, false)) },
    ]);
  }

  function toggleActivity() {
    if (!active) {
      run('activity', () => setActivityState(room.id, 'active'));
      return;
    }
    Alert.alert(en.map.endConfirmTitle, en.map.endConfirmBody, [
      { text: en.map.cancel, style: 'cancel' },
      { text: en.map.endActivity, style: 'destructive', onPress: () => run('activity', () => setActivityState(room.id, 'ended')) },
    ]);
  }

  function openEditor() {
    setEditor({ start: lastView.current ?? camera });
  }

  function saveEdited(route: LatLng[]) {
    run('route', async () => {
      await saveRoute(room.id, route);
      setEditor(null);
    });
  }

  // P2: grouped on the last camera the map stopped at; before the first camera event, on the camera it was
  // given (or will be given by Recenter), so the first frame already groups.
  const givenCamera = initialCamera ?? camera;
  const labelView = viewport ?? (givenCamera ? viewportFromCamera(givenCamera, mapSize) : null);
  const labels = planLabels(labelInputs, labelView, mapSize);
  const annotations = [
    ...pins.flatMap((pin) => (pin.kind === 'photo' ? [{ id: pin.id, coordinates: pin.coordinates, icon: pin.icon }] : [])),
    ...labels.map((label) => ({
      id: label.id,
      coordinates: label.coordinates,
      text: label.text,
      anchor: label.anchor,
      backgroundColor: LABEL_BACKGROUND,
      textColor: label.stale ? LABEL_STALE_TEXT : LABEL_TEXT,
    })),
  ];

  const reporterText = en.map.reporter[sharingState];
  const reporterIsError = sharingState === 'error' || sharingState === 'no-permission' || sharingState === 'refused';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: en.map.title }} />

      <View
        style={styles.mapWrap}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0 && (width !== mapSize.width || height !== mapSize.height)) {
            setMapSize({ width, height });
          }
        }}
      >
        <AppleMaps.View
          ref={mapRef}
          style={styles.map}
          cameraPosition={initialCamera ?? undefined}
          markers={markers}
          annotations={annotations}
          polylines={
            shownRoute.length > 1
              ? [{ id: 'route', coordinates: shownRoute, color: ROUTE_COLOR, width: 4 }]
              : []
          }
          properties={{ isMyLocationEnabled: granted === true && (my.share || showingMine) }}
          onCameraMove={onCameraMove}
        />
        <Pressable
              accessibilityRole="button"
              accessibilityLabel={en.map.showMine}
              accessibilityState={{ busy: locate === 'busy' }}
              onPress={showMyLocation}
              style={[styles.overlayButton, styles.showMine]}
            >
              <Text style={styles.link}>{locate === 'busy' ? en.map.locating : en.map.showMine}</Text>
            </Pressable>
            {camera ? (
              <Pressable accessibilityRole="button" onPress={recenter} style={[styles.overlayButton, styles.recenter]}>
                <Text style={styles.link}>{en.map.recenter}</Text>
              </Pressable>
            ) : null}
        {isHost ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={en.map.pen}
            onPress={openEditor}
            style={[styles.overlayButton, styles.pen]}
          >
            <SymbolView name="pencil.tip" size={18} tintColor={colors.tint} />
            <Text style={styles.link}>{en.map.pen}</Text>
          </Pressable>
        ) : null}
      </View>
      {locate === 'denied' ? <Hint tone="error">{en.map.locateDenied}</Hint> : null}
      {locate === 'settings' ? (
        <>
          <Hint tone="error">{en.map.locateDeniedSettings}</Hint>
          <Button title={en.map.openSettings} variant="secondary" onPress={() => Linking.openSettings()} />
        </>
      ) : null}
      {locate === 'unavailable' ? <Hint tone="error">{en.map.locateUnavailable}</Hint> : null}
      {showingMine && !my.share ? <Hint>{en.map.showMineHint}</Hint> : null}

      {isHost ? (
        <View style={styles.group}>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{en.map.allowLocation}</Text>
            <Switch
              value={allowed}
              disabled={busy === 'allowed'}
              onValueChange={toggleAllowed}
              accessibilityLabel={en.map.allowLocation}
            />
          </View>
          <Hint>{en.map.allowLocationHint}</Hint>
          {allowed ? (
            <Button
              title={active ? en.map.endActivity : en.map.startActivity}
              variant={active ? 'secondary' : 'primary'}
              busy={busy === 'activity'}
              onPress={toggleActivity}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.group}>
        <Text style={styles.status} accessibilityRole="header">
          {active ? en.map.activityActive : en.map.activityIdle}
        </Text>
        {!allowed ? <Hint>{en.map.notAllowed}</Hint> : !active ? <Hint>{en.map.activityIdleHint}</Hint> : null}
        {allowed ? (
          <>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{en.map.shareMine}</Text>
              <Switch
                value={my.share}
                disabled={busy === 'share'}
                onValueChange={toggleShare}
                accessibilityLabel={en.map.shareMine}
              />
            </View>
            <Hint>{en.map.shareMineHint}</Hint>
            {permissionDenied ? (
              <>
                <Hint tone="error">{en.map.permissionDenied}</Hint>
                <Button title={en.map.openSettings} variant="secondary" onPress={() => Linking.openSettings()} />
              </>
            ) : reporterText ? (
              <Hint tone={reporterIsError ? 'error' : 'normal'}>{reporterText}</Hint>
            ) : null}
          </>
        ) : null}
      </View>

      {active ? (
        <View style={styles.group}>
          <Text style={styles.status}>{en.map.members}</Text>
          {presence.rows.length === 0 ? <Hint>{en.map.nobody}</Hint> : null}
          {presence.rows.map((row) => (
            <PresenceRow
              key={row.user_id}
              row={row}
              name={displayName(row, userId, names)}
              initialOf={names.get(row.user_id) ?? ''}
              avatarPath={avatars.get(row.user_id) ?? null}
              now={now}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.group}>
        <Text style={styles.status}>{en.map.route}</Text>
        {isHost ? (
          <Button
            title={savedRoute.length > 0 ? en.map.editRoute : en.map.drawRoute}
            variant="secondary"
            onPress={openEditor}
          />
        ) : null}
      </View>
      {editor ? (
        <RouteEditor
          savedRoute={savedRoute}
          startCamera={editor.start}
          saving={busy === 'route'}
          onCancel={() => setEditor(null)}
          onSave={saveEdited}
        />
      ) : null}
    </ScrollView>
  );
}

/** The fitted camera, or until there are points, street level on the user's own position. */
function roomCamera(pointsCamera: Camera | null, myPosition: LatLng | null): Camera | null {
  return pointsCamera ?? (myPosition ? { coordinates: myPosition, zoom: MAX_CAMERA_ZOOM } : null);
}

function displayName(row: Presence, userId: string | undefined, names: Map<string, string>) {
  return row.user_id === userId ? en.map.you : (names.get(row.user_id) ?? en.chat.formerMember);
}

/** C4: a stale row never shows its speed; it shows "Location stale" with its age instead. */
function PresenceRow({
  row,
  name,
  initialOf,
  avatarPath,
  now,
}: {
  row: Presence;
  name: string;
  initialOf: string;
  avatarPath: string | null;
  now: number;
}) {
  const age = formatAge(row.updated_at, now);
  const stale = isStale(row.updated_at, now);
  const speed = stale ? null : formatSpeedKmh(row.speed_mps);
  return (
    <View style={styles.presence}>
      <Avatar path={avatarPath} name={initialOf || name} size={28} />
      <View style={styles.presenceText}>
        <Text style={styles.presenceName}>{name}</Text>
        <Text style={[styles.presenceMeta, stale && styles.staleText]}>
          {stale ? en.map.stale(age) : [speed, en.map.updated(age)].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background },
  content: { padding: 16, gap: 16 },
  loading: { marginTop: 48 },
  center: { padding: 20, gap: 12, alignItems: 'center' },
  goneTitle: { fontSize: 20, fontWeight: '600', color: colors.label },
  mapWrap: { height: 360, borderRadius: 12, borderCurve: 'continuous', overflow: 'hidden' },
  map: { flex: 1 },
  overlayButton: {
    position: 'absolute',
    bottom: 8,
    backgroundColor: colors.field,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  showMine: { left: 8 },
  // Top left: MapKit's own controls (compass, pitch toggle, user location button) stack in the top right
  // corner, and expo-maps 58 cannot move them. The scale bar (top left) is off by default.
  pen: { top: 8, bottom: undefined, left: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  recenter: { right: 8 },
  group: { gap: 8 },
  status: { fontSize: 17, fontWeight: '600', color: colors.label },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  switchLabel: { fontSize: 17, color: colors.label, flexShrink: 1 },
  link: { fontSize: 17, color: colors.tint },
  presence: {
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  presenceText: { flex: 1, gap: 2 },
  presenceName: { fontSize: 17, color: colors.label },
  presenceMeta: { fontSize: 14, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
  staleText: { color: colors.warning },
});
