import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_PROFILES,
  GAME_MODES,
  PLAYER_EYE_HEIGHT,
  POWERS,
  WEAPONS,
  normalizeBotDifficulty,
} from '../shared/constants.js';
import { clamp, normalizeYaw, raycastArena } from '../shared/physics.js';
import { ARENA_BOXES, JUMP_PADS } from '../shared/arena.js';

const BOT_NAMES = ['Aldric', 'Vespera', 'Kaelen', 'Nyx', 'Seraph', 'Draven', 'Lyra', 'Thane'];
const IDLE_WAYPOINTS = [
  [0, 0],
  [-12, -12],
  [12, -12],
  [-12, 12],
  [12, 12],
];
const HUMAN_KILL_ROAST_EMOTES = ['twerk', 'twerk', 'dance', 'dance', 'spin', 'spin', 'cheer', 'wave', 'bow'];
const ROAST_STYLES = ['shield_tbag', 'spin_flex', 'nod_stare'];

function angleDiff(from, to) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export function createBotName(existingNames) {
  for (const n of BOT_NAMES) {
    if (!existingNames.has(n)) return n;
  }
  return `Soul-${Math.floor(100 + Math.random() * 900)}`;
}

export class BotController {
  constructor(botId, difficulty = BOT_DIFFICULTIES.NORMAL) {
    this.botId = botId;
    this.difficulty = normalizeBotDifficulty(difficulty);
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 1.5;
    this.thinkTimer = 0;
    this.wanderTarget = null;
    this.attackCd = 0.4 + Math.random() * 0.4;
    this.buyTimer = 2.0;

    // Human perception & aim state
    this.currentTargetId = null;
    this.targetCommitTimer = 0;
    this.targetSightTimer = 0;
    this.aimPhase = Math.random() * Math.PI * 2;

    // Human movement & defense state
    this.blockTimer = 0;
    this.idleLookTimer = 0;
    this.idleYawTarget = 0;
    this.idlePauseTimer = 0;

    // Human-roasting / showboat state
    this.roastTimer = 0;
    this.roastStyle = 'spin_flex';
    this.roastPhase = 0;
    this.roastTargetPos = null;
    this.tauntCd = 0;
    this.wiggleTimer = 0;
    this.trickshotTimer = 0;
  }

  getProfile() {
    return BOT_DIFFICULTY_PROFILES[this.difficulty] || BOT_DIFFICULTY_PROFILES.normal;
  }

  setDifficulty(difficulty) {
    this.difficulty = normalizeBotDifficulty(difficulty);
  }

  onScoreKill(bot, victim, room) {
    if (!bot || !bot.alive) return;

    if (victim && !victim.isBot) {
      const emoteId = HUMAN_KILL_ROAST_EMOTES[Math.floor(Math.random() * HUMAN_KILL_ROAST_EMOTES.length)];
      room.handleEmote(bot, emoteId);
      this.roastTimer = 1.65;
      this.roastPhase = 0;
      this.roastTargetPos = { x: victim.x, y: victim.y, z: victim.z };
      this.roastStyle = ROAST_STYLES[Math.floor(Math.random() * ROAST_STYLES.length)];
    } else if (Math.random() < 0.45) {
      const botEmotes = ['dance', 'cheer', 'twerk', 'wave', 'spin'];
      room.handleEmote(bot, botEmotes[Math.floor(Math.random() * botEmotes.length)]);
    }
  }

  onBlockedOrParriedHuman(bot, attacker, room, isParry = false) {
    if (!bot || !bot.alive) return;
    this.wiggleTimer = Math.max(this.wiggleTimer, 0.55);
    if (isParry && this.tauntCd <= 0) {
      const parryEmotes = ['wave', 'twerk', 'spin'];
      room.handleEmote(bot, parryEmotes[Math.floor(Math.random() * parryEmotes.length)]);
      this.tauntCd = 3.5;
    }
  }

  step(bot, room, dt) {
    if (!bot.alive) return null;

    const profile = this.getProfile();

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = -this.strafeDir;
      this.strafeTimer = 0.8 + Math.random() * 1.6;
    }

