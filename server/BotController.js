import { GAME_MODES, PLAYER_EYE_HEIGHT, POWERS, WEAPONS } from '../shared/constants.js';
import { raycastArena } from '../shared/physics.js';
import { ARENA_BOXES, JUMP_PADS } from '../shared/arena.js';

const BOT_NAMES = ['Aldric', 'Vespera', 'Kaelen', 'Nyx', 'Seraph', 'Draven', 'Lyra', 'Thane'];

export function createBotName(existingNames) {
  for (const n of BOT_NAMES) {
    if (!existingNames.has(n)) return n;
  }
  return `Soul-${Math.floor(100 + Math.random() * 900)}`;
}

export class BotController {
  constructor(botId) {
    this.botId = botId;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 1.5;
    this.thinkTimer = 0;
    this.wanderTarget = null;
    this.attackCd = 0.4 + Math.random() * 0.4;
    this.buyTimer = 2.0;
  }

  step(bot, room, dt) {
    if (!bot.alive) return null;

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = -this.strafeDir;
      this.strafeTimer = 0.8 + Math.random() * 1.6;
    }

    this.attackCd = Math.max(0, this.attackCd - dt);
    this.buyTimer -= dt;
    if (this.buyTimer <= 0) {
      this.buyTimer = 3.5;
      this.tryBuyUpgrades(bot, room);
    }

