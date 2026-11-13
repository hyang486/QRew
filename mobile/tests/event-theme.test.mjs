// Dark mode guard for the Qrewing event screens (code check, not a device check): colors come from theme tokens
// only, and every <Text> style sets a color (an unset color stays black in dark mode).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const files = [
  ...readdirSync(new URL('../src/features/event/', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => `src/features/event/${f}`),
  ...readdirSync(new URL('../src/features/recap/', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => `src/features/recap/${f}`),
  'src/components/room-ended.tsx',
];
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('event and recap screens use no hard-coded colors', () => {
  for (const f of files) {
    const bad = read(f).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|['"](white|black|red|gray|grey|blue|green)['"]/g);
    assert.equal(bad, null, `${f}: ${bad}`);
  }
});

test('every <Text> in event and recap screens has a style with a token color', () => {
  for (const f of files) {
    const src = read(f);
    const sheet = src.match(/StyleSheet\.create\(\{([\s\S]*)\}\);/);
    const styles = new Map();
    if (sheet) for (const [, k, v] of sheet[1].matchAll(/^\s{2}(\w+): \{([^}]*)\}/gm)) styles.set(k, v);
    for (const t of src.matchAll(/<Text\b([^>]*)>/g)) {
      const names = [...t[1].matchAll(/styles\.(\w+)/g)].map((m) => m[1]);
      const line = src.slice(0, t.index).split('\n').length;
      assert.ok(names.some((n) => /color: colors\.\w+/.test(styles.get(n) ?? '')), `${f}:${line} <Text> without a token color`);
    }
  }
});