    this.attackCd = Math.max(0, this.attackCd - dt);
    this.tauntCd = Math.max(0, this.tauntCd - dt);
    this.wiggleTimer = Math.max(0, this.wiggleTimer - dt);
    this.trickshotTimer = Math.max(0, this.trickshotTimer - dt);
    this.blockTimer = Math.max(0, this.blockTimer - dt);
    this.targetCommitTimer = Math.max(0, this.targetCommitTimer - dt);
    this.aimPhase += dt;

    this.buyTimer -= dt;
    if (this.buyTimer <= 0) {
      this.buyTimer = profile.buyInterval;
      this.tryBuyUpgrades(bot, room, profile);
    }

    // Scan living hostile enemies (track nearest + committed target)
    let nearestEnemy = null;
    let bestDistSq = Infinity;
    let committedEnemy = null;
    let committedDistSq = Infinity;
    let immediateDanger = false;

    const botEye = { x: bot.x, y: bot.y + PLAYER_EYE_HEIGHT, z: bot.z };

    for (const other of room.players.values()) {
      if (other.id === bot.id || !other.alive) continue;
      if (room.mode === GAME_MODES.TDM && other.team === bot.team) continue;
      const dx = other.x - bot.x;
      const dy = other.y - bot.y;
      const dz = other.z - bot.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        nearestEnemy = other;
      }
      if (this.currentTargetId && other.id === this.currentTargetId) {
        committedEnemy = other;
        committedDistSq = d2;
      }
      if (this.roastTimer > 0 && d2 < 6.5 * 6.5) {
        const dist = Math.sqrt(d2);
        const dir = {
          x: dx / Math.max(0.01, dist),
          y: (other.y + 1.1 - botEye.y) / Math.max(0.01, dist),
          z: dz / Math.max(0.01, dist),
        };
        const wall = raycastArena(botEye, dir, dist, ARENA_BOXES);
        if (!wall || wall.dist >= dist - 0.4) {
          immediateDanger = true;
        }
      }
    }

    // Active post-kill roast routine (only when safe from immediate close threats)
    if (this.roastTimer > 0) {
      if (immediateDanger) {
        this.roastTimer = 0;
      } else {
        this.roastTimer = Math.max(0, this.roastTimer - dt);
        this.roastPhase += dt;

        let roastYaw = bot.yaw;
        let roastPitch = 0;
        let roastJump = false;
        let roastBlock = false;

        const faceTargetYaw = this.roastTargetPos
          ? Math.atan2(-(this.roastTargetPos.x - bot.x), -(this.roastTargetPos.z - bot.z))
          : bot.yaw;

        if (this.roastStyle === 'spin_flex') {
          roastYaw = normalizeYaw(bot.yaw + dt * 16);
          roastPitch = Math.sin(this.roastPhase * 10) * 0.2;
          roastJump = Boolean(bot.grounded);
          roastBlock = Math.floor(this.roastPhase * 12) % 2 === 0;
        } else if (this.roastStyle === 'shield_tbag') {
          roastYaw = faceTargetYaw;
          roastPitch = -0.36 + Math.sin(this.roastPhase * 16) * 0.14;
          roastBlock = Math.floor(this.roastPhase * 12) % 2 === 0;
          roastJump = Boolean(bot.grounded);
        } else {
          // nod_stare
          roastYaw = normalizeYaw(faceTargetYaw + Math.sin(this.roastPhase * 16) * 0.28);
          roastPitch = Math.sin(this.roastPhase * 18) * 0.35;
          roastBlock = Math.floor(this.roastPhase * 10) % 2 === 0;
        }

        return {
          seq: ++bot.lastAckSeq,
          moveX: 0,
          moveZ: 0,
          jump: roastJump,
          dash: false,
          block: roastBlock,
          yaw: roastYaw,
          pitch: clamp(roastPitch, -Math.PI * 0.47, Math.PI * 0.47),
        };
      }
    }

    // Target selection with human-like target persistence
    let target = null;
    let targetDistSq = Infinity;
    if (
      committedEnemy &&
      this.targetCommitTimer > 0 &&
      (!nearestEnemy || nearestEnemy.id === committedEnemy.id || bestDistSq >= 0.65 * committedDistSq)
    ) {
      target = committedEnemy;
      targetDistSq = committedDistSq;
    } else {
      target = nearestEnemy;
      targetDistSq = bestDistSq;
      if (target && target.id !== this.currentTargetId) {
        this.currentTargetId = target.id;
        this.targetCommitTimer = 1.6 + Math.random() * 1.2;
        this.targetSightTimer = 0;
      } else if (target) {
        this.targetCommitTimer = 1.2;
      }
    }
    if (!target) {
      this.currentTargetId = null;
      this.targetSightTimer = 0;
    }

    let moveX = 0;
    let moveZ = 0;
    let jump = false;
    let dash = false;
    let block = false;
    let yaw = bot.yaw;
    let pitch = bot.pitch || 0;

    if (room.panPickup && bot.weapon !== 'pan') {
      const pdx = room.panPickup.x - bot.x;
      const pdz = room.panPickup.z - bot.z;
      const pDist = Math.hypot(pdx, pdz);
      if (pDist < 10 && Math.abs(room.panPickup.y - bot.y) < 1.5 && (!target || pDist * pDist < targetDistSq)) {
        const panYaw = Math.atan2(-pdx, -pdz);
        yaw = normalizeYaw(bot.yaw + angleDiff(bot.yaw, panYaw) * Math.min(1, dt * profile.turnSpeed));
        moveZ = profile.moveSpeedScale;
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
      const dy = (target.y + profile.aimHeightOffset) - (bot.y + PLAYER_EYE_HEIGHT);
      const dz = target.z - bot.z;
      const horizDist = Math.hypot(dx, dz);
      const dist = Math.hypot(horizDist, dy);

      // Desired yaw & pitch facing target (Three.js YXZ convention: forward = (-sin(yaw), 0, -cos(yaw)))
      const desiredYaw = Math.atan2(-dx, -dz);
      const desiredPitch = clamp(Math.atan2(dy, Math.max(0.01, horizDist)), -Math.PI * 0.45, Math.PI * 0.45);

      // Organic aim sway so bots track like a human hand instead of robotic pixel lock
      const swayYaw = Math.sin(this.aimPhase * 2.2) * profile.aimSpread * 0.45;
      const swayPitch = Math.cos(this.aimPhase * 1.7) * profile.aimSpread * 0.3;
      const aimTargetYaw = desiredYaw + swayYaw;
      const aimTargetPitch = clamp(desiredPitch + swayPitch, -Math.PI * 0.45, Math.PI * 0.45);

      // Smooth turn capped by difficulty turnSpeed
      const turnAlpha = Math.min(1, dt * profile.turnSpeed);
      if (this.trickshotTimer > 0) {
        yaw = normalizeYaw(bot.yaw + dt * 19);
        pitch = bot.pitch + (aimTargetPitch - bot.pitch) * turnAlpha;
      } else {
        yaw = normalizeYaw(bot.yaw + angleDiff(bot.yaw, aimTargetYaw) * turnAlpha);
        pitch = bot.pitch + (aimTargetPitch - bot.pitch) * turnAlpha;
      }

      // Line of sight check
      const aimDir = { x: dx / Math.max(0.01, dist), y: dy / Math.max(0.01, dist), z: dz / Math.max(0.01, dist) };
      const wallHit = raycastArena(botEye, aimDir, dist, ARENA_BOXES);
      const hasLOS = !wallHit || wallHit.dist >= dist - 0.4;

      if (hasLOS) {
        this.targetSightTimer += dt;

        // Combat strafing & spacing scaled by difficulty
        moveX = this.strafeDir * profile.moveSpeedScale;
        if (bot.weapon === 'pan') {
          moveZ = (dist > 3.2 ? 1 : 0) * profile.moveSpeedScale;
        } else {
          if (dist > 13) moveZ = profile.moveSpeedScale;
          else if (dist < 5) moveZ = -0.6 * profile.moveSpeedScale;
        }
        if (Math.random() < profile.jumpChance && bot.grounded) jump = true;
        if (bot.hp < 50 && bot.dashCd <= 0 && Math.random() < profile.dashChance) dash = true;

        // Occasional defensive shield blocking
        if (bot.weapon !== 'rail' && bot.weapon !== 'pan' && bot.stamina > 30) {
          if (this.blockTimer <= 0 && dist < 16 && bot.hp < bot.maxHp * 0.7 && Math.random() < profile.blockChance * dt * 2.5) {
            this.blockTimer = 0.35 + Math.random() * 0.35;
          }
          if (this.blockTimer > 0) {
            block = true;
          }
        }

        // Mid-fight roasting / disrespect when fighting human players
        if (!target.isBot) {
          const hasAdvantage = target.hp <= 45 && bot.hp >= 75;
          if (hasAdvantage || (this.attackCd > 0.25 && dist > 6)) {
            if (this.wiggleTimer <= 0 && Math.random() < 0.015 * profile.roastChance) {
              this.wiggleTimer = 0.5;
            }
            if (this.tauntCd <= 0 && Math.random() < 0.008 * profile.roastChance) {
              const midTaunts = ['wave', 'twerk', 'spin', 'cheer'];
              room.handleEmote(bot, midTaunts[Math.floor(Math.random() * midTaunts.length)]);
              this.tauntCd = 6.0;
            }
          }
          if (
            this.difficulty !== BOT_DIFFICULTIES.EASY &&
            (!bot.grounded || hasAdvantage) &&
            this.trickshotTimer <= 0 &&
            this.attackCd <= 0.08 &&
            this.tauntCd <= 0 &&
            Math.random() < 0.012 * profile.roastChance
          ) {
            this.trickshotTimer = 0.38;
            this.tauntCd = 5.0;
          }
        }

        if (this.wiggleTimer > 0) {
          block = Math.floor(this.aimPhase * 12) % 2 === 0;
          pitch = clamp(pitch + Math.sin(this.aimPhase * 22) * 0.14, -Math.PI * 0.45, Math.PI * 0.45);
        }

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

        // Fair human-like firing: wait for reactionDelay AND wait until facing the target
        const aimErrorAngle = Math.hypot(angleDiff(yaw, desiredYaw), pitch - desiredPitch);
        const readyToReact =
          this.targetSightTimer >= profile.reactionDelay ||
          (bot.weapon === 'pan' && dist <= WEAPONS.pan.meleeRange);

        if (
          this.attackCd <= 0 &&
          readyToReact &&
          aimErrorAngle <= profile.maxFireAngle &&
          this.trickshotTimer <= 0
        ) {
          block = false;
          const shotYaw = yaw + (Math.random() - 0.5) * profile.aimSpread;
          const shotPitch = clamp(pitch + (Math.random() - 0.5) * profile.aimSpread, -Math.PI * 0.47, Math.PI * 0.47);
          const delaySpread = profile.attackDelayMin + Math.random() * (profile.attackDelayMax - profile.attackDelayMin);

          if (bot.weapon === 'pan') {
            room.handleAction(bot, { kind: 'primary', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.55 + profile.attackDelayMin * 0.4;
          } else if (
            bot.unlockedPowers.has('fireball') &&
            (bot.powerCds.fireball || 0) <= 0 &&
            bot.mana >= POWERS.fireball.manaCost &&
            dist > 6 &&
            dist < 26 &&
            Math.random() < profile.spellChance
          ) {
            room.handleAction(bot, { kind: 'power', id: 'fireball', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.45 + profile.attackDelayMin * 0.5;
          } else if (
            bot.unlockedPowers.has('souldrain') &&
            (bot.powerCds.souldrain || 0) <= 0 &&
            bot.mana >= POWERS.souldrain.manaCost &&
            dist < 5.5 &&
            bot.hp < bot.maxHp * 0.8 &&
            Math.random() < Math.min(0.9, profile.spellChance * 2.2)
          ) {
            room.handleAction(bot, { kind: 'power', id: 'souldrain', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            this.attackCd = 0.45 + profile.attackDelayMin * 0.5;
          } else {
            room.handleAction(bot, { kind: 'primary', yaw: shotYaw, pitch: shotPitch, viewTime: room.now });
            const w = WEAPONS[bot.weapon];
            this.attackCd = (w ? w.cooldown : 0.3) + delaySpread;
          }
        }
      } else {
        this.targetSightTimer = Math.max(0, this.targetSightTimer - dt * 2.5);

        // Navigate around obstacles toward center/jump pads/target
        moveZ = profile.moveSpeedScale;
        if (Math.hypot(bot.vx, bot.vz) < 1.5 && bot.grounded) {
          jump = true;
          moveX = this.strafeDir * profile.moveSpeedScale;
        }
        // Seek nearby jump pad if target is above
        if (target.y > bot.y + 1.5) {
          for (const jp of JUMP_PADS) {
            if (Math.hypot(jp.x - bot.x, jp.z - bot.z) < 8) {
              const jYaw = Math.atan2(-(jp.x - bot.x), -(jp.z - bot.z));
              yaw = normalizeYaw(bot.yaw + angleDiff(bot.yaw, jYaw) * Math.min(1, dt * profile.turnSpeed));
              break;
            }
          }
        }
      }
    } else {
      // Human-like idle wandering across arena waypoints with brief glancing pauses
      if (!this.wanderTarget) {
        this.wanderTarget = IDLE_WAYPOINTS[Math.floor(Math.random() * IDLE_WAYPOINTS.length)];
      }
      const wx = this.wanderTarget[0] - bot.x;
      const wz = this.wanderTarget[1] - bot.z;
      const wDist = Math.hypot(wx, wz);
      if (wDist < 2.2) {
        this.wanderTarget = IDLE_WAYPOINTS[Math.floor(Math.random() * IDLE_WAYPOINTS.length)];
        this.idlePauseTimer = 0.6 + Math.random() * 1.1;
      }

      if (this.idlePauseTimer > 0) {
        this.idlePauseTimer -= dt;
        this.idleLookTimer -= dt;
        if (this.idleLookTimer <= 0) {
          this.idleYawTarget = normalizeYaw(bot.yaw + (Math.random() - 0.5) * 1.6);
          this.idleLookTimer = 0.45 + Math.random() * 0.5;
        }
        yaw = normalizeYaw(bot.yaw + angleDiff(bot.yaw, this.idleYawTarget) * Math.min(1, dt * profile.turnSpeed * 0.6));
        pitch = bot.pitch * 0.9;
      } else {
        const wYaw = Math.atan2(-wx, -wz);
        yaw = normalizeYaw(bot.yaw + angleDiff(bot.yaw, wYaw) * Math.min(1, dt * profile.turnSpeed * 0.7));
        pitch = bot.pitch * 0.9;
        moveZ = 0.72 * profile.moveSpeedScale;
        if (Math.hypot(bot.vx, bot.vz) < 1.0 && bot.grounded) {
          jump = true;
        }
      }
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

  tryBuyUpgrades(bot, room, profile = this.getProfile()) {
    if (bot.essence >= 200 && !bot.unlockedWeapons.has('runeblade') && Math.random() < 0.5) {
      room.handleBuy(bot, { category: 'weapon', id: 'runeblade' });
    } else if (bot.essence >= 200 && !bot.unlockedPowers.has('fireball')) {
      room.handleBuy(bot, { category: 'power', id: 'fireball' });
    } else if (bot.essence >= 250 && !bot.unlockedPowers.has('souldrain')) {
      room.handleBuy(bot, { category: 'power', id: 'souldrain' });
    } else if (profile.allowRail && bot.essence >= 350 && !bot.unlockedWeapons.has('rail')) {
      room.handleBuy(bot, { category: 'weapon', id: 'rail' });
    } else if (bot.essence >= 150 && (bot.runes?.vitality || 0) < profile.maxVitalityRank) {
      room.handleBuy(bot, { category: 'rune', id: 'vitality' });
    }
  }
}
