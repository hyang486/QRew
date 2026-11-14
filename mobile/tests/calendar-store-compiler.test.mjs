// Run: npm test. The Qrewing Calendar store hooks must re-read the module store on every render even after the
// React Compiler (app.json experiments.reactCompiler) memoizes them. Root cause of the 2026-11-13 stuck spinner:
// `uid ? plus.get(uid) : null` was cached on `uid`, so the re-render after loadPlus() returned the stale null.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

function compiled() {
  const src = readFileSync(new URL('../src/features/calendar/calendar-store.ts', import.meta.url), 'utf8');
  return babel.transformSync(src, {
    filename: 'calendar-store.ts',
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-typescript'],
    plugins: [['babel-plugin-react-compiler', {}]],
  }).code;
}

function hook(code, name) {
  const start = code.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = code.indexOf('\nexport ', start + 1);
  return code.slice(start, next < 0 ? undefined : next);
}

for (const [name, store] of [['usePlusPreview', 'plus'], ['useCalendar', 'docs']]) {
  test(`${name}: the store value is not cached by the compiler on uid alone`, () => {
    const body = hook(compiled(), name);
    // The value read must not sit in a compiler cache slot guarded only by uid.
    assert.doesNotMatch(body, new RegExp(`if \\(\\$\\[\\d+\\] !== uid\\) \\{\\s*t\\d+ = uid \\? ${store}\\.get\\(uid\\)`));
    assert.match(body, /useSyncExternalStore\(/);
  });
}
