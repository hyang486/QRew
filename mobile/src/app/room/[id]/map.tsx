import { AppleMaps, type CameraMoveEvent } from 'expo-maps';
import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { HandTitle } from '@/components/hand-title';
import { EmergencyAlerts } from '@/components/room-activity';
import { RoomEnded } from '@/components/room-ended';
import { RouteEditor } from '@/components/route-editor';
import { Button, colors, Hint, radius } from '@/components/ui';
import { QrewingFab } from '@/features/event/qrewing-fab';
import { PaceCard } from '@/features/pace/pace-card';
import { PaceLayer } from '@/features/pace/pace-layer';
import { en } from '@/i18n/en';
import { useRoomActivity } from '@/lib/activity';
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
  formatRouteKm,
  formatSpeedKmh,
  isStale,
  labelPins,
  memberStatusLabels,
  type LatLng,
  MAX_CAMERA_ZOOM,
  parseRoute,
  type PinInput,
  planLabels,
  planPins,
  ROOM_MAP_SIZE,
  ROUTE_LINE_WIDTH,
  stalePinId,
  type Viewport,
  viewportFromCamera,
  viewportFromRegion,
  type ViewSize,
  wantedIconPaths,
} from '@/lib/location-plan';
import { useMarkerIcons } from '@/lib/marker-icons';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, listMembers, type Room } from '@/lib/rooms';
import { editorStartCamera } from '@/lib/route-editor-plan';
import { useNow } from '@/lib/use-now';
import { useRoomOver } from '@/lib/use-room-over';

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
/** Gap under the bottom map buttons. */
const OVERLAY_BOTTOM = 8;
// #1: an Emergency sender's pin and pill (fixed system red, readable on light and dark maps).
const EMERGENCY_RED = '#FF3B30';
const EMERGENCY_TEXT = '#FFFFFF';

export default function RoomMapScreen() {
  // focus: an Emergency sender to center on (Q 04.04 "Open last shared location" from chat, Photos or Info).
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
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

  // G-U6-1: the room's end time passing while Map is open (the host's End arrives as a rooms notice above).
  const ended = useRoomOver(state.status === 'ready' ? state.room : null);

  if (state.status === 'loading') return <ActivityIndicator style={styles.loading} />;
  // Q 06.04: the row is gone, so no closed-at time is known.
  if (state.status === 'gone') return <RoomEnded />;
  // No stale map, pins or sharing controls once the room is over.
  if (state.status === 'ready' && ended.over) return <RoomEnded room={state.room} nowMs={ended.nowMs} />;
  if (state.status === 'error') {
    return (
      <View style={styles.center}>
        <Hint tone="error">{state.message}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </View>
    );
  }
  return <RoomMap room={state.room} names={state.names} avatars={state.avatars} focus={focus} />;
}

