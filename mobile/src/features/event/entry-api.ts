// Entry info (spec 1.3): read and upsert through the room-scoped table and RPC.

import { supabase } from '@/lib/supabase';

import type { EntryInput } from './event-plan';
import { saveErrorKind } from './qrewing-plan';
import type { EntryProfileRow } from './types';


export async function getEntryProfile(roomId: string, userId: string): Promise<EntryProfileRow | null> {
  const { data, error } = await supabase
    .from('entry_profiles')
    .select('*')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Everyone's entry info in the room (members can read each other's; the form says so). */
export async function listEntryProfiles(roomId: string): Promise<EntryProfileRow[]> {
  const { data, error } = await supabase.from('entry_profiles').select('*').eq('room_id', roomId);
  if (error) throw error;
  return data ?? [];
}

export async function saveEntryProfile(roomId: string, entry: EntryInput): Promise<{ error?: string; offline?: boolean }> {
  const { error } = await supabase.rpc('upsert_entry_profile', {
    p_room_id: roomId,
    p_headline: entry.headline,
    p_interests: entry.interests,
    p_looking_for: entry.lookingFor,
    p_links: entry.links,
  });
  return error ? { error: error.message, offline: saveErrorKind(error) === 'network' } : {};
}
