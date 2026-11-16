import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_HALF_SIZE,
  ARENA_BOXES,
  JUMP_PADS,
  ORB_SPAWNS,
  findRandomPanSpawn,
} from '../shared/arena.js';
import {
  FIXED_DT,
  PAN_PICKUP_RADIUS,
  PAN_THROW_BASE_HIT_RADIUS,
  PAN_THROW_INITIAL_SCALE,
  PAN_THROW_MAX_SCALE,
  PLAYER_EYE_HEIGHT,
  TEAMS,
  WEAPONS,
  getThrownPanHitRadius,
  getThrownPanScale,
} from '../shared/constants.js';
import { EVT, MSG } from '../shared/protocol.js';
import { raycastArena } from '../shared/physics.js';
import { GameRoom } from '../server/GameRoom.js';
import { BotController } from '../server/BotController.js';

function createSeededRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makePlayer(room, id, name, team) {
  const p = room.createPlayerEntity(id, name, null, false, team);
  room.players.set(id, p);
  return p;
}

test('findRandomPanSpawn returns walkable unobstructed positions clear of obstacles, jump pads, and orbs', () => {
  const rng = createSeededRng(42);
  const walkableKinds = new Set(['grass_floor', 'cobble', 'wood_deck']);
  const samples = [];

  for (let i = 0; i < 250; i++) samples.push(findRandomPanSpawn(ARENA_BOXES, JUMP_PADS, ORB_SPAWNS, rng));
  for (let i = 0; i < 250; i++) samples.push(findRandomPanSpawn(ARENA_BOXES, JUMP_PADS, ORB_SPAWNS));

  for (const spot of samples) {
    assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y) && Number.isFinite(spot.z));
    assert.ok(Math.abs(spot.x) <= ARENA_HALF_SIZE - 1, `x out of bounds: ${spot.x}`);
    assert.ok(Math.abs(spot.z) <= ARENA_HALF_SIZE - 1, `z out of bounds: ${spot.z}`);
    assert.ok(spot.y >= -0.01 && spot.y <= 3.71, `y out of expected elevation: ${spot.y}`);

    const support = ARENA_BOXES.some(
      (b) =>
        walkableKinds.has(b.kind) &&
        Math.abs(b.maxY - spot.y) < 0.05 &&
        spot.x >= b.minX &&
        spot.x <= b.maxX &&
        spot.z >= b.minZ &&
        spot.z <= b.maxZ
    );
    assert.ok(support, `spot (${spot.x}, ${spot.y}, ${spot.z}) is not on a walkable floor surface`);

    const blocked = ARENA_BOXES.some(
      (b) =>
        spot.y + 0.05 < b.maxY &&
        spot.y + 1.85 > b.minY &&
        spot.x >= b.minX - 0.5 &&
        spot.x <= b.maxX + 0.5 &&
        spot.z >= b.minZ - 0.5 &&
        spot.z <= b.maxZ + 0.5
    );
    assert.ok(!blocked, `spot (${spot.x}, ${spot.y}, ${spot.z}) clips an obstacle`);

    for (const pad of JUMP_PADS) {
      if (Math.abs(spot.y - pad.y) < 1.2) {
        assert.ok(Math.hypot(spot.x - pad.x, spot.z - pad.z) >= pad.radius + 0.64);
      }
    }
    for (const orb of ORB_SPAWNS) {
      if (Math.abs(spot.y - orb.y) < 1.6) {
        assert.ok(Math.hypot(spot.x - orb.x, spot.z - orb.z) >= 1.44);
      }
    }
  }
});

test('Bots alone do not waste initial pan spawns and first human clamps spawn delay <= 3.5s', () => {
  const room = new GameRoom();
  room.addBot();
  room.addBot();
  room.panSpawnTimer = 0.05;
  for (let i = 0; i < 6; i++) room.stepSimulation(FIXED_DT);
  assert.equal(room.panPickup, null, 'bots alone must not consume pan spawns before a human connects');

  room.panSpawnTimer = 6.5;
  room.addHumanPlayer({ readyState: 1, send() {} }, 'PlayerOne', TEAMS.CRIMSON);
  assert.ok(room.panSpawnTimer <= 3.5, 'first human joining should receive a pan within 3.5s');
});

