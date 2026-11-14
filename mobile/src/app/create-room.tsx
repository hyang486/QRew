import { DatePicker, Host } from '@expo/ui/swift-ui';
import { dynamicTypeSize, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { PlacePinMap } from '@/components/place-time-cards';
import { defaultDraft, type QuestionPayload, validateQuestions } from '@/features/event/entry-questions';
import { useAnnounce } from '@/features/event/announce';
import { createBarLayout } from '@/features/event/create-bar';
import { QuestionEditor, questionProblemText } from '@/features/event/question-editor';
import { setEntryQuestions, setQrewingRoom } from '@/features/event/qrewing-api';
import { QCard, QField, QLabel, QLink, QScreen } from '@/components/q-screen';
import { Button, colors, Hint, radius } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import { createRoom, ROOM_TYPES, type RoomType } from '@/lib/rooms';
import { defaultRoomHours, formatDeletedAt } from '@/lib/create-defaults';
import {
  clampStart,
  MAX_PLACE_NAME,
  normalizePlaceName,
  pinAfterNameChange,
  pinAreaLabel,
  startTimeError,
  startTimeRange,
  type LatLng,
} from '@/lib/place-time';
import { useNow } from '@/lib/use-now';

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && { backgroundColor: colors.tint }]}
    >
      <Text style={[styles.chipText, selected && { color: colors.onTint }]}>{label}</Text>
    </Pressable>
  );
}

