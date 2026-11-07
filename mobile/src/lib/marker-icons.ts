import { Image, type ImageRef } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';

import { avatarUrl } from './avatar';
import { clearImageDiskCache } from './image-cache';
import { authHeaders } from './media';

/** The pin icon is drawn at 50 pt (expo-maps AppleMapsViewiOS18.swift); 96 px covers it at @2x. */
const ICON_MAX_PX = 96;

/**
 * M1: loads the profile photos for the map's photo pins as native image refs.
 *
 * One hook for all members (no hooks in a loop). Only photos for `wanted` paths (fresh pins of current
 * members) are returned; a ref for a path that left the set is never handed out again and is dropped
 * from state on the next load. Refs are not release()d by hand, since the native map may still hold
 * the previous annotation; dropped refs are garbage-collected. A failed load (no access before 0021,
 * not a co-member, room ended) is remembered for this screen, so the pin keeps its initials and the
 * load is not retried in a loop. The disk copy Image.loadAsync writes is cleared on unmount.
 */
export function useMarkerIcons(wanted: ReadonlySet<string>, accessToken: string | undefined) {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ImageRef>>(new Map());
  /** Paths loaded or loading for the current `wanted` set. */
  const requested = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const wantedRef = useRef(wanted);
  const unmounted = useRef(false);

  const wantedKey = [...wanted].sort().join('\n');

  useEffect(() => {
    wantedRef.current = wanted;
    for (const path of requested.current) {
      if (!wanted.has(path)) requested.current.delete(path);
    }
    if (!accessToken) return;
    for (const path of wanted) {
      if (requested.current.has(path) || failed.current.has(path)) continue;
      requested.current.add(path);
      Image.loadAsync(
        { uri: avatarUrl(path), headers: authHeaders(accessToken), cacheKey: path },
        { maxWidth: ICON_MAX_PX, maxHeight: ICON_MAX_PX },
      )
        .then((ref) => {
          // MK2: a load that finishes after unmount wrote a new disk copy; clear it and touch no state.
          if (unmounted.current) {
            clearImageDiskCache();
            return;
          }
          // Keep only refs for paths still wanted; this also drops refs of members who left.
          setLoaded((current) => {
            const keep = wantedRef.current;
            const next = new Map([...current].filter(([p]) => keep.has(p)));
            if (keep.has(path)) next.set(path, ref);
            return next;
          });
        })
        .catch(() => {
          if (unmounted.current) {
            clearImageDiskCache();
            return;
          }
          requested.current.delete(path);
          failed.current.add(path);
        });
    }
    // wantedKey stands for `wanted`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, accessToken]);

  // Unmount: clear the disk copies; loads still in flight clear again when they settle (MK2).
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      clearImageDiskCache();
    };
  }, []);

  // Never hand out a photo for a path that is no longer wanted.
  return useMemo(
    () => new Map([...loaded].filter(([path]) => wanted.has(path))) as ReadonlyMap<string, ImageRef>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, wantedKey],
  );
}