test('Pan timed spawn, pickup, swap lock, one-shot melee one-kill, and single-use revert', () => {
  const room = new GameRoom();
  const p1 = makePlayer(room, 'p1', 'Attacker', TEAMS.CRIMSON);
  const p2 = makePlayer(room, 'p2', 'TankVictim', TEAMS.AZURE);

  // Timed random spawn fires EVT.PAN_SPAWN once timer elapses
  room.panPickup = null;
  room.panSpawnTimer = 0.05;
  p1.x = -19.5;
  p1.y = 0;
  p1.z = 8;
  p2.x = -19.5;
  p2.y = 0;
  p2.z = 5.4;

  for (let i = 0; i < 6; i++) {
    room.stepSimulation(FIXED_DT);
  }
  assert.ok(room.panPickup !== null, 'panPickup should spawn after panSpawnTimer expires');
  assert.ok(
    room.pendingEvents.some((ev) => ev.kind === EVT.PAN_SPAWN),
    'EVT.PAN_SPAWN should be emitted'
  );

  // Clear random pickup & place deterministically near p1 for collection test
  room.pendingEvents = [];
  room.spawnPanPickup({ x: -19.5, y: 0, z: 7.4 });
  p1.x = -19.5;
  p1.y = 0;
  p1.z = 8.0; // within PAN_PICKUP_RADIUS (1.45)
  p1.weapon = 'staff';
  p1.weaponCd = 0.5;
  room.stepSimulation(FIXED_DT);

  assert.equal(room.panPickup, null, 'panPickup should disappear after collection');
  assert.equal(p1.weapon, 'pan', 'player active weapon should switch to pan');
  assert.equal(p1.prevWeapon, 'staff', 'previous weapon should be saved');
  assert.equal(p1.weaponCd, 0, 'pan should be ready to swing immediately');
  assert.ok(
    room.pendingEvents.some((ev) => ev.kind === EVT.PAN_PICKUP && ev.playerId === 'p1'),
    'EVT.PAN_PICKUP should be emitted for collector'
  );

  // Swapping weapons while holding pan must remain locked
  p1.unlockedWeapons.add('runeblade');
  room.handleClientMessage(p1, { t: MSG.EQUIP_WEAPON, id: 'runeblade' });
  assert.equal(p1.weapon, 'pan', 'EQUIP_WEAPON cannot override held pan');

  // Buying a new weapon while holding pan updates prevWeapon without replacing pan
  p1.essence = 999;
  room.handleBuy(p1, { category: 'weapon', id: 'rail' });
  assert.equal(p1.weapon, 'pan', 'shop purchase must not replace held pan');
  assert.equal(p1.prevWeapon, 'rail', 'shop purchase updates fallback weapon');

  // Record clear LOS lane & buff victim with max HP + active block/parry + dash i-frames
  const wallCheck = raycastArena(
    { x: -19.5, y: PLAYER_EYE_HEIGHT, z: 8.0 },
    { x: 0, y: 0, z: -1 },
    3.0,
    ARENA_BOXES
  );
  assert.equal(wallCheck, null, 'melee test lane should be unobstructed');

  p2.x = -19.5;
  p2.y = 0;
  p2.z = 5.4;
  p2.runes.vitality = 3;
  p2.maxHp = 190;
  p2.hp = 190;
  p2.blocking = true;
  p2.parryTimer = 0.2;
  p2.dashTimer = 0.1;

  room.pendingEvents = [];
  // Aim along -Z (yaw = 0, pitch = 0) straight at p2
  room.handleAction(p1, { kind: 'primary', yaw: 0, pitch: 0, viewTime: room.now });

  assert.equal(p2.alive, false, 'melee pan hit must kill max-HP blocking/dashing enemy in 1 shot');
  assert.equal(p2.hp, 0);
  assert.equal(p1.weapon, 'rail', 'pan must revert to prevWeapon immediately after 1 shot');
  assert.equal(p1.prevWeapon, null);
  assert.ok(
    room.pendingEvents.some((ev) => ev.kind === EVT.PAN_CLANG && ev.hitPlayer === true),
    'EVT.PAN_CLANG(hitPlayer: true) should emit on melee kill'
  );
  assert.ok(
    room.pendingEvents.some((ev) => ev.kind === EVT.KILL && ev.source === WEAPONS.pan.name),
    'kill feed event should credit Golden Pan'
  );
});

