import { AppleMaps } from 'expo-maps';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MapsSheet } from '@/components/maps-sheet';
import { QRowCard } from '@/components/q-row-card';
import { colors } from '@/components/ui';
import { en } from '@/i18n/en';
import type { LatLng, PlaceTime } from '@/lib/place-time';

const PIN_ZOOM = 15;

/**
 * A map centred on the meeting pin. Read-only (no pan or zoom: it sits inside a scrolling screen) unless
 * onMapClick is given, as on Create room where a tap moves the pin.
 */
export function PlacePinMap({
  pin,
  title,
  caption,
  onMapClick,
}: {
  pin: LatLng;
  title?: string;
  caption?: string;
  onMapClick?: (coordinates: LatLng) => void;
}) {
  return (
    <View style={styles.mapCard}>
      <View style={StyleSheet.absoluteFill} pointerEvents={onMapClick ? 'auto' : 'none'}>
        <AppleMaps.View
          // A new key re-centres the camera when the pin moves (cameraPosition applies once per mount).
          key={`${pin.latitude},${pin.longitude}`}
          style={StyleSheet.absoluteFill}
          cameraPosition={{ coordinates: pin, zoom: PIN_ZOOM }}
          markers={[{ id: 'place', coordinates: pin, title }]}
          onMapClick={
            onMapClick
              ? (e) => {
                  const { latitude, longitude } = e.coordinates;
                  if (latitude !== undefined && longitude !== undefined) onMapClick({ latitude, longitude });
                }
              : undefined
          }
        />
      </View>
      {caption ? (
        <Text style={styles.mapCaption} pointerEvents="none">
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

function formatDay(d: Date) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(d: Date) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** One line for the Rooms list: "North Gate · Sat, Nov 14, 9:00 AM". */
export function placeTimeLine(pt: PlaceTime) {
  const when = pt.startsAt
    ? pt.startsAt.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
  return [pt.placeName, when].filter(Boolean).join(' · ');
}

/**
 * Q 01.04: map (when there is a pin) → place card with Open in Maps → date and time card. Each part renders only
 * when set, so a room without place and time shows no empty cards.
 */
export function PlaceTimeCards({ placeTime }: { placeTime: PlaceTime }) {
  const { placeName, pin, startsAt } = placeTime;
  const [sheetOpen, setSheetOpen] = useState(false);
  const openInMaps = () => setSheetOpen(true);
  return (
    <>
      <MapsSheet target={sheetOpen && placeName ? { placeName, pin } : null} onClose={() => setSheetOpen(false)} />
      {placeName && pin ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${placeName}, ${en.placeTime.mapCaption}`}
          accessibilityHint={en.placeTime.openInMaps}
          onPress={openInMaps}
        >
          <PlacePinMap pin={pin} title={placeName} caption={en.placeTime.mapCaption} />
        </Pressable>
      ) : null}
      {placeName ? (
        <QRowCard
          icon="mappin.circle"
          title={placeName}
          subtitle={en.placeTime.openInMaps}
          accessibilityLabel={placeName}
          accessibilityHint={en.placeTime.openInMaps}
          onPress={openInMaps}
        />
      ) : null}
      {startsAt ? (
        <QRowCard
          icon="clock"
          title={formatDay(startsAt)}
          subtitle={`${formatTime(startsAt)} · ${en.placeTime.localTime}`}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  mapCard: {
    height: 200,
    borderRadius: 16,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: colors.field,
  },
  mapCaption: {
    position: 'absolute',
    left: 12,
    bottom: 10,
    fontSize: 12,
    color: colors.secondaryLabel,
    backgroundColor: colors.field,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
});
