import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_DT, MAX_STAMINA_BASE } from '../shared/constants.js';
import { ARENA_BOXES, JUMP_PADS } from '../shared/arena.js';
import { getAimDirection, raycastArena, raycastPlayerHitbox, stepPlayerPhysics } from '../shared/physics.js';

function makePlayer(overrides = {}) {
  return {
    x: 0,
    y: 0,
    z: 10,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    alive: true,
    dashTimer: 0,
    dashCd: 0,
    jumpPadCd: 0,
    coyoteTimer: 0,
    slowTimer: 0,
    stamina: MAX_STAMINA_BASE,
    windRank: 0,
    ...overrides,
  };
}

test('player moves forward and climbs central altar stairs smoothly', () => {
  const p = makePlayer({ x: 0, y: 0, z: 10.2 });
  for (let i = 0; i < 60; i++) {
    stepPlayerPhysics(p, { moveX: 0, moveZ: 1, jump: false, dash: false, block: false, yaw: 0, pitch: 0 }, FIXED_DT, ARENA_BOXES, JUMP_PADS);
  }
  assert.ok(p.z < 6.0, `Expected player to move forward toward altar, got z=${p.z}`);
  assert.ok(p.y >= 1.4, `Expected player to step up altar stairs, got y=${p.y}`);
});

test('jump pad launches player upward', () => {
  const jp = JUMP_PADS[0];
  const p = makePlayer({ x: jp.x, y: jp.y, z: jp.z });
  stepPlayerPhysics(p, { moveX: 0, moveZ: 0, jump: false, dash: false, block: false, yaw: 0, pitch: 0 }, FIXED_DT, ARENA_BOXES, JUMP_PADS);
  assert.ok(p.vy > 10, `Expected upward launch from jump pad, got vy=${p.vy}`);
  assert.equal(p.grounded, false);
});

test('raycastPlayerHitbox distinguishes headshot vs bodyshot', () => {
  const target = { x: 0, y: 0, z: -8 };
  const eyeHead = { x: 0, y: 1.56, z: 0 };
  const dir = getAimDirection(0, 0);

  const headHit = raycastPlayerHitbox(eyeHead, dir, 30, target);
  assert.ok(headHit);
  assert.equal(headHit.headshot, true);

  const eyeBody = { x: 0, y: 0.9, z: 0 };
  const bodyHit = raycastPlayerHitbox(eyeBody, dir, 30, target);
  assert.ok(bodyHit);
  assert.equal(bodyHit.headshot, false);
});

test('raycastArena blocks line of sight behind central obelisk', () => {
  const origin = { x: 0, y: 3.0, z: 6 };
  const dir = getAimDirection(0, 0);
  const hit = raycastArena(origin, dir, 30, ARENA_BOXES);
  assert.ok(hit);
  assert.equal(hit.box.id, 'altar_obelisk');
  assert.ok(hit.dist < 6.0);
});
