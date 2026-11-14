import type { PostgrestError } from '@supabase/supabase-js';

import { en } from '@/i18n/en';

import type { Database, Tables } from './database.types';
import type { Invite } from './invite';
import { placeTimeArgs, type LatLng } from './place-time';
import { verifyAccount } from './auth';
import { supabase } from './supabase';

export type Room = Tables<'rooms'>;
export type RoomPreview = Database['public']['Functions']['preview_room']['Returns'][number];
export type RoomType = 'sports' | 'event' | 'waiting' | 'general';
export type RoomMember = Tables<'room_members'> & { display_name: string; avatar_path: string | null };

export const ROOM_TYPES: RoomType[] = ['sports', 'event', 'waiting', 'general'];

/** Server limits from create_room / update_room_expiry. */
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export { REMINDER_WINDOW_MS } from './expiry-plan';

export { inviteUrl, isValidCode, isValidToken, parseInvite, type Invite } from './invite';

function inviteArgs(invite: Invite) {
  return 'code' in invite ? { p_code: invite.code } : { p_token: invite.token };
}

/** A join/preview failure with copy that is safe to show as-is. */
export class RoomError extends Error {
  constructor(
    public kind: 'invalid' | 'throttled' | 'full' | 'account' | 'other',
    message: string,
  ) {
    super(message);
  }
}

// join_room/preview_room raise PT429 (throttle) and PT409 (full); PostgREST passes the SQLSTATE as `code`.
function toRoomError(error: PostgrestError) {
  if (error.code === 'PT429') return new RoomError('throttled', en.rooms.errors.throttled);
  if (error.code === 'PT409') return new RoomError('full', en.rooms.errors.full);
  // 23503 (room_members_user_id_fkey): the JWT is for an account that no longer exists.
  if (error.code === '23503') {
    verifyAccount();
    return new RoomError('account', en.rooms.errors.account);
  }
  return new RoomError('other', error.message || en.errors.generic);
}

export async function previewRoom(invite: Invite): Promise<RoomPreview> {
  const { data, error } = await supabase.rpc('preview_room', inviteArgs(invite));
  if (error) throw toRoomError(error);
  const preview = data?.[0];
  if (!preview) throw new RoomError('invalid', en.rooms.errors.invalid);
  return preview;
}

/** Joins and returns the room id. join_room returns null for an invalid, ended or expired invite. */
export async function joinRoom(invite: Invite): Promise<string> {
  const { data, error } = await supabase.rpc('join_room', inviteArgs(invite));
  if (error) throw toRoomError(error);
  if (!data) throw new RoomError('invalid', en.rooms.errors.invalid);
  return data;
}

export async function createRoom(input: {
  name: string;
  type: RoomType;
  expiresAt: Date;
  locationAllowed: boolean;
  statuses: string[];
  /** Optional (0026). Empty name, no pin and no start time → the same call as before. */
  placeName?: string;
  pin?: LatLng | null;
  startsAt?: Date | null;
}): Promise<Room> {
  const { data, error } = await supabase.rpc('create_room', {
    p_name: input.name,
    p_type: input.type,
    p_expires_at: input.expiresAt.toISOString(),
    p_location_allowed: input.locationAllowed,
    p_statuses: input.statuses,
    ...placeTimeArgs({ placeName: input.placeName ?? '', pin: input.pin ?? null, startsAt: input.startsAt ?? null }),
  });
  if (error) throw error;
  return data;
}

/** Rooms the user can still open. RLS hides rooms that expired, ended, or that the user left. */
export async function listMyRooms(): Promise<Room[]> {
  const { data, error } = await supabase.from('rooms').select('*').order('expires_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** Null when the room is gone or no longer accessible (expired, ended, left). */
export async function getRoom(roomId: string): Promise<Room | null> {
  const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Who marked Arrived in the room, in any activity (Room info, Q 03.03; E2E c: a restarted activity does not reset
 * arrivals). A plain read under the existing arrivals_select policy (room members only). mark_arrived writes one
 * row per activity_seq, so a user can appear more than once; arrivedMemberCount counts each person once.
 */
export async function listArrivedIds(roomId: string): Promise<string[]> {
  const { data, error } = await supabase.from('arrivals').select('user_id').eq('room_id', roomId);
  if (error) throw error;
  return data.map((r) => r.user_id);
}

export async function listMembers(roomId: string): Promise<RoomMember[]> {
  const { data: members, error } = await supabase
    .from('room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (error) throw error;
  const ids = members.map((m) => m.user_id);
  const { data: profiles, error: profileError } = ids.length
    ? await supabase.from('profiles').select('id, display_name, avatar_path').in('id', ids)
    : { data: [], error: null };
  if (profileError) throw profileError;
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return members.map((m) => ({
    ...m,
    display_name: byId.get(m.user_id)?.display_name ?? en.rooms.someone,
    avatar_path: byId.get(m.user_id)?.avatar_path ?? null,
  }));
}

export async function leaveRoom(roomId: string) {
  const { error } = await supabase.rpc('leave_room', { p_room_id: roomId });
  if (error) throw error;
}

export async function endRoom(roomId: string) {
  const { error } = await supabase.rpc('end_room', { p_room_id: roomId });
  if (error) throw error;
}

export async function rotateInvite(roomId: string) {
  const { data, error } = await supabase.rpc('rotate_invite', { p_room_id: roomId });
  if (error) throw error;
  return data[0];
}

/** "3d 4h", "5h 12m", "12m", "<1m". */
export function formatRemaining(ms: number) {
  if (ms <= 0) return en.rooms.ended;
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return '<1m';
}
