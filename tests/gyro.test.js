import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGyroDelta, deviceOrientationToQuat } from '../client/gyroMath.js';

const EPS = 1e-4;

test('portrait gyro panning right decreases yaw and tilting back up increases pitch', () => {
  const base = deviceOrientationToQuat(10, 90, 0, 0);
  const turnRight = deviceOrientationToQuat(0, 90, 0, 0);
  const rightDelta = computeGyroDelta(base, turnRight);
  assert.ok(Math.abs(rightDelta.dYaw - -((10 * Math.PI) / 180)) < EPS);
  assert.ok(Math.abs(rightDelta.dPitch) < EPS);

  const tiltUp = deviceOrientationToQuat(10, 105, 0, 0);
  const upDelta = computeGyroDelta(base, tiltUp);
  assert.ok(Math.abs(upDelta.dPitch - (15 * Math.PI) / 180) < EPS);
  assert.ok(Math.abs(upDelta.dYaw) < EPS);
});

test('portrait gyro handles 359 -> 1 compass wrap without spike', () => {
  const q1 = deviceOrientationToQuat(359, 90, 0, 0);
  const q2 = deviceOrientationToQuat(1, 90, 0, 0);
  const delta = computeGyroDelta(q1, q2);
  assert.ok(Math.abs(delta.dYaw - (2 * Math.PI) / 180) < EPS);
  assert.ok(Math.abs(delta.dPitch) < EPS);
});

test('landscape gyro (orient = 90) maps pan & tilt to camera yaw and pitch', () => {
  const base = deviceOrientationToQuat(90, 0, -90, 90);
  const turnRight = deviceOrientationToQuat(78, 0, -90, 90);
  const rightDelta = computeGyroDelta(base, turnRight);
  assert.ok(Math.abs(rightDelta.dYaw - -((12 * Math.PI) / 180)) < EPS);
  assert.ok(Math.abs(rightDelta.dPitch) < EPS);

  const tiltDown = deviceOrientationToQuat(90, 0, -78, 90);
  const downDelta = computeGyroDelta(base, tiltDown);
  assert.ok(Math.abs(downDelta.dPitch - -((12 * Math.PI) / 180)) < EPS);
});

test('landscape-secondary gyro (orient = -90) pans and tilts cleanly across gamma singularity', () => {
  const base = deviceOrientationToQuat(0, 0, 88, -90);
  // Crossing gamma = +90 into +92 yields W3C (alpha+180, beta=180, gamma=-(180-92)=-88)
  const flippedStep = deviceOrientationToQuat(180, 180, -88, -90);
  const delta = computeGyroDelta(base, flippedStep);
  assert.ok(Math.abs(delta.dPitch - (4 * Math.PI) / 180) < 0.01);
  assert.ok(Math.abs(delta.dYaw) < 0.01);
});
