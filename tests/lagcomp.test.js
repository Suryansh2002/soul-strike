import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { EMOTE_COOLDOWN, GAME_MODES, TEAMS } from '../shared/constants.js';
import { EVT, MSG } from '../shared/protocol.js';

test('lag compensation rewinds moving target hitbox to shooter viewTime', () => {
  const room = new GameRoom();
  const shooter = room.createPlayerEntity('s1', 'Shooter', null, false);
  const victim = room.createPlayerEntity('v1', 'Victim', null, false);

  shooter.x = 7;
  shooter.y = 0;
  shooter.z = 8;
  shooter.yaw = 0;
  shooter.pitch = 0;

  // Record victim at x=7, z=-4 at t = now - 120ms, then moved away to x=12 at t = now
  const tOld = room.now - 120;
  room.history.push({ t: tOld, positions: new Map([['v1', { x: 7, y: 0, z: -4 }], ['s1', { x: 7, y: 0, z: 8 }]]) });
  victim.x = 12.0;
  victim.y = 0;
  victim.z = -4;
  room.history.push({ t: room.now, positions: new Map([['v1', { x: 12.0, y: 0, z: -4 }], ['s1', { x: 7, y: 0, z: 8 }]]) });

  room.players.set(shooter.id, shooter);
  room.players.set(victim.id, victim);

  const hpBefore = victim.hp;
  room.handleAction(shooter, {
    kind: 'primary',
    yaw: 0,
    pitch: -0.005, // aiming straight toward head/chest at z=-4 from eye height 1.62
    viewTime: tOld,
  });

  assert.ok(victim.hp < hpBefore, `Expected rewound hit to damage victim (hpBefore=${hpBefore}, after=${victim.hp})`);
});

test('shop unlock and TDM friendly fire protection work properly', () => {
  const room = new GameRoom();
  room.mode = GAME_MODES.TDM;

  const p1 = room.createPlayerEntity('p1', 'Alice', null, false, TEAMS.CRIMSON);
  const p2 = room.createPlayerEntity('p2', 'Bob', null, false, TEAMS.CRIMSON);
  room.players.set(p1.id, p1);
  room.players.set(p2.id, p2);

  // Friendly fire check
  assert.equal(room.isHostile(p1, p2), false);

  // Unlock Shadow Blink (cost 150, starting essence 175)
  const bought = room.handleBuy(p1, { category: 'power', id: 'blink' });
  assert.equal(bought, true);
  assert.equal(p1.unlockedPowers.has('blink'), true);
  assert.equal(p1.essence, 25);
});

test('emotes broadcast EVT.EMOTE for valid emotes and enforce cooldown', () => {
  const room = new GameRoom();
  const p = room.createPlayerEntity('p1', 'Dancer', null, false);
  room.players.set(p.id, p);

  room.handleClientMessage(p, { t: MSG.EMOTE, id: 'invalid_emote' });
  assert.equal(room.pendingEvents.length, 0);

  room.handleClientMessage(p, { t: MSG.EMOTE, id: 'dance' });
  assert.equal(room.pendingEvents.length, 1);
  assert.equal(room.pendingEvents[0].kind, EVT.EMOTE);
  assert.equal(room.pendingEvents[0].fromId, 'p1');
  assert.equal(room.pendingEvents[0].id, 'dance');

  // Immediate spam within cooldown is ignored
  room.handleClientMessage(p, { t: MSG.EMOTE, id: 'wave' });
  assert.equal(room.pendingEvents.length, 1);

  // Allowed again once cooldown elapses
  room.now += EMOTE_COOLDOWN * 1000 + 50;
  room.handleClientMessage(p, { t: MSG.EMOTE, id: 'twerk' });
  assert.equal(room.pendingEvents.length, 2);
  assert.equal(room.pendingEvents[1].id, 'twerk');
});
