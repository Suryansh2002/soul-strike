import {
  BOT_DIFFICULTIES,
  EMOTE_COOLDOWN,
  EMOTES,
  ESSENCE_REWARDS,
  FFA_KILL_LIMIT,
  FIXED_DT,
  GAME_MODES,
  HISTORY_DURATION_MS,
  HEAD_CENTER_OFFSET,
  LAG_COMP_HITBOX_PAD,
  MANA_REGEN_BASE,
  MATCH_DURATION_SEC,
  MAX_HP_BASE,
  MAX_LOBBY_PLAYERS,
  MAX_MANA_BASE,
  MAX_REWIND_MS,
  MAX_STAMINA_BASE,
  PAN_INITIAL_SPAWN_MAX,
  PAN_INITIAL_SPAWN_MIN,
  PAN_PICKUP_RADIUS,
  PAN_RESPAWN_MAX,
  PAN_RESPAWN_MIN,
  PAN_THROW_BASE_HIT_RADIUS,
  PARRY_WINDOW,
  PLAYER_EYE_HEIGHT,
  POWERS,
  RESPAWN_TIME,
  RUNES,
  SIM_HZ,
  SNAPSHOT_INTERVAL_MS,
  SPAWN_SHIELD_DURATION,
  TDM_KILL_LIMIT,
  TEAMS,
  WEAPONS,
  getThrownPanHitRadius,
  getThrownPanScale,
  normalizeBotDifficulty,
} from '../shared/constants.js';
import { ARENA_BOXES, ARENA_HALF_SIZE, JUMP_PADS, ORB_SPAWNS, SPAWN_POINTS, findRandomPanSpawn } from '../shared/arena.js';
import {
  clamp,
  finiteNum,
  getAimDirection,
  lerp,
  normalizeYaw,
  raycastArena,
  raycastPlayerHitbox,
  stepPlayerPhysics,
} from '../shared/physics.js';
import { EVT, MSG, r2, r3 } from '../shared/protocol.js';
import { BotController, createBotName } from './BotController.js';

export class GameRoom {
  constructor() {
    this.players = new Map();
    this.bots = new Map();
    this.projectiles = [];
    this.meteors = [];
    this.orbs = ORB_SPAWNS.map((s) => ({ ...s, active: true, respawnTimer: 0 }));
    this.panPickup = null;
    this.panSpawnTimer = this.nextPanSpawnDelay(true);
    this.history = [];
    this.pendingEvents = [];

    this.mode = GAME_MODES.FFA;
    this.matchState = 'playing'; // 'playing' | 'ended'
    this.matchTimeLeft = MATCH_DURATION_SEC;
    this.intermissionTimer = 0;
    this.teamScores = { [TEAMS.CRIMSON]: 0, [TEAMS.AZURE]: 0 };

    this.now = Date.now();
    this.nextEntityId = 1;
    this.lastSnapshotAt = 0;
    this.simInterval = null;
    this.checkpointSeq = 0;
    this.hostId = null;
    this.managerId = null;
    this.botDifficulty = BOT_DIFFICULTIES.NORMAL;
  }

  start() {
    let lastTime = Date.now();
    let accumulator = 0;

    this.simInterval = setInterval(() => {
      const current = Date.now();
      const elapsed = Math.min(0.1, (current - lastTime) / 1000);
      lastTime = current;
      accumulator += elapsed;

      while (accumulator >= FIXED_DT) {
        this.now += FIXED_DT * 1000;
        this.stepSimulation(FIXED_DT);
        accumulator -= FIXED_DT;
      }

      if (current - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAt = current;
        this.broadcastSnapshot();
      }
    }, 1000 / SIM_HZ);
  }

  stop() {
    if (this.simInterval) clearInterval(this.simInterval);
  }

  createPlayerEntity(id, name, ws = null, isBot = false, preferredTeam = null) {
    const team = this.assignTeam(preferredTeam);
    const player = {
      id,
      name: (name || 'Wanderer').slice(0, 16),
      ws,
      isBot,
      team,
      x: 0,
      y: 0.1,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
      alive: true,
      respawnTimer: 0,

      hp: MAX_HP_BASE,
      maxHp: MAX_HP_BASE,
      mana: MAX_MANA_BASE,
      maxMana: MAX_MANA_BASE,
      stamina: MAX_STAMINA_BASE,
      shield: 0,

      dashTimer: 0,
      dashCd: 0,
      jumpPadCd: 0,
      coyoteTimer: 0,
      slowTimer: 0,
      spawnShieldTimer: 0,
      blocking: false,
      blockStartAt: 0,

      weapon: 'staff',
      prevWeapon: null,
      weaponCd: 0,
      unlockedWeapons: new Set(['staff']),
      unlockedPowers: new Set(),
      powerCds: {},
      runes: { vitality: 0, windwalker: 0, conduit: 0, executioner: 0 },

      essence: ESSENCE_REWARDS.STARTING,
      passiveEssenceTimer: 0,
      kills: 0,
      deaths: 0,
      headshots: 0,
      damageDealt: 0,
      streak: 0,
      damageContributors: new Map(),

      inputQueue: [],
      lastAckSeq: 0,
      lastQueuedSeq: 0,
      lastEmoteAt: 0,
      tickBudget: 0,
      windRank: 0,
    };

    this.respawnPlayer(player);
    return player;
  }