function RoomMap({
  room,
  names,
  avatars,
  focus,
}: {
  focus?: string;
  room: Room;
  names: Map<string, string>;
  avatars: Map<string, string | null>;
}) {
  const { session } = useAuth();
  const router = useRouter();
  const userId = session?.user.id;
  const isHost = room.host_id === userId;
  const now = useNow(15_000);
  const mapRef = useRef<AppleMaps.MapView>(null);

  const allowed = room.location_allowed;
  const active = allowed && room.activity_state === 'active';

  const my = useMyShare(room.id, userId);
  // #1: open Emergencies show on Map too (banner above the map, red pin and pill for the sender).
  const activity = useRoomActivity(room.id, userId, room.activity_seq);
  const emergencyPinIds = new Set(activity.emergencies.flatMap((e) => [e.userId, stalePinId(e.userId)]));
  // #2: each member's current status, on their pill line and in their "Sharing now" row.
  const statusOf = memberStatusLabels(activity.memberStatus, activity.statuses);
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
  // #10: the route length on the map (top left, after Pen); hidden with fewer than 2 points.
  const routeKm = useMemo(() => formatRouteKm(shownRoute), [shownRoute]);

  // F5-5b: the map's real size once it is laid out (the fit and the label grouping measure against it).
  const [mapSize, setMapSize] = useState<ViewSize>(ROOM_MAP_SIZE);
  // Height of the bottom map buttons (Show my location / Recenter); the Ask Qrewing button floats above them.
  const [overlayHeight, setOverlayHeight] = useState(34);
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
    status: statusOf.get(row.user_id) ?? null,
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
            ...(emergencyPinIds.has(pin.id) ? { tintColor: EMERGENCY_RED } : {}),
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
    shownRoute,
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

  // Q 04.04: "Open last shared location" centers on the Emergency sender's last position. Opened from another
  // screen (focus param), it centers once when that row arrives (an imperative move right after mount can be
  // rejected, F5-4, so the camera prop is set too).
  function focusOn(coordinates: LatLng) {
    mapRef.current?.setCameraPosition({ coordinates, zoom: MAX_CAMERA_ZOOM }).catch(() => {});
  }
  const focusRow = focus ? presence.rows.find((r) => r.user_id === focus) : undefined;
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusRow) return;
    focused.current = true;
    const coordinates = { latitude: focusRow.lat, longitude: focusRow.lng };
    // Both: the prop covers a map that is not ready yet, the call a map that already applied its first camera.
    centeredOn.current = 'points';
    setInitialCamera({ coordinates, zoom: MAX_CAMERA_ZOOM });
    focusOn(coordinates);
  }, [focusRow]);

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
    // Qrew unit 4 (Q 03.04): a confirm screen that states the effects, instead of an alert.
    router.push({ pathname: '/room/[id]/end-activity', params: { id: room.id } });
  }

  function openEditor() {
    // UI v2 (2): never the world view; with no room points or my position, a regional default.
    setEditor({
      start: editorStartCamera({
        lastView: lastView.current,
        roomCamera: camera,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
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
  // G4 (#5): pills keep off the drawn route when a clear spot exists.
  const labels = planLabels(labelInputs, labelView, mapSize, shownRoute);
  const photoPins = pins.flatMap((pin) =>
    pin.kind === 'photo' ? [{ id: pin.id, coordinates: pin.coordinates, icon: pin.icon }] : [],
  );
  const annotations = [
    ...photoPins,
    ...labels.map((label) => {
      const emergency = label.members.some((m) => emergencyPinIds.has(m));
      return {
        // A new id when the color changes, so the native annotation is redrawn rather than kept as it was.
        id: emergency ? `${label.id}:emergency` : label.id,
        coordinates: label.coordinates,
        text: label.text,
        anchor: label.anchor,
        backgroundColor: emergency ? EMERGENCY_RED : LABEL_BACKGROUND,
        textColor: emergency ? EMERGENCY_TEXT : label.stale ? LABEL_STALE_TEXT : LABEL_TEXT,
      };
    }),
  ];

  // Own position on the map only when the permission is already granted and Share or Show my location is on.
  // Nothing here asks for the permission (only the Share switch and Show my location do).
  const showsMyLocation = granted === true && (my.share || showingMine);

  const reporterText = en.map.reporter[sharingState];
  const reporterIsError = sharingState === 'error' || sharingState === 'no-permission' || sharingState === 'refused';

  return (
    // Qrewing pace maker: its cue banner and stationary sheet sit over the scroll view (PaceLayer).
    <View style={styles.root}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
      <Stack.Screen options={{ title: en.map.title, headerTitle: '' }} />
      {/* Qrew unit 4 (Q 04.02, 08.03): handwritten title and the room name; no art on the map. */}
      <View style={styles.head}>
        <HandTitle>{en.map.title}</HandTitle>
        <Text style={styles.roomName} numberOfLines={2}>
          {room.name}
        </Text>
      </View>
      <EmergencyAlerts
        roomId={room.id}
        activity={activity}
        userId={userId}
        names={names}
        presence={presence.rows}
        onOpenLocation={(_sender, coordinates) => focusOn(coordinates)}
      />

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
              ? [{ id: 'route', coordinates: shownRoute, color: ROUTE_COLOR, width: ROUTE_LINE_WIDTH }]
              : []
          }
          properties={{ isMyLocationEnabled: showsMyLocation }}
          onCameraMove={onCameraMove}
        />
        <Pressable
              accessibilityRole="button"
              accessibilityLabel={en.map.showMine}
              accessibilityState={{ busy: locate === 'busy' }}
              onPress={showMyLocation}
              style={[styles.overlayButton, styles.showMine]}
              onLayout={(e) => setOverlayHeight(e.nativeEvent.layout.height)}
            >
              <Text style={styles.link} numberOfLines={1} maxFontSizeMultiplier={MAP_OVERLAY_MAX_SCALE}>{locate === 'busy' ? en.map.locating : en.map.showMine}</Text>
            </Pressable>
            {camera ? (
              <Pressable accessibilityRole="button" onPress={recenter} style={[styles.overlayButton, styles.recenter]}>
                <Text style={styles.link} numberOfLines={1} maxFontSizeMultiplier={MAP_OVERLAY_MAX_SCALE}>{en.map.recenter}</Text>
              </Pressable>
            ) : null}
        {isHost || routeKm ? (
          // Top left: Edit / Draw route (host, the plan's Pen), then the route length. A row, so the length never covers Pen.
          <View style={styles.topLeft}>
            {isHost ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={savedRoute.length > 0 ? en.map.editRoute : en.map.drawRoute}
                onPress={openEditor}
                style={[styles.chip, styles.pen]}
              >
                <SymbolView name="pencil.tip" size={18} tintColor={colors.tint} />
                <Text style={styles.link} numberOfLines={1} maxFontSizeMultiplier={MAP_OVERLAY_MAX_SCALE}>
                  {savedRoute.length > 0 ? en.map.editRoute : en.map.drawRoute}
                </Text>
              </Pressable>
            ) : null}
            {routeKm ? (
              <View style={[styles.chip, styles.distanceChip]}>
                <Text style={styles.distance} numberOfLines={1} maxFontSizeMultiplier={MAP_OVERLAY_MAX_SCALE}>{en.map.routeDistance(routeKm)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {/* qa: on the map, above Recenter, so the floating Q never covers the status text below the map. UI audit
            item 1: the offset follows the bottom buttons' measured height (Dynamic Type), with a full margin gap. */}
        <QrewingFab roomId={room.id} bottom={OVERLAY_BOTTOM + overlayHeight} />
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
            // Unit 4 F2 (work list B, Map host): Start / End activity is a card under the map, like Allow sharing.
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: busy === 'activity', disabled: busy === 'activity' }}
              disabled={busy === 'activity'}
              onPress={toggleActivity}
              style={({ pressed }) => [styles.switchRow, styles.cardRow, pressed && styles.pressed]}
            >
              <Text style={styles.switchLabel}>{active ? en.map.endActivity : en.map.startActivity}</Text>
              {busy === 'activity' ? (
                <ActivityIndicator />
              ) : (
                <SymbolView name="chevron.right" size={14} weight="semibold" tintColor={colors.secondaryLabel} />
              )}
            </Pressable>
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

      <PaceCard room={room} share={my.share} />

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
              status={statusOf.get(row.user_id) ?? null}
              emergency={emergencyPinIds.has(row.user_id)}
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
          roomName={room.name}
          savedRoute={savedRoute}
          startCamera={editor.start}
          saving={busy === 'route'}
          showsMyLocation={showsMyLocation}
          memberMarkers={markers}
          memberPhotos={photoPins}
          onCancel={() => setEditor(null)}
          onSave={saveEdited}
        />
      ) : null}
      </ScrollView>
      <PaceLayer roomId={room.id} />
    </View>
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
  status,
  emergency,
  now,
}: {
  row: Presence;
  name: string;
  initialOf: string;
  avatarPath: string | null;
  status: string | null;
  emergency: boolean;
  now: number;
}) {
  const age = formatAge(row.updated_at, now);
  const stale = isStale(row.updated_at, now);
  const speed = stale ? null : formatSpeedKmh(row.speed_mps);
  return (
    <View style={styles.presence}>
      <Avatar path={avatarPath} name={initialOf || name} size={28} />
      <View style={styles.presenceText}>
        <Text style={styles.presenceName}>
          {name}
          {status ? <Text style={[styles.presenceStatus, emergency && styles.emergencyText]}>{` · ${status}`}</Text> : null}
        </Text>
        <Text style={[styles.presenceMeta, stale && styles.staleText]}>
          {stale ? en.map.stale(age) : [speed, en.map.updated(age)].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </View>
  );
}

// The buttons and chips on the 360 pt map stay on one line at the largest text sizes, so "Show my location" and
// "Recenter" never overlap (qa, largest Dynamic Type). The screen text around the map still scales fully.
const MAP_OVERLAY_MAX_SCALE = 1.3;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 16 },
  // Qrew unit 4: the QScreen head (title, gray room name under it) inside the map's own scroll view.
  head: { gap: 4, marginBottom: -4 },
  roomName: { fontSize: 15, color: colors.secondaryLabel },
  loading: { marginTop: 48 },
  center: { padding: 20, gap: 12, alignItems: 'center' },
  mapWrap: { height: 360, borderRadius: 12, borderCurve: 'continuous', overflow: 'hidden' },
  map: { flex: 1 },
  overlayButton: {
    position: 'absolute',
    bottom: OVERLAY_BOTTOM,
    backgroundColor: colors.field,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  showMine: { left: 8 },
  // Top left: MapKit's own controls (compass, pitch toggle, user location button) stack in the top right
  // corner, and expo-maps 58 cannot move them. The scale bar (top left) is off by default. Pen and the
  // route length sit in one row inside the top overlay band (ROOM_MAP_PADDING.top keeps the fit clear of it).
  topLeft: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    pointerEvents: 'box-none',
  },
  chip: { backgroundColor: colors.field, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  pen: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  distanceChip: { flexShrink: 1, pointerEvents: 'none' },
  distance: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: colors.label, fontVariant: ['tabular-nums'] },
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
  cardRow: { minHeight: 52, gap: 12 },
  pressed: { opacity: 0.6 },
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
  presenceStatus: { color: colors.secondaryLabel },
  emergencyText: { color: EMERGENCY_RED, fontWeight: '600' },
});
