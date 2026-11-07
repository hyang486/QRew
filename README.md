# QRew

The app is still called "Moment" inside the code (working name). Temporary group rooms (QR or 5-digit code) with chat, original-quality media sharing, room-scoped face matching, arrival notices, opt-in location, Emergency status, and server-side deletion when a room ends. iOS first.

## Layout

- `mobile/`: Expo app (SDK 58, Expo Router). Native folders (`ios/`, `android/`) are generated and not committed.
- `supabase/migrations/`: SQL migrations (every table has RLS).
- `supabase/functions/`: Edge Functions `face-match`, `delete-account`, `room-janitor`.
- `supabase/tests/`, `mobile/tests/`: SQL and unit tests.

## Run on iOS

The app uses native modules (for example `expo-maps`), so it runs as a development build, not in Expo Go.

```bash
cd mobile
cp .env.example .env.local   # fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
npm install
npx expo run:ios                 # simulator; add --device for a connected iPhone
npx expo start --dev-client      # later runs
```

Checks: `npx tsc --noEmit`, `npx expo lint`, `npm test`.

## Server

Apply `supabase/migrations/` in order and deploy the three functions. `face-match` needs the Edge Function secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`, and calls AWS only while `FACE_MATCH_ENABLED` is exactly `true`. Never put secrets in the app or in `EXPO_PUBLIC_` variables.
