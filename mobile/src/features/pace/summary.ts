import { liveSessions } from './engine';
import { type PaceSummary, recapParts, summaryWithLive } from './pace-core';
import { loadHistory } from './storage';
import { en } from '@/i18n/en';
const t = en.pace;

export type ActivitySummary = PaceSummary;

/**
 * For the recap (features/recap, spec 3.3): my latest pace-maker session in this room, or null when I did not
 * use the pace maker there, ran under 100 m, or the history cannot be read (never rejects). Meters, moving
 * seconds (durationS), seconds first to last fix with stops (elapsedS), and seconds per km of moving time.
 * On this device only. A run still in memory counts (the host's recap runs right after end_room, before the Map
 * screen's save on stop or unmount has finished).
 */
export async function getActivitySummary(roomId: string): Promise<ActivitySummary | null> {
  return summaryWithLive(await loadHistory(), liveSessions(roomId), roomId);
}

/** The recap's pace line ("Pace maker: 2.40 km, moving 12:00, total 17:00, 5:00 per km"), or null with no session. */
export function paceRecapLine(summary: ActivitySummary | null | undefined): string | null {
  const p = recapParts(summary);
  return p ? t.recap(p.distanceM, p.moving, p.total, p.pace) : null;
}