test('Pan is valid for only one shot on miss and one-shots at range when thrown', () => {
  const room = new GameRoom();
  const p1 = makePlayer(room, 'p1', 'Thrower', TEAMS.CRIMSON);
  const p2 = makePlayer(room, 'p2', 'DistantTarget', TEAMS.AZURE);

  // Place on open western lane (-19.5, 0, 8) facing -Z toward (-19.5, 0, -4)
  p1.x = -19.5;
  p1.y = 0;
  p1.z = 8.0;
  p2.x = -19.5;
  p2.y = 0;
  p2.z = -4.0;
  assert.equal(
    raycastArena({ x: -19.5, y: PLAYER_EYE_HEIGHT, z: 8.0 }, { x: 0, y: 0, z: -1 }, 12.5, ARENA_BOXES),
    null,
    'throw test lane should be unobstructed'
  );

  // 1. Whiff into sky still consumes the 1-shot pan and throws a projectile
  p1.prevWeapon = 'staff';
  p1.weapon = 'pan';
  p1.weaponCd = 0;
  room.handleAction(p1, { kind: 'primary', yaw: 0, pitch: 0.7, viewTime: room.now });
  assert.equal(p1.weapon, 'staff', 'pan must be consumed even if no enemy is in melee range');
  assert.ok(
    room.projectiles.some((pr) => pr.kind === 'pan' && pr.ownerId === 'p1'),
    'missing melee throws a spinning pan projectile'
  );

  // Clear sky projectile & verify long-range thrown pan one-shot kills p2
  room.projectiles = [];
  room.pendingEvents = [];
  p1.prevWeapon = 'staff';
  p1.weapon = 'pan';
  p1.weaponCd = 0;
  p2.hp = 160;
  p2.maxHp = 160;
  p2.alive = true;

  room.handleAction(p1, { kind: 'primary', yaw: 0, pitch: 0, viewTime: room.now });
  assert.equal(p1.weapon, 'staff', 'throwing pan consumes the single charge immediately');

  for (let i = 0; i < 30 && p2.alive; i++) {
    room.stepSimulation(FIXED_DT);
  }

  assert.equal(p2.alive, false, 'thrown pan projectile must kill full-HP enemy in 1 shot');
  assert.equal(p2.hp, 0);
  assert.ok(
    room.pendingEvents.some((ev) => ev.kind === EVT.PAN_CLANG && ev.hitPlayer === true),
    'thrown pan impact should emit EVT.PAN_CLANG'
  );
});

test('Respawning clears held pan and BotController does not swap off pan', () => {
  const room = new GameRoom();
  const bot = room.createPlayerEntity('b1', 'PanBot', null, true, TEAMS.CRIMSON);
  room.players.set('b1', bot);
  const enemy = makePlayer(room, 'e1', 'Enemy', TEAMS.AZURE);

  // Death while holding pan resets to standard weapon on respawn
  bot.unlockedWeapons = new Set(['staff', 'runeblade', 'rail']);
  bot.prevWeapon = 'runeblade';
  bot.weapon = 'pan';
  room.applyDamage(enemy, bot, 999, 'rail', false, { x: 0, y: 0, z: -1 }, { x: bot.x, y: bot.y + 1, z: bot.z }, false, true);
  assert.equal(bot.alive, false);
  room.respawnPlayer(bot);
  assert.equal(bot.alive, true);
  assert.equal(bot.weapon, 'runeblade', 'respawn should restore prevWeapon');
  assert.equal(bot.prevWeapon, null);

  // Bot holding pan does not switch back to rail/staff during combat AI step
  const ctrl = new BotController('b1');
  bot.prevWeapon = 'rail';
  bot.weapon = 'pan';
  bot.weaponCd = 1.0; // prevent firing during this AI tick check
  bot.x = -19.5;
  bot.y = 0;
  bot.z = 8.0;
  enemy.x = -19.5;
  enemy.y = 0;
  enemy.z = -10.0;

  ctrl.step(bot, room, FIXED_DT);
  assert.equal(bot.weapon, 'pan', 'bot AI must keep pan equipped until fired');
});