export default function CreateRoom() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [type, setType] = useState<RoomType>('sports');
  // #11: the length follows the type's default until the host picks one by hand.
  const [pickedHours, setPickedHours] = useState<number | null>(null);
  const hours = pickedHours ?? defaultRoomHours(type);
  const [locationAllowed, setLocationAllowed] = useState(true);
  const [statuses, setStatuses] = useState<string>(en.createRoom.statusesDefault);
  // Qrewing AI (spec 3.2): off by default for every type; entry info is offered for event rooms only.
  const [aiEnabled, setAiEnabled] = useState(false);
  const [entryRequired, setEntryRequired] = useState(false);
  // Spec 9.4: the host's entry questions, prefilled with the default four.
  const [questions, setQuestions] = useState(defaultDraft);
  const [questionProblem, setQuestionProblem] = useState<ReturnType<typeof validateQuestions> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // iOS VoiceOver ignores Hint's live region: each failure bumps the counter so a repeated identical error is read
  // again. Question problems skip it (QuestionEditor announces those), so one Create never speaks twice.
  const [failures, setFailures] = useState(0);
  useAnnounce(error, failures);
  function fail(message: string) {
    setError(message);
    setFailures((n) => n + 1);
  }
  // Place and time (0026), all optional: a place name, a pin found from the name (tap the map to move it) and a
  // start time. A pin is kept only while there is a place name (create_room rule).
  const [placeName, setPlaceName] = useState('');
  const [pin, setPin] = useState<LatLng | null>(null);
  const [finding, setFinding] = useState(false);
  const [placeNote, setPlaceNote] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<Date | null>(null);
  const [startNote, setStartNote] = useState<string | null>(null);
  // qa 5: where the pin is ("Los Angeles, CA"), so a first geocoder hit in the wrong city is easy to spot.
  // Kept with the pin it was looked up for, so a moved or dropped pin never shows an old area.
  const [pinLookup, setPinLookup] = useState<{ pin: LatLng; area: string | null } | null>(null);
  const pinArea = pin && pinLookup?.pin === pin ? pinLookup.area : null;
  // The picker's range starts when the screen opens, so a chosen start never falls below it as time passes
  // (the picker would then show a clamped time that differs from what is sent).
  const [openedAt] = useState(() => Date.now());

  // #11: refreshed every 5 s and shown without seconds, so the time stays current while the screen is open.
  const now = useNow(5_000);
  const expiresPreview = new Date(now + hours * 3_600_000);
  const startRange = { ...startTimeRange(expiresPreview.getTime(), now), start: new Date(openedAt) };
  const hasPlace = normalizePlaceName(placeName) !== null;

  // qa 3: a new room length moves a start time that no longer fits, and says so, so what the picker shows is
  // what is sent.
  function changeHours(nextHours: number) {
    const range = { ...startTimeRange(now + nextHours * 3_600_000, now), start: new Date(openedAt) };
    const { startsAt: clamped, moved } = clampStart(startsAt, range);
    setStartsAt(clamped);
    setStartNote(moved ? en.createRoom.startMoved : null);
  }

  function pickType(t: RoomType) {
    setType(t);
    if (pickedHours === null) changeHours(defaultRoomHours(t));
  }

  function pickHours(h: number) {
    setPickedHours(h);
    changeHours(h);
  }

  // qa 4: any edit of the name drops the pin, so Find on map shows again for the new name.
  function changePlaceName(text: string) {
    setPin((current) => pinAfterNameChange(current, placeName, text));
    setPlaceName(text);
    setPlaceNote(null);
  }

  useEffect(() => {
    if (!pin) return;
    let live = true;
    // Apple reverse geocoding (no location permission). On failure nothing is shown.
    Location.reverseGeocodeAsync(pin)
      .then(([address]) => live && setPinLookup({ pin, area: pinAreaLabel(address) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pin]);

  async function findOnMap() {
    const query = normalizePlaceName(placeName);
    if (!query) return;
    setFinding(true);
    setPlaceNote(null);
    try {
      // iOS geocodes with Apple (CLGeocoder); no location permission needed.
      const [hit] = await Location.geocodeAsync(query);
      if (hit) setPin({ latitude: hit.latitude, longitude: hit.longitude });
      else setPlaceNote(en.createRoom.notFound);
    } catch {
      setPlaceNote(en.createRoom.findFailed);
    } finally {
      setFinding(false);
    }
  }

  function addStartTime() {
    // Default: the next full hour, kept inside the picker's range.
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    setStartsAt(clampStart(next, startRange).startsAt);
    setStartNote(null);
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      fail(en.createRoom.nameRequired);
      return;
    }
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    const startProblem = startTimeError(startsAt, expiresAt.getTime(), Date.now());
    if (startProblem) {
      fail(startProblem === 'afterClose' ? en.createRoom.startAfterClose : en.createRoom.startTooEarly);
      return;
    }
    const askEntry = aiEnabled && type === 'event' && entryRequired;
    let payload: QuestionPayload[] = [];
    if (askEntry) {
      const checked = validateQuestions(questions);
      if ('problem' in checked) {
        setQuestionProblem(checked);
        const n = questions.findIndex((q) => q.key === checked.key) + 1;
        setError(questionProblemText(checked.problem, n || null));
        return;
      }
      payload = checked.value;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom({
        name: trimmed,
        type,
        expiresAt,
        locationAllowed,
        placeName,
        pin,
        startsAt,
        statuses: statuses
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      // A failed Qrewing save never blocks the room; the chat screen shows the note once.
      let aiNote: string | undefined;
      let questionsNote: string | undefined;
      if (aiEnabled) {
        // Spec 9.2 order: questions first, since entry_required needs at least one. If they fail, entry stays off.
        let entry = askEntry;
        if (entry) {
          const saved = await setEntryQuestions(room.id, payload);
          if ('error' in saved) {
            entry = false;
            questionsNote = saved.error === 'locked' ? en.qrewing.create.questionsLocked : en.qrewing.create.questionsSaveFailed;
          }
        }
        const res = await setQrewingRoom(room.id, true, entry);
        if (res.error) aiNote = '1';
      }
      router.replace({ pathname: '/room/[id]', params: aiNote ? { id: room.id, aiNote } : { id: room.id } });
      router.push({ pathname: '/room/[id]/invite', params: { id: room.id } });
      if (questionsNote) Alert.alert(questionsNote);
    } catch (e) {
      fail(errorMessage(e));
      setBusy(false);
    }
  }

  // Qrew Q 02.02 (human placement B): name, Room type chips, Room closes after chips (4 and 7 days as extra
  // chips, no Custom), the deletion line, the Plus preview link under it, the location card with its switch
  // and hint, the Status options card (editable), Create room pinned at the bottom. Place and time unit (0026):
  // the optional meeting place and time card sits under the Plus link. UI audit 2026-11-13 item 8 (qa, human "fix
  // all"): the location and Qrewing AI switches with their hints moved up, right under Room type.
  return (
    <QScreen
      title={en.createRoom.title}
      actions={
        // E2E (i): hairline at the scroll edge and a non-tappable gap, so a tap on a clipped switch never hits Create.
        <View style={styles.bar}>
          {error ? <Hint tone="error">{error}</Hint> : null}
          <Button title={en.createRoom.submit} onPress={submit} busy={busy} />
        </View>
      }
    >
      <QField
        label={en.createRoom.nameLabel}
        value={name}
        onChangeText={setName}
        maxLength={60}
        autoFocus
        returnKeyType="done"
      />

      <QLabel>{en.createRoom.typeLabel}</QLabel>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={en.createRoom.typeLabel}>
        {ROOM_TYPES.map((t) => (
          <Choice key={t} label={en.rooms.types[t]} selected={type === t} onPress={() => pickType(t)} />
        ))}
      </View>

      {/* UI audit item 8: the location and AI switches (with their helper lines) sit right under Room type, so
          both helpers show without scrolling on a 402x874 pt phone at the default text size. */}
      <QCard row>
        <Text style={styles.cardTitle}>{en.createRoom.locationLabel}</Text>
        <Switch
          value={locationAllowed}
          onValueChange={setLocationAllowed}
          accessibilityLabel={en.createRoom.locationLabel}
        />
      </QCard>
      <Hint>{en.createRoom.locationHint}</Hint>

      <QCard row>
        <Text style={styles.cardTitle}>{en.qrewing.create.aiLabel}</Text>
        <Switch value={aiEnabled} onValueChange={setAiEnabled} accessibilityLabel={en.qrewing.create.aiLabel} />
      </QCard>
      <Hint>{en.qrewing.create.aiHint}</Hint>
      {aiEnabled && type === 'event' ? (
        <>
          <QCard row>
            <Text style={styles.cardTitle}>{en.qrewing.create.entryLabel}</Text>
            <Switch
              value={entryRequired}
              onValueChange={setEntryRequired}
              accessibilityLabel={en.qrewing.create.entryLabel}
            />
          </QCard>
          <Hint>{en.qrewing.create.entryHint}</Hint>
          {entryRequired ? (
            <QuestionEditor
              value={questions}
              onChange={(next) => {
                setQuestions(next);
                setQuestionProblem(null);
              }}
              problem={questionProblem && 'problem' in questionProblem ? questionProblem : null}
            />
          ) : null}
        </>
      ) : null}

      <QLabel>{en.createRoom.expiryLabel}</QLabel>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={en.createRoom.expiryLabel}>
        {en.createRoom.expiryOptions.map((o) => (
          <Choice key={o.hours} label={o.label} selected={hours === o.hours} onPress={() => pickHours(o.hours)} />
        ))}
      </View>
      <Text style={styles.deletes}>{en.createRoom.expiryHint(formatDeletedAt(expiresPreview.getTime()))}</Text>
      <Pressable accessibilityRole="link" onPress={() => router.push('/plan-preview')} hitSlop={8}>
        <Text style={styles.planLink}>{en.planPreview.createRoomLink}</Text>
      </Pressable>

      <QLabel>{en.createRoom.placeTimeLabel}</QLabel>
      <QField
        label={en.createRoom.placeLabel}
        placeholder={en.createRoom.placePlaceholder}
        value={placeName}
        onChangeText={changePlaceName}
        maxLength={MAX_PLACE_NAME}
        returnKeyType="search"
        onSubmitEditing={findOnMap}
      />
      {hasPlace && !pin ? (
        <QLink title={finding ? en.createRoom.finding : en.createRoom.findOnMap} onPress={findOnMap} disabled={finding} />
      ) : null}
      {placeNote ? <Hint>{placeNote}</Hint> : null}
      {hasPlace && pin ? (
        <>
          <PlacePinMap pin={pin} title={normalizePlaceName(placeName) ?? undefined} onMapClick={setPin} />
          {pinArea ? <Text style={styles.pinArea}>{pinArea}</Text> : null}
          <Text style={styles.cardNote}>{en.createRoom.pinHint}</Text>
          <QLink title={en.createRoom.removePin} onPress={() => setPin(null)} />
        </>
      ) : null}
      {startsAt ? (
        <QCard>
          {/* qa 1: the label sits above, and date and time are two compact pickers that wrap onto two rows when
              they do not fit side by side. Their Dynamic Type is capped at xxxLarge so each stays inside the card
              on a 390 pt screen at the largest text size. */}
          <Text style={styles.cardTitle} maxFontSizeMultiplier={1.5}>
            {en.createRoom.startTimeLabel}
          </Text>
          <View style={styles.pickers}>
            {(['date', 'hourAndMinute'] as const).map((part) => (
              <Host key={part} matchContents>
                <DatePicker
                  title={en.createRoom.startTimeLabel}
                  selection={startsAt}
                  range={startRange}
                  displayedComponents={[part]}
                  onDateChange={(d) => {
                    setStartsAt(d);
                    setStartNote(null);
                  }}
                  modifiers={[labelsHidden(), dynamicTypeSize({ max: 'xxxLarge' })]}
                />
              </Host>
            ))}
          </View>
          {/* Human decision: the "start moved" note sits right under the pickers, inside the card, so the pinned
              Create room button never covers it. */}
          {startNote ? <Hint>{startNote}</Hint> : null}
          <QLink
            title={en.createRoom.removeStartTime}
            onPress={() => {
              setStartsAt(null);
              setStartNote(null);
            }}
          />
        </QCard>
      ) : (
        <QLink title={en.createRoom.addStartTime} onPress={addStartTime} />
      )}

      <QCard>
        <Text style={styles.cardTitle}>{en.createRoom.statusesLabel}</Text>
        <TextInput
          value={statuses}
          onChangeText={setStatuses}
          accessibilityLabel={en.createRoom.statusesLabel}
          accessibilityHint={en.createRoom.statusesHint}
          style={styles.statuses}
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
        />
        <Text style={styles.cardNote}>{en.createRoom.statusesHint}</Text>
      </QCard>
    </QScreen>
  );
}

const styles = StyleSheet.create({
  bar: { ...createBarLayout, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  planLink: { fontSize: 15, color: colors.tint, textDecorationLine: 'underline' },
  deletes: { fontSize: 14, color: colors.label, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.field,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  chipText: { fontSize: 15, color: colors.label },
  cardTitle: { flex: 1, fontSize: 16, color: colors.label },
  statuses: { fontSize: 14, color: colors.secondaryLabel, paddingVertical: 2 },
  cardNote: { fontSize: 12, color: colors.secondaryLabel },
  pinArea: { fontSize: 14, color: colors.label },
  pickers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