  assignTeam(preferredTeam = null) {
    if (this.mode === GAME_MODES.FFA) return TEAMS.NONE;
    if (preferredTeam === TEAMS.CRIMSON || preferredTeam === TEAMS.AZURE) return preferredTeam;
    let c = 0;
    let a = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAMS.CRIMSON) c++;
      else if (p.team === TEAMS.AZURE) a++;
    }
    return c <= a ? TEAMS.CRIMSON : TEAMS.AZURE;
  }

  ensureHostId() {
    if (this.hostId && this.players.has(this.hostId)) {
      const current = this.players.get(this.hostId);
      if (current && !current.isBot) return this.hostId;
    }
    this.hostId = null;
    for (const p of this.players.values()) {
      if (!p.isBot) {
        this.hostId = p.id;
        break;
      }
    }
    return this.hostId;
  }

  ensureManagerId() {
    if (this.managerId && this.players.has(this.managerId)) {
      const current = this.players.get(this.managerId);
      if (current && !current.isBot) return this.managerId;
    }
    this.managerId = null;
    for (const p of this.players.values()) {
      if (!p.isBot) {
        this.managerId = p.id;
        break;
      }
    }
    return this.managerId;
  }

  canManageRoom(player) {
    if (!player || player.isBot) return false;
    const currentManagerId = this.ensureManagerId();
    let humanCount = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) humanCount++;
    }
    return player.id === currentManagerId || humanCount <= 1;
  }

  addHumanPlayer(ws, name, preferredTeam, explicitId = null) {
    let id = explicitId;
    if (!id) {
      id = `p${this.nextEntityId++}`;
    } else {
      const m = /^p(\d+)$/.exec(id);
      if (m) {
        this.nextEntityId = Math.max(this.nextEntityId, Number(m[1]) + 1);
      }
    }
    const player = this.createPlayerEntity(id, name, ws, false, preferredTeam);
    this.players.set(id, player);
    const hostId = this.ensureHostId();
    const managerId = this.ensureManagerId();

    let humanCount = 0;
    for (const pl of this.players.values()) {
      if (!pl.isBot) humanCount++;
    }
    if (humanCount === 1 && !this.panPickup) {
      this.panSpawnTimer = Math.min(this.panSpawnTimer, 3.5);
    }

    this.sendTo(player, {
      t: MSG.WELCOME,
      id,
      hostId,
      managerId,
      mode: this.mode,
      serverTime: this.now,
      snapshotHz: 1000 / SNAPSHOT_INTERVAL_MS,
      team: player.team,
    });
    return player;
  }

  attachOrAddHuman(peerId, ws, name, preferredTeam) {
    if (peerId && this.players.has(peerId)) {
      const player = this.players.get(peerId);
      player.ws = ws;
      if (name) player.name = String(name).slice(0, 16);
      player.isBot = false;
      const hostId = this.ensureHostId();
      const managerId = this.ensureManagerId();
      this.sendTo(player, {
        t: MSG.WELCOME,
        id: peerId,
        hostId,
        managerId,
        mode: this.mode,
        serverTime: this.now,
        snapshotHz: 1000 / SNAPSHOT_INTERVAL_MS,
        team: player.team,
      });
      return player;
    }
    return this.addHumanPlayer(ws, name, preferredTeam, peerId);
  }

  removePlayer(id) {
    this.players.delete(id);
    this.bots.delete(id);
    this.ensureHostId();
    this.ensureManagerId();
  }

  addBot() {
    if (this.bots.size >= 8) return null;
    const existing = new Set([...this.players.values()].map((p) => p.name));
    const id = `b${this.nextEntityId++}`;
    const bot = this.createPlayerEntity(id, createBotName(existing), null, true);
    this.players.set(id, bot);
    this.bots.set(id, new BotController(id, this.botDifficulty));
    return bot;
  }

  clearBots() {
    for (const id of [...this.bots.keys()]) {
      this.players.delete(id);
      this.bots.delete(id);
    }
  }

  respawnPlayer(p, isRevive = p.deaths > 0) {
    const candidates = SPAWN_POINTS.filter((s) =>
      this.mode === GAME_MODES.TDM ? s.team === p.team || s.team === TEAMS.NONE : true
    );

    // Pick spawn farthest from living enemies
    let bestSpawn = candidates[0] || SPAWN_POINTS[0];
    let bestMinDist = -1;

    for (const sp of candidates) {
      let minEnemyDist = 999;
      for (const other of this.players.values()) {
        if (other.id === p.id || !other.alive) continue;
        if (this.mode === GAME_MODES.TDM && other.team === p.team) continue;
        const d = Math.hypot(other.x - sp.x, other.z - sp.z);
        if (d < minEnemyDist) minEnemyDist = d;
      }
      const jitter = Math.random() * 2.5;
      if (minEnemyDist + jitter > bestMinDist) {
        bestMinDist = minEnemyDist + jitter;
        bestSpawn = sp;
      }
    }

    p.x = bestSpawn.x + (Math.random() - 0.5) * 1.2;
    p.y = bestSpawn.y;
    p.z = bestSpawn.z + (Math.random() - 0.5) * 1.2;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.yaw = bestSpawn.yaw;
    p.pitch = 0;
    p.grounded = true;
    p.alive = true;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.stamina = MAX_STAMINA_BASE;
    p.shield = 0;
    p.slowTimer = 0;
    p.dashTimer = 0;
    p.spawnShieldTimer = isRevive ? SPAWN_SHIELD_DURATION : 0;
    if (p.weapon === 'pan') {
      p.weapon = p.prevWeapon && p.unlockedWeapons.has(p.prevWeapon) ? p.prevWeapon : 'staff';
    }
    p.prevWeapon = null;
    p.damageContributors.clear();
  }

  nextPanSpawnDelay(initial = false) {
    const min = initial ? PAN_INITIAL_SPAWN_MIN : PAN_RESPAWN_MIN;
    const max = initial ? PAN_INITIAL_SPAWN_MAX : PAN_RESPAWN_MAX;
    return min + Math.random() * (max - min);
  }

  spawnPanPickup(pos = null) {
    const spot = pos || findRandomPanSpawn(ARENA_BOXES, JUMP_PADS, ORB_SPAWNS);
    this.panPickup = { x: spot.x, y: spot.y, z: spot.z };
    this.pushEvent({
      kind: EVT.PAN_SPAWN,
      x: r2(spot.x),
      y: r2(spot.y),
      z: r2(spot.z),
    });
    return this.panPickup;
  }

  handleClientMessage(player, msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === MSG.PING) {
      this.sendTo(player, { t: MSG.PONG, c: finiteNum(msg.c, 0), s: this.now }, true);
      return;
    }

    if (msg.t === MSG.INPUT && Array.isArray(msg.ticks)) {
      const ticks = msg.ticks.slice(0, 16);
      for (const tick of ticks) {
        if (!tick || typeof tick !== 'object') continue;
        if (player.inputQueue.length >= 24) break;
        const seq = Math.floor(finiteNum(tick.seq, 0));
        if (seq > (player.lastQueuedSeq || 0)) {
          player.lastQueuedSeq = seq;
          player.inputQueue.push({
            seq,
            moveX: clamp(finiteNum(tick.mx, 0), -1, 1),
            moveZ: clamp(finiteNum(tick.mz, 0), -1, 1),
            jump: Boolean(tick.j),
            dash: Boolean(tick.d),
            block: Boolean(tick.b),
            yaw: normalizeYaw(tick.y),
            pitch: clamp(finiteNum(tick.p, 0), -Math.PI * 0.48, Math.PI * 0.48),
          });
        }
      }
      return;
    }

    if (msg.t === MSG.EQUIP_WEAPON) {
      if (player.weapon !== 'pan' && player.unlockedWeapons.has(msg.id)) {
        player.weapon = msg.id;
      }
      return;
    }

    if (msg.t === MSG.BUY) {
      this.handleBuy(player, msg);
      return;
    }

    if (msg.t === MSG.ACTION) {
      this.handleAction(player, msg);
      return;
    }

    if (msg.t === MSG.EMOTE) {
      this.handleEmote(player, msg.id);
      return;
    }

    if (msg.t === MSG.MATCH_CMD) {
      this.handleMatchCommand(msg, player);
    }
  }

  handleEmote(player, emoteId) {
    if (!player.alive || this.matchState !== 'playing') return;
    const emote = EMOTES[emoteId];
    if (!emote) return;
    if (this.now - (player.lastEmoteAt || 0) < EMOTE_COOLDOWN * 1000) return;
    player.lastEmoteAt = this.now;
    this.pushEvent({
      kind: EVT.EMOTE,
      fromId: player.id,
      id: emote.id,
      x: r2(player.x),
      y: r2(player.y),
      z: r2(player.z),
    });
  }

  handleMatchCommand(msg, player = null) {
    if (player && !this.canManageRoom(player)) {
      return false;
    }
    if (msg.cmd === 'add_bot') {
      this.addBot();
    } else if (msg.cmd === 'clear_bots') {
      this.clearBots();
    } else if (msg.cmd === 'set_mode' && (msg.mode === GAME_MODES.FFA || msg.mode === GAME_MODES.TDM)) {
      this.mode = msg.mode;
      this.resetMatch();
    } else if (msg.cmd === 'set_bot_difficulty') {
      this.botDifficulty = normalizeBotDifficulty(msg.difficulty);
      for (const botCtrl of this.bots.values()) {
        botCtrl.setDifficulty(this.botDifficulty);
      }
    } else if (msg.cmd === 'reset_match') {
      this.resetMatch();
    } else {
      return false;
    }
    return true;
  }

  resetMatch() {
    this.matchState = 'playing';
    this.matchTimeLeft = MATCH_DURATION_SEC;
    this.intermissionTimer = 0;
    this.teamScores = { [TEAMS.CRIMSON]: 0, [TEAMS.AZURE]: 0 };
    this.projectiles = [];
    this.meteors = [];
    this.panPickup = null;
    this.panSpawnTimer = this.nextPanSpawnDelay(true);
    for (const o of this.orbs) {
      o.active = true;
      o.respawnTimer = 0;
    }

    let idx = 0;
    for (const p of this.players.values()) {
      p.team = this.mode === GAME_MODES.TDM ? (idx % 2 === 0 ? TEAMS.CRIMSON : TEAMS.AZURE) : TEAMS.NONE;
      idx++;
      p.kills = 0;
      p.deaths = 0;
      p.headshots = 0;
      p.damageDealt = 0;
      p.streak = 0;
      p.essence = ESSENCE_REWARDS.STARTING;
      p.weapon = 'staff';
      p.prevWeapon = null;
      p.unlockedWeapons = new Set(['staff']);
      p.unlockedPowers = new Set();
      p.powerCds = {};
      p.runes = { vitality: 0, windwalker: 0, conduit: 0, executioner: 0 };
      p.maxHp = MAX_HP_BASE;
      p.windRank = 0;
      this.respawnPlayer(p);
    }

    this.pushEvent({ kind: EVT.MATCH_START, mode: this.mode });
  }

  handleBuy(player, msg) {
    const { category, id } = msg;
    let ok = false;
    let label = '';

    if (category === 'weapon' && WEAPONS[id] && !WEAPONS[id].pickupOnly) {
      const w = WEAPONS[id];
      label = w.name;
      const setWeaponTarget = (nextId) => {
        if (player.weapon === 'pan') player.prevWeapon = nextId;
        else player.weapon = nextId;
      };
      if (player.unlockedWeapons.has(id)) {
        setWeaponTarget(id);
        ok = true;
      } else if (player.essence >= w.cost) {
        player.essence -= w.cost;
        player.unlockedWeapons.add(id);
        setWeaponTarget(id);
        ok = true;
      }
    } else if (category === 'power' && POWERS[id]) {
      const pw = POWERS[id];
      label = pw.name;
      if (!player.unlockedPowers.has(id) && player.essence >= pw.cost) {
        player.essence -= pw.cost;
        player.unlockedPowers.add(id);
        player.powerCds[id] = 0;
        ok = true;
      }
    } else if (category === 'rune' && RUNES[id]) {
      const r = RUNES[id];
      label = r.name;
      const rank = player.runes[id] || 0;
      if (rank < r.maxRank) {
        const cost = r.costs[rank];
        if (player.essence >= cost) {
          player.essence -= cost;
          player.runes[id] = rank + 1;
          if (id === 'vitality') {
            player.maxHp = MAX_HP_BASE + player.runes.vitality * 25;
            player.hp = Math.min(player.maxHp, player.hp + 25);
          } else if (id === 'windwalker') {
            player.windRank = player.runes.windwalker;
          }
          ok = true;
        }
      }
    }

    if (!player.isBot) {
      this.sendTo(player, {
        t: MSG.BUY,
        ok,
        category,
        id,
        label,
        essence: player.essence,
        weapon: player.weapon,
        uw: [...player.unlockedWeapons],
        up: [...player.unlockedPowers],
        rn: player.runes,
      });
    }
    return ok;
  }

  _flushPendingInputsForAction(player) {
    let stepped = 0;
    while (player.inputQueue.length > 0 && player.tickBudget >= 0 && stepped < 3) {
      const inp = player.inputQueue.shift();
      player.tickBudget = Math.max(-1, player.tickBudget - 1);
      stepped++;
      const wasBlocking = player.blocking;
      player.blocking = inp.block && player.stamina > 2;
      if (player.blocking && !wasBlocking) {
        player.blockStartAt = this.now;
      }
      stepPlayerPhysics(player, inp, FIXED_DT, ARENA_BOXES, JUMP_PADS);
      player.lastAckSeq = inp.seq;
    }
  }

  _resolveReconciledEye(player, msg) {
    const serverEye = { x: player.x, y: player.y + PLAYER_EYE_HEIGHT, z: player.z };
    if (
      typeof msg.sx !== 'number' ||
      !Number.isFinite(msg.sx) ||
      typeof msg.sy !== 'number' ||
      !Number.isFinite(msg.sy) ||
      typeof msg.sz !== 'number' ||
      !Number.isFinite(msg.sz)
    ) {
      return serverEye;
    }
    const horizOff = Math.hypot(msg.sx - player.x, msg.sz - player.z);
    const vertOff = Math.abs(msg.sy - player.y);
    if (horizOff > 1.35 || vertOff > 1.2) return serverEye;

    const candEye = {
      x: clamp(msg.sx, -ARENA_HALF_SIZE + 0.3, ARENA_HALF_SIZE - 0.3),
      y: clamp(msg.sy + PLAYER_EYE_HEIGHT, 0.5, 20),
      z: clamp(msg.sz, -ARENA_HALF_SIZE + 0.3, ARENA_HALF_SIZE - 0.3),
    };
    const dx = candEye.x - serverEye.x;
    const dy = candEye.y - serverEye.y;
    const dz = candEye.z - serverEye.z;
    const deltaLen = Math.hypot(dx, dy, dz);
    if (deltaLen <= 0.05) return candEye;

    const wall = raycastArena(
      serverEye,
      { x: dx / deltaLen, y: dy / deltaLen, z: dz / deltaLen },
      deltaLen,
      ARENA_BOXES
    );
    return wall ? serverEye : candEye;
  }

  _findBestMeleeSample(other, baseOrigin, dir, maxRange, minDot, rewindTime, requireLos = false) {
    const times = [rewindTime, Math.min(this.now, rewindTime + 30), this.now];
    const baseY = baseOrigin.y - PLAYER_EYE_HEIGHT;
    let best = null;
    for (let i = 0; i < times.length; i++) {
      const pos = i === times.length - 1 ? other : this.getRewoundPosition(other, times[i]);
      const dx = pos.x - baseOrigin.x;
      const dy = (pos.y + 1.0) - (baseY + 1.0);
      const dz = pos.z - baseOrigin.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > maxRange) continue;
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / Math.max(0.01, dist);
      if (dot <= minDot) continue;
      if (requireLos) {
        const targetDir = {
          x: dx / Math.max(0.01, dist),
          y: dy / Math.max(0.01, dist),
          z: dz / Math.max(0.01, dist),
        };
        const wall = raycastArena(baseOrigin, targetDir, dist, ARENA_BOXES);
        if (wall && wall.dist < dist - 0.35) continue;
      }
      if (!best || dist < best.dist) {
        best = { pos, dist, dy };
      }
    }
    return best;
  }

  handleAction(player, msg) {
    if (!player.alive || this.matchState !== 'playing') return;

    this._flushPendingInputsForAction(player);

    const yaw = typeof msg.yaw === 'number' && Number.isFinite(msg.yaw) ? normalizeYaw(msg.yaw) : player.yaw;
    const pitch = clamp(
      typeof msg.pitch === 'number' && Number.isFinite(msg.pitch) ? msg.pitch : player.pitch,
      -Math.PI * 0.48,
      Math.PI * 0.48
    );
    player.yaw = yaw;
    player.pitch = pitch;

    const rawViewTime = typeof msg.viewTime === 'number' && Number.isFinite(msg.viewTime) ? msg.viewTime : this.now;
    const rewindTime = clamp(rawViewTime, this.now - MAX_REWIND_MS, this.now);
    const eye = this._resolveReconciledEye(player, msg);
    const dir = getAimDirection(yaw, pitch);

    const execMult = 1 + (player.runes.executioner || 0) * 0.1;
    const hsBonus = (player.runes.executioner || 0) * 0.15;
    const cdMult = Math.max(0.55, 1 - (player.runes.conduit || 0) * 0.13);

    if (msg.kind === 'primary') {
      if (player.weaponCd > 0) return;
      const w = WEAPONS[player.weapon] || WEAPONS.staff;
      player.weaponCd = w.cooldown * cdMult;

      if (w.type === 'hitscan') {
        const res = this.resolveRewoundHitscan(player, eye, dir, w.range, rewindTime);
        this.pushEvent({
          kind: EVT.BEAM,
          fromId: player.id,
          weapon: w.id,
          color: w.color,
          ax: r2(eye.x + dir.x * 0.5),
          ay: r2(eye.y - 0.12 + dir.y * 0.5),
          az: r2(eye.z + dir.z * 0.5),
          bx: r2(res.endPoint.x),
          by: r2(res.endPoint.y),
          bz: r2(res.endPoint.z),
        });

        if (res.victim) {
          const mult = res.headshot ? w.headshotMult + hsBonus : 1.0;
          const dmg = Math.round(w.damage * execMult * mult);
          this.applyDamage(player, res.victim, dmg, w.name, res.headshot, dir, res.endPoint);
        }
      } else if (w.type === 'melee_wave') {
        this.pushEvent({
          kind: EVT.SLASH,
          fromId: player.id,
          x: r2(eye.x),
          y: r2(eye.y - 0.15),
          z: r2(eye.z),
          yaw: r2(yaw),
          pitch: r2(pitch),
          color: w.color,
        });

        // Immediate melee cleave check using multi-sample rewound positions
        let hitMelee = false;
        for (const other of this.players.values()) {
          if (!this.isHostile(player, other) || !other.alive) continue;
          const hit = this._findBestMeleeSample(other, eye, dir, w.meleeRange, 0.35, rewindTime, false);
          if (hit) {
            const hs = hit.dy > 0.4;
            const dmg = Math.round(w.damage * execMult * (hs ? 1.45 + hsBonus : 1.0));
            this.applyDamage(player, other, dmg, 'Runeblade', hs, dir, {
              x: hit.pos.x,
              y: hit.pos.y + 1.2,
              z: hit.pos.z,
            });
            hitMelee = true;
          }
        }

        // Also launch crescent soul wave projectile
        if (!hitMelee) {
          this.spawnProjectile({
            ownerId: player.id,
            team: player.team,
            kind: 'wave',
            x: eye.x + dir.x * 0.8,
            y: eye.y - 0.1 + dir.y * 0.8,
            z: eye.z + dir.z * 0.8,
            vx: dir.x * w.waveSpeed,
            vy: dir.y * w.waveSpeed,
            vz: dir.z * w.waveSpeed,
            radius: 0.75,
            splashRadius: 0,
            damage: Math.round(w.waveDamage * execMult),
            life: w.waveRange / w.waveSpeed,
            color: w.color,
            label: 'Crescent Wave',
          });
        }
      } else if (w.type === 'pan') {
        // Consume the single-use Pan immediately and restore the player's previous weapon
        const restoreWpn =
          player.prevWeapon && player.unlockedWeapons.has(player.prevWeapon) ? player.prevWeapon : 'staff';
        player.weapon = restoreWpn;
        player.prevWeapon = null;
        player.weaponCd = w.cooldown * cdMult;

        this.pushEvent({
          kind: EVT.PAN_SWING,
          fromId: player.id,
          x: r2(eye.x),
          y: r2(eye.y - 0.12),
          z: r2(eye.z),
          yaw: r2(yaw),
          pitch: r2(pitch),
        });

        let bestVictim = null;
        let bestDist = Infinity;
        let bestPos = null;
        let bestHs = false;

        for (const other of this.players.values()) {
          if (!this.isHostile(player, other) || !other.alive) continue;
          const hit = this._findBestMeleeSample(other, eye, dir, w.meleeRange, 0.25, rewindTime, true);
          if (hit && hit.dist < bestDist) {
            bestVictim = other;
            bestDist = hit.dist;
            bestPos = hit.pos;
            bestHs = hit.dy > 0.35;
          }
        }

        if (bestVictim) {
          const hitPt = { x: bestPos.x, y: bestPos.y + 1.2, z: bestPos.z };
          this.applyDamage(player, bestVictim, w.damage, w.name, bestHs, dir, hitPt, false, true);
          this.pushEvent({
            kind: EVT.PAN_CLANG,
            x: r2(hitPt.x),
            y: r2(hitPt.y),
            z: r2(hitPt.z),
            hitPlayer: true,
          });
        } else {
          // Hurl the spinning Golden Pan across the arena for a one-shot throw kill
          this.spawnProjectile({
            ownerId: player.id,
            team: player.team,
            kind: 'pan',
            x: eye.x + dir.x * 0.85,
            y: eye.y - 0.1 + dir.y * 0.85,
            z: eye.z + dir.z * 0.85,
            vx: dir.x * w.throwSpeed,
            vy: dir.y * w.throwSpeed,
            vz: dir.z * w.throwSpeed,
            radius: 0.45,
            baseExtraHitRadius: PAN_THROW_BASE_HIT_RADIUS,
            extraHitRadius: PAN_THROW_BASE_HIT_RADIUS,
            distanceTraveled: 0,
            splashRadius: 0,
            damage: w.damage,
            bypassDefense: true,
            life: w.throwRange / w.throwSpeed,
            color: w.color,
            label: w.name,
          });
        }
      }
      return;
    }

    if (msg.kind === 'power' && POWERS[msg.id]) {
      const pw = POWERS[msg.id];
      if (!player.unlockedPowers.has(pw.id)) return;
      if ((player.powerCds[pw.id] || 0) > 0 || player.mana < pw.manaCost) return;

      player.mana -= pw.manaCost;
      player.powerCds[pw.id] = pw.cooldown * cdMult;

      if (pw.id === 'blink') {
        const start = { x: player.x, y: player.y, z: player.z };
        const wall = raycastArena(eye, dir, pw.distance, ARENA_BOXES);
        const travel = wall ? Math.max(0.5, wall.dist - 0.8) : pw.distance;
        player.x = clamp(player.x + dir.x * travel, -22.5, 22.5);
        player.y = clamp(player.y + Math.max(0, dir.y * travel), 0.1, 14);
        player.z = clamp(player.z + dir.z * travel, -22.5, 22.5);
        player.vx *= 0.3;
        player.vz *= 0.3;
        player.dashTimer = 0.25;
        this.pushEvent({
          kind: EVT.BLINK,
          fromId: player.id,
          ax: r2(start.x),
          ay: r2(start.y + 1),
          az: r2(start.z),
          bx: r2(player.x),
          by: r2(player.y + 1),
          bz: r2(player.z),
        });
      } else if (pw.id === 'fireball') {
        this.spawnProjectile({
          ownerId: player.id,
          team: player.team,
          kind: 'fireball',
          x: eye.x + dir.x * 0.9,
          y: eye.y - 0.1 + dir.y * 0.9,
          z: eye.z + dir.z * 0.9,
          vx: dir.x * pw.speed,
          vy: dir.y * pw.speed,
          vz: dir.z * pw.speed,
          radius: 0.45,
          splashRadius: pw.radius,
          damage: Math.round(pw.damage * execMult),
          life: 2.6,
          color: pw.color,
          label: pw.name,
        });
      } else if (pw.id === 'frostlance') {
        this.spawnProjectile({
          ownerId: player.id,
          team: player.team,
          kind: 'frostlance',
          x: eye.x + dir.x * 0.9,
          y: eye.y - 0.08 + dir.y * 0.9,
          z: eye.z + dir.z * 0.9,
          vx: dir.x * pw.speed,
          vy: dir.y * pw.speed,
          vz: dir.z * pw.speed,
          radius: 0.4,
          splashRadius: pw.radius,
          damage: Math.round(pw.damage * execMult),
          slowDuration: pw.slowDuration,
          life: 2.0,
          color: pw.color,
          label: pw.name,
        });
      } else if (pw.id === 'souldrain') {
        let totalHealed = 0;
        const dmg = Math.round(pw.damage * execMult);
        for (const other of this.players.values()) {
          if (!this.isHostile(player, other) || !other.alive) continue;
          const dist = Math.hypot(other.x - player.x, other.y - player.y, other.z - player.z);
          if (dist <= pw.radius) {
            const dealt = this.applyDamage(player, other, dmg, pw.name, false, { x: 0, y: 1, z: 0 }, { x: other.x, y: other.y + 1, z: other.z });
            totalHealed += dealt * pw.healRatio;
          }
        }
        if (totalHealed > 0) {
          player.hp = Math.min(player.maxHp, player.hp + Math.round(totalHealed));
        }
        this.pushEvent({
          kind: EVT.SIPHON,
          fromId: player.id,
          x: r2(player.x),
          y: r2(player.y + 0.3),
          z: r2(player.z),
          radius: pw.radius,
        });
      } else if (pw.id === 'meteor') {
        const hit = raycastArena(eye, dir, pw.range, ARENA_BOXES);
        const targetPos = hit
          ? hit.point
          : {
              x: clamp(eye.x + dir.x * 16, -22, 22),
              y: 0.1,
              z: clamp(eye.z + dir.z * 16, -22, 22),
            };
        this.meteors.push({
          ownerId: player.id,
          x: targetPos.x,
          y: targetPos.y,
          z: targetPos.z,
          timer: pw.delay,
          radius: pw.radius,
          damage: Math.round(pw.damage * execMult),
        });
        this.pushEvent({
          kind: EVT.METEOR_WARN,
          x: r2(targetPos.x),
          y: r2(targetPos.y + 0.08),
          z: r2(targetPos.z),
          radius: pw.radius,
        });
      }
    }
  }

  spawnProjectile(proj) {
    proj.id = `pr${this.nextEntityId++}`;
    this.projectiles.push(proj);
  }

  isHostile(a, b) {
    if (!a || !b || a.id === b.id) return false;
    if (this.mode === GAME_MODES.TDM && a.team === b.team) return false;
    return true;
  }

  hasPanHitLos(origin, dir, distToHit, target) {
    const impactPt = {
      x: origin.x + dir.x * distToHit,
      y: origin.y + dir.y * distToHit,
      z: origin.z + dir.z * distToHit,
    };
    const bodyCheckPts = [
      { x: target.x, y: target.y + 1.0, z: target.z },
      { x: target.x, y: target.y + HEAD_CENTER_OFFSET, z: target.z },
    ];
    for (const pt of bodyCheckPts) {
      const dx = pt.x - impactPt.x;
      const dy = pt.y - impactPt.y;
      const dz = pt.z - impactPt.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= 0.45) return true;
      const wall = raycastArena(
        impactPt,
        { x: dx / dist, y: dy / dist, z: dz / dist },
        dist - 0.25,
        ARENA_BOXES
      );
      if (!wall) return true;
    }
    return false;
  }

  resolveRewoundHitscan(attacker, origin, dir, range, rewindTime) {
    const wall = raycastArena(origin, dir, range, ARENA_BOXES);
    let maxDist = wall ? wall.dist : range;
    let endPoint = wall
      ? wall.point
      : { x: origin.x + dir.x * range, y: origin.y + dir.y * range, z: origin.z + dir.z * range };

    let bestVictim = null;
    let bestHit = null;

    const sampleTimes = [
      rewindTime,
      Math.max(this.now - MAX_REWIND_MS, rewindTime - 28),
      Math.min(this.now, rewindTime + 28),
      this.now,
    ];

    for (const other of this.players.values()) {
      if (!this.isHostile(attacker, other) || !other.alive) continue;
      let matchedHit = null;
      for (let i = 0; i < sampleTimes.length; i++) {
        const rewoundPos = i === sampleTimes.length - 1 ? other : this.getRewoundPosition(other, sampleTimes[i]);
        const hit = raycastPlayerHitbox(origin, dir, maxDist, rewoundPos, LAG_COMP_HITBOX_PAD);
        if (hit && hit.dist < maxDist) {
          matchedHit = hit;
          break;
        }
      }
      if (matchedHit && matchedHit.dist < maxDist) {
        maxDist = matchedHit.dist;
        bestVictim = other;
        bestHit = matchedHit;
        endPoint = matchedHit.point;
      }
    }

    return {
      victim: bestVictim,
      headshot: bestHit ? bestHit.headshot : false,
      endPoint,
    };
  }

  getRewoundPosition(player, targetTime) {
    if (this.history.length === 0) return { x: player.x, y: player.y, z: player.z };

    // History is pushed chronologically
    let before = null;
    let after = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const snap = this.history[i];
      if (snap.t <= targetTime) {
        before = snap;
        after = this.history[i + 1] || snap;
        break;
      }
    }

    if (!before) before = this.history[0];
    if (!after) after = before;

    const pA = before.positions.get(player.id);
    const pB = after.positions.get(player.id);
    if (!pA && !pB) return { x: player.x, y: player.y, z: player.z };
    if (!pA) return pB;
    if (!pB || before.t === after.t) return pA;

    const alpha = clamp((targetTime - before.t) / (after.t - before.t), 0, 1);
    return {
      x: lerp(pA.x, pB.x, alpha),
      y: lerp(pA.y, pB.y, alpha),
      z: lerp(pA.z, pB.z, alpha),
    };
  }

  applyDamage(attacker, victim, rawDmg, sourceName, headshot, dir, hitPoint, isSplash = false, bypassDefense = false) {
    if (!victim.alive || this.matchState !== 'playing') return 0;
    if ((victim.spawnShieldTimer || 0) > 0) return 0;

    // Brief dash evasion i-frames (bypassed by lethal one-shot weapons like the Pan)
    if (!bypassDefense && victim.dashTimer > 0.06 && !isSplash) {
      return 0;
    }

    let dmg = bypassDefense ? Math.max(rawDmg, victim.hp) : rawDmg;

    // Check Arcane Aegis / Parry
    if (!bypassDefense && victim.blocking && victim.stamina > 4) {
      const fwdX = -Math.sin(victim.yaw);
      const fwdZ = -Math.cos(victim.yaw);
      const toAtkX = (attacker ? attacker.x - victim.x : -dir.x);
      const toAtkZ = (attacker ? attacker.z - victim.z : -dir.z);
      const len = Math.hypot(toAtkX, toAtkZ) || 1;
      const facing = (fwdX * toAtkX + fwdZ * toAtkZ) / len;

      if (facing > 0.18 || isSplash) {
        const parryElapsed = (this.now - victim.blockStartAt) / 1000;
        if (parryElapsed <= PARRY_WINDOW && !isSplash) {
          // Perfect Parry!
          dmg = 0;
          victim.stamina = Math.min(MAX_STAMINA_BASE, victim.stamina + 20);
          this.pushEvent({
            kind: EVT.PARRY,
            playerId: victim.id,
            x: r2(victim.x),
            y: r2(victim.y + 1.3),
            z: r2(victim.z),
          });
          if (attacker && attacker.alive) {
            const dist = Math.hypot(attacker.x - victim.x, attacker.z - victim.z);
            if (dist < 4.5) {
              attacker.slowTimer = Math.max(attacker.slowTimer, 1.4);
            }
          }
          if (victim.isBot && attacker && !attacker.isBot) {
            this.bots.get(victim.id)?.onBlockedOrParriedHuman?.(victim, attacker, this, true);
          }
          return 0;
        }
        const blockRatio = victim.weapon === 'runeblade' ? 0.25 : 0.35;
        dmg = Math.max(1, Math.round(dmg * blockRatio));
        victim.stamina = Math.max(0, victim.stamina - 10);
        if (victim.isBot && attacker && !attacker.isBot) {
          this.bots.get(victim.id)?.onBlockedOrParriedHuman?.(victim, attacker, this, false);
        }
      }
    }

    victim.hp = Math.max(0, victim.hp - dmg);

    if (attacker && attacker.id !== victim.id) {
      attacker.damageDealt += dmg;
      victim.damageContributors.set(attacker.id, this.now);

      // Immediate hit confirmation packet for crisp shooter feedback
      if (!attacker.isBot) {
        this.sendTo(attacker, {
          t: MSG.HIT_CONFIRM,
          dmg,
          hs: Boolean(headshot),
          kill: victim.hp <= 0,
          x: r2(hitPoint.x),
          y: r2(hitPoint.y),
          z: r2(hitPoint.z),
          victimId: victim.id,
        });
      }
    }

    if (victim.hp <= 0) {
      this.handleKill(attacker, victim, sourceName, headshot);
    }

    return dmg;
  }

  handleKill(killer, victim, sourceName, headshot) {
    victim.alive = false;
    victim.respawnTimer = RESPAWN_TIME;
    victim.deaths++;
    victim.streak = 0;

    if (killer && killer.id !== victim.id) {
      killer.kills++;
      killer.streak++;
      if (headshot) killer.headshots++;
      const reward = ESSENCE_REWARDS.KILL + (headshot ? ESSENCE_REWARDS.HEADSHOT_BONUS : 0);
      killer.essence += reward;

      if (this.mode === GAME_MODES.TDM && (killer.team === TEAMS.CRIMSON || killer.team === TEAMS.AZURE)) {
        this.teamScores[killer.team]++;
      }

      // Assists
      for (const [contribId, ts] of victim.damageContributors.entries()) {
        if (contribId !== killer.id && this.now - ts < 6000) {
          const assister = this.players.get(contribId);
          if (assister) assister.essence += ESSENCE_REWARDS.ASSIST;
        }
      }

      if (killer.isBot && killer.alive) {
        const botCtrl = this.bots.get(killer.id);
        if (botCtrl) {
          botCtrl.onScoreKill(killer, victim, this);
        }
      }
    }

    this.pushEvent({
      kind: EVT.KILL,
      killerId: killer ? killer.id : null,
      killerName: killer ? killer.name : 'The Void',
      killerTeam: killer ? killer.team : 0,
      victimId: victim.id,
      victimName: victim.name,
      victimTeam: victim.team,
      source: sourceName,
      headshot: Boolean(headshot),
    });

    this.checkWinCondition();
  }

  checkWinCondition() {
    if (this.matchState !== 'playing') return;

    let winner = null;
    if (this.mode === GAME_MODES.FFA) {
      for (const p of this.players.values()) {
        if (p.kills >= FFA_KILL_LIMIT) {
          winner = p.name;
          break;
        }
      }
    } else {
      if (this.teamScores[TEAMS.CRIMSON] >= TDM_KILL_LIMIT) winner = 'Crimson Order';
      else if (this.teamScores[TEAMS.AZURE] >= TDM_KILL_LIMIT) winner = 'Azure Covenant';
    }

    if (winner) {
      this.endMatch(winner);
    }
  }

  endMatch(winnerLabel) {
    this.matchState = 'ended';
    this.intermissionTimer = 9.0;
    this.pushEvent({ kind: EVT.MATCH_END, winner: winnerLabel });
  }

  stepSimulation(dt) {
    // Match timer
    if (this.matchState === 'playing') {
      this.matchTimeLeft = Math.max(0, this.matchTimeLeft - dt);
      if (this.matchTimeLeft <= 0) {
        let winner = 'Draw';
        if (this.mode === GAME_MODES.TDM) {
          if (this.teamScores[TEAMS.CRIMSON] > this.teamScores[TEAMS.AZURE]) winner = 'Crimson Order';
          else if (this.teamScores[TEAMS.AZURE] > this.teamScores[TEAMS.CRIMSON]) winner = 'Azure Covenant';
        } else {
          const sorted = [...this.players.values()].sort((a, b) => b.kills - a.kills);
          if (sorted[0]) winner = sorted[0].name;
        }
        this.endMatch(winner);
      }
    } else if (this.matchState === 'ended') {
      this.intermissionTimer -= dt;
      if (this.intermissionTimer <= 0) {
        this.resetMatch();
      }
    }

    // Step players & bots
    for (const p of this.players.values()) {
      // Passive essence & cooldowns & regen
      p.weaponCd = Math.max(0, p.weaponCd - dt);
      for (const k of Object.keys(p.powerCds)) {
        p.powerCds[k] = Math.max(0, p.powerCds[k] - dt);
      }

      if (!p.alive) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0 && this.matchState === 'playing') {
          this.respawnPlayer(p, true);
        }
        continue;
      }

      if (p.spawnShieldTimer > 0) {
        p.spawnShieldTimer = Math.max(0, p.spawnShieldTimer - dt);
      }

      const conduitRank = p.runes.conduit || 0;
      const vitRank = p.runes.vitality || 0;
      p.mana = Math.min(p.maxMana, p.mana + MANA_REGEN_BASE * (1 + conduitRank * 0.22) * dt);
      if (vitRank > 0) {
        p.hp = Math.min(p.maxHp, p.hp + vitRank * 2.5 * dt);
      }

      p.passiveEssenceTimer += dt;
      if (p.passiveEssenceTimer >= ESSENCE_REWARDS.PASSIVE_INTERVAL) {
        p.passiveEssenceTimer -= ESSENCE_REWARDS.PASSIVE_INTERVAL;
        p.essence += ESSENCE_REWARDS.PASSIVE_AMOUNT;
      }

      if (p.isBot) {
        const botCtrl = this.bots.get(p.id);
        if (botCtrl) {
          const botInput = botCtrl.step(p, this, dt);
          if (botInput) {
            const wasBlocking = p.blocking;
            p.blocking = Boolean(botInput.block && p.stamina > 2);
            if (p.blocking && !wasBlocking) {
              p.blockStartAt = this.now;
            }
            stepPlayerPhysics(p, botInput, dt, ARENA_BOXES, JUMP_PADS);
          }
        }
      } else {
        p.tickBudget = Math.min(6, p.tickBudget + 1.12);
        let processed = 0;
        while (p.inputQueue.length > 0 && p.tickBudget >= 1 && processed < 3) {
          const inp = p.inputQueue.shift();
          p.tickBudget -= 1;
          processed++;

          const wasBlocking = p.blocking;
          p.blocking = inp.block && p.stamina > 2;
          if (p.blocking && !wasBlocking) {
            p.blockStartAt = this.now;
          }

          stepPlayerPhysics(p, inp, dt, ARENA_BOXES, JUMP_PADS);
          p.lastAckSeq = inp.seq;
        }
      }
    }

    // Step Soul Essence Orbs
    for (const orb of this.orbs) {
      if (!orb.active) {
        orb.respawnTimer -= dt;
        if (orb.respawnTimer <= 0) orb.active = true;
        continue;
      }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - orb.x, (p.y + 1.0) - orb.y, p.z - orb.z);
        if (d < 1.45) {
          orb.active = false;
          orb.respawnTimer = 14.0;
          p.essence += ESSENCE_REWARDS.ORB_PICKUP;
          p.mana = Math.min(p.maxMana, p.mana + 30);
          p.hp = Math.min(p.maxHp, p.hp + 20);
          this.pushEvent({ kind: EVT.ORB_PICKUP, orbId: orb.id, playerId: p.id });
          break;
        }
      }
    }

    // Step Random Golden Pan Pickup (spawn only when at least one human player is present)
    let hasHuman = false;
    for (const pl of this.players.values()) {
      if (!pl.isBot) {
        hasHuman = true;
        break;
      }
    }
    if (this.matchState === 'playing' && hasHuman) {
      if (!this.panPickup) {
        this.panSpawnTimer -= dt;
        if (this.panSpawnTimer <= 0) {
          this.spawnPanPickup();
        }
      } else {
        for (const p of this.players.values()) {
          if (!p.alive || p.weapon === 'pan') continue;
          const dx = p.x - this.panPickup.x;
          const dz = p.z - this.panPickup.z;
          const dy = Math.abs(p.y - this.panPickup.y);
          if (dx * dx + dz * dz <= PAN_PICKUP_RADIUS * PAN_PICKUP_RADIUS && dy < 1.8) {
            p.prevWeapon = p.weapon;
            p.weapon = 'pan';
            p.weaponCd = 0;
            const picked = this.panPickup;
            this.panPickup = null;
            this.panSpawnTimer = this.nextPanSpawnDelay(false);
            this.pushEvent({
              kind: EVT.PAN_PICKUP,
              playerId: p.id,
              playerName: p.name,
              x: r2(picked.x),
              y: r2(picked.y),
              z: r2(picked.z),
            });
            break;
          }
        }
      }
    }

    // Step Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      if (pr.life <= 0) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const stepDist = Math.hypot(pr.vx, pr.vy, pr.vz) * dt;
      if (pr.kind === 'pan') {
        const panScale = getThrownPanScale(pr.distanceTraveled || 0);
        pr.extraHitRadius = getThrownPanHitRadius(panScale, pr.baseExtraHitRadius ?? PAN_THROW_BASE_HIT_RADIUS);
      }
      const dirLen = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
      const dir = { x: pr.vx / dirLen, y: pr.vy / dirLen, z: pr.vz / dirLen };
      const origin = { x: pr.x, y: pr.y, z: pr.z };

      // Wall impact check
      const wall = raycastArena(origin, dir, stepDist + pr.radius, ARENA_BOXES);

      // Direct player hit check
      let hitVictim = null;
      let hitHeadshot = false;
      let hitDist = wall ? wall.dist : stepDist + pr.radius;
      const owner = this.players.get(pr.ownerId);
      const pad = pr.kind === 'pan' ? (pr.extraHitRadius || 0) : (pr.extraHitRadius || 0.12);

      for (const other of this.players.values()) {
        if (!other.alive || other.id === pr.ownerId) continue;
        if (owner && !this.isHostile(owner, other)) continue;
        let hit = raycastPlayerHitbox(origin, dir, hitDist, other, pad);
        if (!hit && pr.kind !== 'pan') {
          const rewoundPos = this.getRewoundPosition(other, this.now - 40);
          hit = raycastPlayerHitbox(origin, dir, hitDist, rewoundPos, pad);
        }
        if (hit && hit.dist <= hitDist) {
          if (
            pr.kind === 'pan' &&
            (pr.extraHitRadius || 0) > 0.35 &&
            !this.hasPanHitLos(origin, dir, hit.dist, other)
          ) {
            continue;
          }
          hitDist = hit.dist;
          hitVictim = other;
          hitHeadshot = Boolean(hit.headshot);
        }
      }

      if (hitVictim || wall) {
        const impactPoint = {
          x: pr.x + dir.x * hitDist,
          y: pr.y + dir.y * hitDist,
          z: pr.z + dir.z * hitDist,
        };

        if (pr.splashRadius > 0) {
          this.explodeAt(owner, impactPoint, pr.splashRadius, pr.damage, pr.color, pr.label, pr.slowDuration || 0);
        } else if (hitVictim) {
          this.applyDamage(
            owner,
            hitVictim,
            pr.damage,
            pr.label,
            pr.kind === 'pan' ? hitHeadshot : false,
            dir,
            impactPoint,
            false,
            Boolean(pr.bypassDefense)
          );
          if (pr.kind === 'pan') {
            this.pushEvent({
              kind: EVT.PAN_CLANG,
              x: r2(impactPoint.x),
              y: r2(impactPoint.y),
              z: r2(impactPoint.z),
              hitPlayer: true,
            });
          } else {
            this.pushEvent({
              kind: EVT.EXPLOSION,
              x: r2(impactPoint.x),
              y: r2(impactPoint.y),
              z: r2(impactPoint.z),
              radius: 1.3,
              color: pr.color,
            });
          }
        } else if (wall && pr.kind === 'pan') {
          this.pushEvent({
            kind: EVT.PAN_CLANG,
            x: r2(impactPoint.x),
            y: r2(impactPoint.y),
            z: r2(impactPoint.z),
            hitPlayer: false,
          });
        }

        this.projectiles.splice(i, 1);
        continue;
      }

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.z += pr.vz * dt;
      pr.distanceTraveled = (pr.distanceTraveled || 0) + stepDist;
    }

    // Step Meteors
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.timer -= dt;
      if (m.timer <= 0) {
        const owner = this.players.get(m.ownerId);
        this.explodeAt(owner, { x: m.x, y: m.y + 0.5, z: m.z }, m.radius, m.damage, '#e879f9', 'Void Meteor', 0);
        this.meteors.splice(i, 1);
      }
    }

    // Record lag-compensation history
    const posMap = new Map();
    for (const p of this.players.values()) {
      if (p.alive) posMap.set(p.id, { x: p.x, y: p.y, z: p.z });
    }
    this.history.push({ t: this.now, positions: posMap });
    while (this.history.length > 0 && this.now - this.history[0].t > HISTORY_DURATION_MS) {
      this.history.shift();
    }
  }

  explodeAt(owner, center, radius, maxDmg, color, label, slowDuration) {
    this.pushEvent({
      kind: EVT.EXPLOSION,
      x: r2(center.x),
      y: r2(center.y),
      z: r2(center.z),
      radius: r2(radius),
      color,
    });

    for (const other of this.players.values()) {
      if (!other.alive || (other.spawnShieldTimer || 0) > 0) continue;
      if (owner && other.id !== owner.id && !this.isHostile(owner, other)) continue;
      const selfMult = owner && other.id === owner.id ? 0.35 : 1.0;

      const dx = other.x - center.x;
      const dy = (other.y + 0.9) - center.y;
      const dz = other.z - center.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= radius) {
        const falloff = clamp(1 - (dist / radius) * 0.65, 0.35, 1.0);
        const dmg = Math.round(maxDmg * falloff * selfMult);
        const dir = { x: dx / Math.max(0.01, dist), y: dy / Math.max(0.01, dist), z: dz / Math.max(0.01, dist) };
        this.applyDamage(owner, other, dmg, label, false, dir, center, true);
        if (slowDuration > 0 && other.id !== (owner && owner.id)) {
          other.slowTimer = Math.max(other.slowTimer, slowDuration);
        }
        // Knockback
        other.vx += dir.x * 7.5 * falloff;
        other.vy = Math.max(other.vy, 4.5 * falloff);
        other.vz += dir.z * 7.5 * falloff;
      }
    }
  }

  pushEvent(evt) {
    this.pendingEvents.push(evt);
  }

  sendTo(player, payload, fast = false) {
    if (!player.ws || player.ws.readyState !== 1) return;
    const raw = JSON.stringify(payload);
    if (fast && typeof player.ws.sendFast === 'function') {
      player.ws.sendFast(raw);
    } else {
      player.ws.send(raw);
    }
  }

  exportCheckpoint() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        isBot: Boolean(p.isBot),
        team: p.team,
        x: p.x,
        y: p.y,
        z: p.z,
        vx: p.vx,
        vy: p.vy,
        vz: p.vz,
        yaw: p.yaw,
        pitch: p.pitch,
        grounded: Boolean(p.grounded),
        alive: Boolean(p.alive),
        respawnTimer: p.respawnTimer,
        hp: p.hp,
        maxHp: p.maxHp,
        mana: p.mana,
        maxMana: p.maxMana,
        stamina: p.stamina,
        shield: p.shield,
        dashTimer: p.dashTimer,
        dashCd: p.dashCd,
        jumpPadCd: p.jumpPadCd,
        coyoteTimer: p.coyoteTimer,
        slowTimer: p.slowTimer,
        spawnShieldTimer: r2(p.spawnShieldTimer || 0),
        blocking: Boolean(p.blocking),
        blockStartAt: p.blockStartAt,
        weapon: p.weapon,
        prevWeapon: p.prevWeapon,
        weaponCd: p.weaponCd,
        unlockedWeapons: [...p.unlockedWeapons],
        unlockedPowers: [...p.unlockedPowers],
        powerCds: { ...p.powerCds },
        runes: { ...p.runes },
        essence: p.essence,
        passiveEssenceTimer: p.passiveEssenceTimer,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        damageDealt: p.damageDealt,
        streak: p.streak,
        lastAckSeq: p.lastAckSeq,
        windRank: p.windRank,
      });
    }

    return {
      version: 1,
      seq: ++this.checkpointSeq,
      now: this.now,
      nextEntityId: this.nextEntityId,
      hostId: this.ensureHostId(),
      managerId: this.ensureManagerId(),
      mode: this.mode,
      botDifficulty: this.botDifficulty,
      matchState: this.matchState,
      matchTimeLeft: r2(this.matchTimeLeft),
      intermissionTimer: r2(this.intermissionTimer),
      teamScores: { ...this.teamScores },
      panPickup: this.panPickup ? { x: this.panPickup.x, y: this.panPickup.y, z: this.panPickup.z } : null,
      panSpawnTimer: r2(this.panSpawnTimer),
      orbs: this.orbs.map((o) => ({
        id: o.id,
        x: o.x,
        y: o.y,
        z: o.z,
        active: Boolean(o.active),
        respawnTimer: r2(o.respawnTimer),
      })),
      projectiles: this.projectiles.map((pr) => ({ ...pr })),
      meteors: this.meteors.map((m) => ({ ...m })),
      players,
    };
  }

  importCheckpoint(cp, endpointResolver = null) {
    if (!cp || typeof cp !== 'object') return false;

    this.checkpointSeq = Math.max(this.checkpointSeq, Number(cp.seq) || 0);
    this.now = Number(cp.now) || Date.now();
    this.nextEntityId = Number(cp.nextEntityId) || 1;
    this.hostId = cp.hostId || null;
    this.managerId = cp.managerId || cp.hostId || null;
    this.mode = cp.mode || GAME_MODES.FFA;
    this.botDifficulty = normalizeBotDifficulty(cp.botDifficulty);
    this.matchState = cp.matchState || 'playing';
    this.matchTimeLeft = typeof cp.matchTimeLeft === 'number' ? cp.matchTimeLeft : MATCH_DURATION_SEC;
    this.intermissionTimer = Number(cp.intermissionTimer) || 0;
    this.teamScores = {
      [TEAMS.CRIMSON]: cp.teamScores?.[TEAMS.CRIMSON] || 0,
      [TEAMS.AZURE]: cp.teamScores?.[TEAMS.AZURE] || 0,
    };
    this.panPickup = cp.panPickup
      ? { x: Number(cp.panPickup.x) || 0, y: Number(cp.panPickup.y) || 0, z: Number(cp.panPickup.z) || 0 }
      : null;
    this.panSpawnTimer = typeof cp.panSpawnTimer === 'number' ? cp.panSpawnTimer : this.nextPanSpawnDelay(false);

    if (Array.isArray(cp.orbs) && cp.orbs.length === this.orbs.length) {
      this.orbs = cp.orbs.map((o, idx) => ({
        ...this.orbs[idx],
        id: o.id ?? this.orbs[idx].id,
        x: Number(o.x),
        y: Number(o.y),
        z: Number(o.z),
        active: Boolean(o.active),
        respawnTimer: Number(o.respawnTimer) || 0,
      }));
    }

    this.projectiles = Array.isArray(cp.projectiles) ? cp.projectiles.slice(0, 64).map((pr) => ({ ...pr })) : [];
    this.meteors = Array.isArray(cp.meteors) ? cp.meteors.slice(0, 16).map((m) => ({ ...m })) : [];
    this.pendingEvents = [];

    this.players.clear();
    this.bots.clear();

    if (Array.isArray(cp.players)) {
      const cappedPlayers = cp.players.slice(0, MAX_LOBBY_PLAYERS + 8);
      for (const sp of cappedPlayers) {
        if (!sp || typeof sp !== 'object' || !sp.id) continue;
        const numMatch = /^[pb](\d+)$/.exec(sp.id || '');
        if (numMatch) {
          this.nextEntityId = Math.max(this.nextEntityId, Number(numMatch[1]) + 1);
        }

        const clampRune = (id) => clamp(Math.floor(finiteNum(sp.runes?.[id], 0)), 0, RUNES[id].maxRank);
        const runes = {
          vitality: clampRune('vitality'),
          windwalker: clampRune('windwalker'),
          conduit: clampRune('conduit'),
          executioner: clampRune('executioner'),
        };

        const maxHp = clamp(finiteNum(sp.maxHp, MAX_HP_BASE), MAX_HP_BASE, MAX_HP_BASE + 75);
        const hp = clamp(finiteNum(sp.hp, maxHp), 0, maxHp);

        const rawWeapons = Array.isArray(sp.unlockedWeapons) ? sp.unlockedWeapons : ['staff'];
        const unlockedWeapons = new Set(['staff']);
        for (const wId of rawWeapons) {
          if (WEAPONS[wId] && !WEAPONS[wId].pickupOnly) unlockedWeapons.add(wId);
        }

        const weapon =
          typeof sp.weapon === 'string' && WEAPONS[sp.weapon] && (unlockedWeapons.has(sp.weapon) || sp.weapon === 'pan')
            ? sp.weapon
            : 'staff';
        const prevWeapon =
          typeof sp.prevWeapon === 'string' && unlockedWeapons.has(sp.prevWeapon) ? sp.prevWeapon : null;

        const rawPowers = Array.isArray(sp.unlockedPowers) ? sp.unlockedPowers : [];
        const unlockedPowers = new Set(rawPowers.filter((id) => Boolean(POWERS[id])));

        const lastAckSeq = Math.max(0, Math.floor(finiteNum(sp.lastAckSeq, 0)));

        const restored = {
          id: String(sp.id),
          name: String(sp.name || 'Wanderer').slice(0, 16),
          ws: sp.isBot ? null : endpointResolver ? endpointResolver(sp.id) : null,
          isBot: Boolean(sp.isBot),
          team: sp.team === TEAMS.CRIMSON || sp.team === TEAMS.AZURE ? sp.team : TEAMS.NONE,
          x: clamp(finiteNum(sp.x, 0), -ARENA_HALF_SIZE, ARENA_HALF_SIZE),
          y: clamp(finiteNum(sp.y, 0.1), -2, 20),
          z: clamp(finiteNum(sp.z, 0), -ARENA_HALF_SIZE, ARENA_HALF_SIZE),
          vx: clamp(finiteNum(sp.vx, 0), -35, 35),
          vy: clamp(finiteNum(sp.vy, 0), -35, 35),
          vz: clamp(finiteNum(sp.vz, 0), -35, 35),
          yaw: normalizeYaw(sp.yaw),
          pitch: clamp(finiteNum(sp.pitch, 0), -Math.PI * 0.48, Math.PI * 0.48),
          grounded: Boolean(sp.grounded),
          alive: Boolean(sp.alive),
          respawnTimer: clamp(finiteNum(sp.respawnTimer, 0), 0, RESPAWN_TIME),

          hp,
          maxHp,
          mana: clamp(finiteNum(sp.mana, MAX_MANA_BASE), 0, MAX_MANA_BASE),
          maxMana: MAX_MANA_BASE,
          stamina: clamp(finiteNum(sp.stamina, MAX_STAMINA_BASE), 0, MAX_STAMINA_BASE),
          shield: clamp(finiteNum(sp.shield, 0), 0, 500),

          dashTimer: clamp(finiteNum(sp.dashTimer, 0), 0, 1),
          dashCd: clamp(finiteNum(sp.dashCd, 0), 0, 10),
          jumpPadCd: clamp(finiteNum(sp.jumpPadCd, 0), 0, 5),
          coyoteTimer: clamp(finiteNum(sp.coyoteTimer, 0), 0, 1),
          slowTimer: clamp(finiteNum(sp.slowTimer, 0), 0, 10),
          spawnShieldTimer: clamp(finiteNum(sp.spawnShieldTimer, 0), 0, SPAWN_SHIELD_DURATION),
          blocking: Boolean(sp.blocking),
          blockStartAt: finiteNum(sp.blockStartAt, 0),

          weapon,
          prevWeapon,
          weaponCd: clamp(finiteNum(sp.weaponCd, 0), 0, 10),
          unlockedWeapons,
          unlockedPowers,
          powerCds: { ...(sp.powerCds && typeof sp.powerCds === 'object' ? sp.powerCds : {}) },
          runes,

          essence: clamp(finiteNum(sp.essence, ESSENCE_REWARDS.STARTING), 0, 10000),
          passiveEssenceTimer: clamp(finiteNum(sp.passiveEssenceTimer, 0), 0, 10),
          kills: Math.max(0, Math.floor(finiteNum(sp.kills, 0))),
          deaths: Math.max(0, Math.floor(finiteNum(sp.deaths, 0))),
          headshots: Math.max(0, Math.floor(finiteNum(sp.headshots, 0))),
          damageDealt: Math.max(0, Math.floor(finiteNum(sp.damageDealt, 0))),
          streak: Math.max(0, Math.floor(finiteNum(sp.streak, 0))),
          damageContributors: new Map(),

          inputQueue: [],
          lastAckSeq,
          lastQueuedSeq: lastAckSeq,
          lastEmoteAt: 0,
          tickBudget: 0,
          windRank: clamp(Math.floor(finiteNum(sp.windRank, runes.windwalker)), 0, RUNES.windwalker.maxRank),
        };
        this.players.set(restored.id, restored);
        if (restored.isBot) {
          this.bots.set(restored.id, new BotController(restored.id, this.botDifficulty));
        }
      }
    }

    const posMap = new Map();
    for (const p of this.players.values()) {
      posMap.set(p.id, { x: p.x, y: p.y, z: p.z });
    }
    this.history = [{ t: this.now, positions: posMap }];
    this.ensureHostId();
    this.ensureManagerId();
    return true;
  }

  broadcastSnapshot() {
    const playersArr = [];
    for (const p of this.players.values()) {
      playersArr.push({
        id: p.id,
        n: p.name,
        b: p.isBot ? 1 : 0,
        tm: p.team,
        x: r3(p.x),
        y: r3(p.y),
        z: r3(p.z),
        vx: r2(p.vx),
        vy: r2(p.vy),
        vz: r2(p.vz),
        yw: r3(p.yaw),
        pt: r3(p.pitch),
        gr: p.grounded ? 1 : 0,
        al: p.alive ? 1 : 0,
        rt: r2(p.respawnTimer),
        hp: Math.round(p.hp),
        mhp: p.maxHp,
        mn: Math.round(p.mana),
        st: Math.round(p.stamina),
        bl: p.blocking ? 1 : 0,
        dt: r2(p.dashTimer),
        sl: r2(p.slowTimer),
        sp: r2(p.spawnShieldTimer || 0),
        wp: p.weapon,
        es: p.essence,
        kl: p.kills,
        dh: p.deaths,
        hs: p.headshots,
        dm: p.damageDealt,
        ack: p.lastAckSeq,
        uw: [...p.unlockedWeapons],
        up: [...p.unlockedPowers],
        cds: p.powerCds,
        rn: p.runes,
      });
    }

    const projArr = this.projectiles.map((pr) => ({
      id: pr.id,
      k: pr.kind,
      x: r2(pr.x),
      y: r2(pr.y),
      z: r2(pr.z),
      c: pr.color,
      ...(pr.kind === 'pan' ? { sc: r2(getThrownPanScale(pr.distanceTraveled || 0)) } : {}),
    }));

    const orbsArr = this.orbs.map((o) => (o.active ? 1 : 0));

    const payload = JSON.stringify({
      t: MSG.SNAPSHOT,
      st: this.now,
      hi: this.ensureHostId(),
      mi: this.ensureManagerId(),
      md: this.mode,
      bd: this.botDifficulty,
      ms: this.matchState,
      mt: Math.ceil(this.matchTimeLeft),
      ts: this.teamScores,
      pl: playersArr,
      pj: projArr,
      ob: orbsArr,
      pn: this.panPickup ? { x: r2(this.panPickup.x), y: r2(this.panPickup.y), z: r2(this.panPickup.z) } : null,
      ev: this.pendingEvents,
    });

    this.pendingEvents = [];

    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) {
        if (typeof p.ws.sendFast === 'function') {
          p.ws.sendFast(payload);
        } else {
          p.ws.send(payload);
        }
      }
    }
  }
}