    // Find nearest living enemy
    let target = null;
    let bestDistSq = Infinity;
    for (const other of room.players.values()) {
      if (other.id === bot.id || !other.alive) continue;
      if (room.mode === GAME_MODES.TDM && other.team === bot.team) continue;
      const dx = other.x - bot.x;
      const dy = other.y - bot.y;
      const dz = other.z - bot.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        target = other;
      }
    }

    let moveX = 0;
    let moveZ = 0;
    let jump = false;
    let dash = false;
    let block = false;
    let yaw = bot.yaw;
    let pitch = 0;

    if (room.panPickup && bot.weapon !== 'pan') {
      const pdx = room.panPickup.x - bot.x;
      const pdz = room.panPickup.z - bot.z;
      const pDist = Math.hypot(pdx, pdz);
      if (pDist < 10 && Math.abs(room.panPickup.y - bot.y) < 1.5 && (!target || pDist * pDist < bestDistSq)) {
        const panYaw = Math.atan2(-pdx, -pdz);
        let diff = panYaw - bot.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        yaw = bot.yaw + diff * Math.min(1, dt * 8.5);
        moveZ = 1;
        if (Math.hypot(bot.vx, bot.vz) < 1.5 && bot.grounded) jump = true;
        return {
          seq: ++bot.lastAckSeq,
          moveX: 0,
          moveZ,
          jump,
          dash: false,
          block: false,
          yaw,
          pitch: 0,
        };
      }
    }

    if (target) {
      const dx = target.x - bot.x;
      const dy = (target.y + 1.35) - (bot.y + PLAYER_EYE_HEIGHT);
      const dz = target.z - bot.z;
      const horizDist = Math.hypot(dx, dz);
      const dist = Math.hypot(horizDist, dy);

      // Desired yaw & pitch facing target (Three.js YXZ convention: forward = (-sin(yaw), 0, -cos(yaw)))
      const desiredYaw = Math.atan2(-dx, -dz);
      const desiredPitch = Math.atan2(dy, Math.max(0.01, horizDist));

      // Smooth turn
      let diff = desiredYaw - bot.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      yaw = bot.yaw + diff * Math.min(1, dt * 8.5);
      pitch = bot.pitch + (desiredPitch - bot.pitch) * Math.min(1, dt * 8.5);

      // Line of sight check
      const eye = { x: bot.x, y: bot.y + PLAYER_EYE_HEIGHT, z: bot.z };
      const aimDir = { x: dx / Math.max(0.01, dist), y: dy / Math.max(0.01, dist), z: dz / Math.max(0.01, dist) };
      const wallHit = raycastArena(eye, aimDir, dist, ARENA_BOXES);
      const hasLOS = !wallHit || wallHit.dist >= dist - 0.4;

      if (hasLOS) {
        // Combat strafing & spacing
        moveX = this.strafeDir;
        if (bot.weapon === 'pan') {
          moveZ = dist > 3.2 ? 1 : 0;
        } else {
          if (dist > 13) moveZ = 1;
          else if (dist < 5) moveZ = -0.6;
        }
        if (Math.random() < 0.012 && bot.grounded) jump = true;
        if (bot.hp < 50 && bot.dashCd <= 0 && Math.random() < 0.04) dash = true;

        // Weapon switch based on range (never overwrite a collected Pan)
        if (bot.weapon !== 'pan') {
          if (dist < 4.5 && bot.unlockedWeapons.has('runeblade')) {
            bot.weapon = 'runeblade';
          } else if (dist > 18 && bot.unlockedWeapons.has('rail')) {
            bot.weapon = 'rail';
          } else {
            bot.weapon = 'staff';
          }
        }

        // Fire primary or cast power
        if (this.attackCd <= 0) {
          const aimErr = 0.055;
          const shotYaw = desiredYaw + (Math.random() - 0.5) * aimErr;
          const shotPitch = desiredPitch + (Math.random() - 0.5) * aimErr;

          if (bot.weapon === 'pan') {
            room.handleAction(bot, { kind: 'primary', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.55;
          } else if (bot.unlockedPowers.has('fireball') && (bot.powerCds.fireball || 0) <= 0 && bot.mana >= POWERS.fireball.manaCost && dist > 6 && dist < 26 && Math.random() < 0.35) {
            room.handleAction(bot, { kind: 'power', id: 'fireball', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.45;
          } else if (bot.unlockedPowers.has('souldrain') && (bot.powerCds.souldrain || 0) <= 0 && bot.mana >= POWERS.souldrain.manaCost && dist < 5.5 && bot.hp < bot.maxHp * 0.8) {
            room.handleAction(bot, { kind: 'power', id: 'souldrain', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.45;
          } else {
            room.handleAction(bot, { kind: 'primary', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            const w = WEAPONS[bot.weapon];
            this.attackCd = (w ? w.cooldown : 0.3) + 0.14 + Math.random() * 0.22;
          }
        }
      } else {
        // Navigate around obstacles toward center/jump pads/target
        moveZ = 1;
        if (Math.hypot(bot.vx, bot.vz) < 1.5 && bot.grounded) {
          jump = true;
          moveX = this.strafeDir;
        }
        // Seek nearby jump pad if target is above
        if (target.y > bot.y + 1.5) {
          for (const jp of JUMP_PADS) {
            if (Math.hypot(jp.x - bot.x, jp.z - bot.z) < 8) {
              const jYaw = Math.atan2(-(jp.x - bot.x), -(jp.z - bot.z));
              yaw = jYaw;
              break;
            }
          }
        }
      }
    } else {
      moveZ = 0.8;
      yaw = bot.yaw + dt * 0.8;
    }

    return {
      seq: ++bot.lastAckSeq,
      moveX,
      moveZ,
      jump,
      dash,
      block,
      yaw,
      pitch,
    };
  }

  tryBuyUpgrades(bot, room) {
    if (bot.essence >= 200 && !bot.unlockedWeapons.has('runeblade') && Math.random() < 0.5) {
      room.handleBuy(bot, { category: 'weapon', id: 'runeblade' });
    } else if (bot.essence >= 200 && !bot.unlockedPowers.has('fireball')) {
      room.handleBuy(bot, { category: 'power', id: 'fireball' });
    } else if (bot.essence >= 250 && !bot.unlockedPowers.has('souldrain')) {
      room.handleBuy(bot, { category: 'power', id: 'souldrain' });
    } else if (bot.essence >= 350 && !bot.unlockedWeapons.has('rail')) {
      room.handleBuy(bot, { category: 'weapon', id: 'rail' });
    } else if (bot.essence >= 150) {
      room.handleBuy(bot, { category: 'rune', id: 'vitality' });
    }
  }
}
