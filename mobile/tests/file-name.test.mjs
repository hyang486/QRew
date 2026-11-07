// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportFileName, extensionFor } from '../src/lib/file-name.ts';

const ID = '7ce082f9-9beb-426c-8427-918802fb9b64';

test('keeps the original file name (M-1)', () => {
  assert.equal(exportFileName('QA-file.txt', 'text/plain', ID), 'QA-file.txt');
  assert.equal(exportFileName('IMG_0001.HEIC', 'image/heic', ID), 'IMG_0001.heic');
});

test('path separators and control characters cannot escape the folder', () => {
  assert.equal(exportFileName('../../etc/passwd.txt', 'text/plain', ID), '_.._etc_passwd.txt');
  assert.equal(exportFileName('a\\b:c\u0000d.pdf', 'application/pdf', ID), 'a_b_c_d.pdf');
  assert.equal(exportFileName('.hidden.txt', 'text/plain', ID), 'hidden.txt');
});

test('adds an extension from the MIME type when the name has none', () => {
  assert.equal(exportFileName('Holiday clip', 'video/mp4', ID), 'Holiday clip.mp4');
  assert.equal(exportFileName('notes', 'application/x-unknown', ID), 'notes.bin');
});

test('falls back to the media id when no usable name is left', () => {
  assert.equal(exportFileName('', 'image/jpeg', ID), `${ID}.jpg`);
  assert.equal(exportFileName(null, 'video/mp4', ID), `${ID}.mp4`);
  assert.equal(exportFileName('...', 'text/plain', ID), `${ID}.bin`);
  assert.equal(exportFileName('///.txt', 'text/plain', ID), `${ID}.txt`);
});

test('long names are shortened before the extension', () => {
  const name = exportFileName(`${'x'.repeat(300)}.mov`, 'video/quicktime', ID);
  assert.equal(name.length, 120);
  assert.ok(name.endsWith('.mov'));
});

test('extensionFor prefers the file name, then the MIME type', () => {
  assert.equal(extensionFor('a.PNG', 'image/jpeg'), 'png');
  assert.equal(extensionFor('a', 'image/jpeg'), 'jpg');
  assert.equal(extensionFor('a', 'x/y'), 'bin');
});
