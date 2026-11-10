// Run: npm test (node --test, Node 24 strips the .ts types).
// G9 F1: "Take photo" never reaches the native camera on a simulator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CameraError, cameraStep } from '../src/lib/camera-plan.ts';

test('cameraStep: a simulator has no camera, so nothing native is called', () => {
  assert.equal(cameraStep(false), 'unavailable');
});

test('cameraStep: a real device asks for camera access first', () => {
  assert.equal(cameraStep(true), 'ask-permission');
});


test('CameraError is an Error the screens can tell apart from upload failures', () => {
  const e = new CameraError('x');
  assert.ok(e instanceof CameraError);
  assert.ok(e instanceof Error);
  assert.ok(!(new Error('x') instanceof CameraError));
});

// face.ts and media.ts load native modules, so plain Node cannot run them: check the order in the source
// instead. Both camera paths must decide with cameraStep before any native camera call.
for (const [file, fn] of [
  ['src/lib/media.ts', 'takePhoto'],
  ['src/lib/face.ts', 'pickFaceReference'],
]) {
  test(`${fn}: cameraStep(Device.isDevice) runs before the camera permission request and launch`, () => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const body = src.slice(src.indexOf(`export async function ${fn}(`));
    const guard = body.indexOf('cameraStep(Device.isDevice)');
    assert.ok(guard > 0, 'guard present');
    assert.ok(guard < body.indexOf('requestCameraPermissionsAsync'), 'guard before the permission request');
    assert.ok(guard < body.indexOf('launchCameraAsync'), 'guard before the launch');
  });
}

test('CameraError reason: denied opens the Camera access is off screen; default is unavailable', () => {
  assert.equal(new CameraError('x', 'denied').reason, 'denied');
  assert.equal(new CameraError('x').reason, 'unavailable');
  const src = readFileSync(new URL('../src/lib/media.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(!perm\.granted\) throw new CameraError\(en\.media\.cameraDenied, 'denied'\)/);
});