test('Thrown pan grows in scale and hitbox area with distance traveled and respects wall cover', () => {
  assert.equal(getThrownPanScale(0), PAN_THROW_INITIAL_SCALE);
  assert.equal(getThrownPanScale(1.5), PAN_THROW_INITIAL_SCALE);
  const midScale = getThrownPanScale(12);
  assert.ok(midScale > 2.0 && midScale < PAN_THROW_MAX_SCALE, `expected mid-range scale growth, got ${midScale}`);
  assert.equal(getThrownPanScale(80), PAN_THROW_MAX_SCALE);
  assert.ok(
    getThrownPanHitRadius(PAN_THROW_MAX_SCALE) > getThrownPanHitRadius(PAN_THROW_INITIAL_SCALE, PAN_THROW_BASE_HIT_RADIUS),
    'hitbox radius must expand with thrown pan scale'
  );

  // Open corridor along x = 6.5 (between altar maxX=5.0 and mid_pillar minX=8.4)
  assert.equal(
    raycastArena({ x: 6.5, y: PLAYER_EYE_HEIGHT, z: 16.0 }, { x: 0, y: 0, z: -1 }, 32.0, ARENA_BOXES),
    null,
    'open eastern corridor should have clear line of flight'
  );

  // 1) Close off-center thrown pan (1.2m laterally off aim at 5.0m distance, past meleeRange 4.1m) misses before expanding wide
  const roomClose = new GameRoom();
  const throwerClose = makePlayer(roomClose, 'p1', 'ThrowerClose', TEAMS.CRIMSON);
  const nearSideTarget = makePlayer(roomClose, 'p2', 'NearMiss', TEAMS.AZURE);
  throwerClose.x = 6.5;
  throwerClose.y = 0;
  throwerClose.z = 16.0;
  nearSideTarget.x = 7.7; // 1.2m lateral offset
  nearSideTarget.y = 0;
  nearSideTarget.z = 11.0; // 5.0m away (outside meleeRange 4.1m, pan is still small)
  throwerClose.weapon = 'pan';
  throwerClose.weaponCd = 0;

  roomClose.handleAction(throwerClose, { kind: 'primary', yaw: 0, pitch: 0, viewTime: roomClose.now });
  assert.ok(roomClose.projectiles.some((pr) => pr.kind === 'pan'), 'pan must be thrown when target is outside melee range');
  for (let i = 0; i < 20; i++) roomClose.stepSimulation(FIXED_DT);
  assert.equal(nearSideTarget.alive, true, 'close off-center target should not be hit before pan expands');

  // 2) Far off-center target (1.2m laterally off aim at 24m distance) IS killed by the enlarged flying pan
  const roomFar = new GameRoom();
  const throwerFar = makePlayer(roomFar, 'p1', 'ThrowerFar', TEAMS.CRIMSON);
  const farSideTarget = makePlayer(roomFar, 'p2', 'FarVictim', TEAMS.AZURE);
  throwerFar.x = 6.5;
  throwerFar.y = 0;
  throwerFar.z = 16.0;
  farSideTarget.x = 7.7; // 1.2m lateral offset (misses standard weapon ray)
  farSideTarget.y = 0;
  farSideTarget.z = -8.0; // 24m downrange
  throwerFar.weapon = 'pan';
  throwerFar.weaponCd = 0;

  let snapshotScaleSeen = 0;
  const origSend = roomFar.sendTo.bind(roomFar);
  const sentPayloads = [];
  throwerFar.ws = { readyState: 1, send: (raw) => sentPayloads.push(JSON.parse(raw)) };

  roomFar.handleAction(throwerFar, { kind: 'primary', yaw: 0, pitch: 0, viewTime: roomFar.now });
  for (let i = 0; i < 45 && farSideTarget.alive; i++) {
    roomFar.stepSimulation(FIXED_DT);
    if (i === 25) {
      roomFar.broadcastSnapshot();
    }
  }

  for (const pkt of sentPayloads) {
    if (pkt.t === MSG.SNAPSHOT && Array.isArray(pkt.pj)) {
      const panProj = pkt.pj.find((pr) => pr.k === 'pan');
      if (panProj) snapshotScaleSeen = Math.max(snapshotScaleSeen, panProj.sc || 0);
    }
  }

  assert.ok(snapshotScaleSeen > 2.0, `snapshot pj should broadcast enlarged pan scale sc (> 2.0), got ${snapshotScaleSeen}`);
  assert.equal(farSideTarget.alive, false, 'distant off-center enemy must be one-shot by grown pan');
  assert.equal(farSideTarget.hp, 0);

  // 3) Target fully tucked behind mid_pillar_1 (x=9.5, z=-9.5, size 2.2x4.4x2.2 -> minX=8.4, maxX=10.6) is protected by wall LoS
  const roomCover = new GameRoom();
  const throwerCover = makePlayer(roomCover, 'p1', 'ThrowerCover', TEAMS.CRIMSON);
  const coveredTarget = makePlayer(roomCover, 'p2', 'Covered', TEAMS.AZURE);
  throwerCover.x = 6.8;
  throwerCover.y = 0;
  throwerCover.z = 16.0;
  coveredTarget.x = 9.0; // right inside mid_pillar shadow from x=6.8
  coveredTarget.y = 0;
  coveredTarget.z = -11.6; // directly behind mid_pillar_1 (z in [-10.6, -8.4])
  throwerCover.weapon = 'pan';
  throwerCover.weaponCd = 0;

  roomCover.handleAction(throwerCover, { kind: 'primary', yaw: 0, pitch: 0, viewTime: roomCover.now });
  for (let i = 0; i < 65; i++) roomCover.stepSimulation(FIXED_DT);
  assert.equal(coveredTarget.alive, true, 'expanded pan should not hit enemies hidden completely behind a solid pillar');
  assert.equal(typeof origSend, 'function');
});
