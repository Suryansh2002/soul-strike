import { GAME_MODES, HEAD_CENTER_OFFSET, WEAPONS } from '../shared/constants.js';
import { ARENA_BOXES } from '../shared/arena.js';
import { clamp, getAimDirection, lerp, raycastArena, raycastPlayerHitbox } from '../shared/physics.js';

const WEAPON_ASSIST = {
  staff: {
    assistRange: WEAPONS.staff.range,
    autoFireRange: WEAPONS.staff.range,
    hitboxPad: 0.12,
    lockDelay: 0.025,
  },
  runeblade: {
    assistRange: WEAPONS.runeblade.waveRange,
    autoFireRange: WEAPONS.runeblade.waveRange,
    hitboxPad: 0.14,
    lockDelay: 0.02,
  },
  rail: {
    assistRange: WEAPONS.rail.range,
    autoFireRange: WEAPONS.rail.range,
    hitboxPad: 0.04,
    lockDelay: 0.075,
    scopedLockDelay: 0.14,
  },
  pan: {
    assistRange: 28,
    // Never auto-throw the single-charge Golden Pan at distant enemies; only auto-swing in guaranteed melee range
    autoFireRange: WEAPONS.pan.meleeRange,
    hitboxPad: 0.24,
    lockDelay: 0,
  },
};

export function normalizeAngleDiff(targetYaw, currentYaw) {
  return Math.atan2(Math.sin(targetYaw - currentYaw), Math.cos(targetYaw - currentYaw));
}

export function computeTouchLookDelta(dx, dy, baseSensitivity, zoomScale = 1.0, assistSlowdown = 1.0) {
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) return { dYaw: 0, dPitch: 0 };

  const rawAccel =
    dist <= 2.5
      ? 0.92 + (dist / 2.5) * 0.08
      : Math.min(1.72, 1.0 + Math.min(30, dist - 2.5) * 0.024);

  const safeSlowdown = clamp(assistSlowdown, 0, 1);
  const accel = lerp(1.0, rawAccel, safeSlowdown);
  const effSens = baseSensitivity * zoomScale * safeSlowdown * accel;

  return {
    dYaw: -dx * effSens,
    dPitch: -dy * effSens * 0.78,
  };
}

export function evaluateMobileCombatAssist({
  eye,
  yaw,
  pitch,
  weaponId = 'staff',
  scoped = false,
  enemies = [],
  myId = null,
  myTeam = 0,
  mode = GAME_MODES.FFA,
  boxes = ARENA_BOXES,
  dt = 1 / 60,
  isActivelyAimingOrMoving = false,
  aimAssistEnabled = true,
  autoFireEnabled = true,
  lockTimer = 0,
} = {}) {
  if (!eye || !Array.isArray(enemies)) {
    return {
      dYaw: 0,
      dPitch: 0,
      slowdown: 1.0,
      targetLocked: false,
      shouldAutoFire: false,
      lockTimer: 0,
      lockedTargetId: null,
    };
  }

  const cfg = WEAPON_ASSIST[weaponId] || WEAPON_ASSIST.staff;
  const lockDelay = weaponId === 'rail' && scoped ? cfg.scopedLockDelay : cfg.lockDelay;

  const validEnemies = enemies.filter(
    (e) => e && e.al && e.id !== myId && (mode !== GAME_MODES.TDM || e.tm !== myTeam)
  );

  const aimDir = getAimDirection(yaw, pitch);
  let targetLocked = false;
  let lockedTargetId = null;
  let closestHitDist = cfg.autoFireRange;

  for (let i = 0; i < validEnemies.length; i++) {
    const e = validEnemies[i];
    const hit = raycastPlayerHitbox(eye, aimDir, cfg.autoFireRange, e, cfg.hitboxPad);
    if (!hit || (targetLocked && hit.dist >= closestHitDist)) continue;
    const wall = raycastArena(eye, aimDir, hit.dist, boxes);
    if (wall && wall.dist < hit.dist - 0.15) continue;
    closestHitDist = hit.dist;
    targetLocked = true;
    lockedTargetId = e.id;
  }

  const maxConeRad = scoped ? 0.085 : 0.145;
  let dYaw = 0;
  let dPitch = 0;
  let slowdown = 1.0;

  if (aimAssistEnabled && validEnemies.length > 0) {
    let bestAng = maxConeRad;
    let bestYawErr = 0;
    let bestPitchErr = 0;

    for (let i = 0; i < validEnemies.length; i++) {
      const e = validEnemies[i];
      const aimY = e.y + (scoped && weaponId === 'rail' ? HEAD_CENTER_OFFSET : 1.24);
      const dx = e.x - eye.x;
      const dy = aimY - eye.y;
      const dz = e.z - eye.z;
      const horizDist = Math.hypot(dx, dz);
      const dist3D = Math.hypot(dx, dy, dz);
      if (dist3D < 0.2 || dist3D > cfg.assistRange) continue;

      const toEnemy = { x: dx / dist3D, y: dy / dist3D, z: dz / dist3D };
      const wall = raycastArena(eye, toEnemy, dist3D, boxes);
      if (wall && wall.dist < dist3D - 0.3) continue;

      const targetYaw = Math.atan2(-dx, -dz);
      const targetPitch = Math.atan2(dy, horizDist);
      const yawErr = normalizeAngleDiff(targetYaw, yaw);
      const pitchErr = targetPitch - pitch;
      const angDist = Math.hypot(yawErr, pitchErr);

      if (angDist < bestAng) {
        bestAng = angDist;
        bestYawErr = yawErr;
        bestPitchErr = pitchErr;
      }
    }

    if (bestAng < maxConeRad) {
      const coneT = 1 - bestAng / maxConeRad;
      slowdown = targetLocked ? 0.70 : lerp(1.0, 0.72, coneT);
      if (isActivelyAimingOrMoving && bestAng > 0.003) {
        const pullRate = (scoped ? 1.75 : 2.65) * (0.45 + 0.55 * coneT);
        const stepFrac = Math.min(0.65, pullRate * dt);
        dYaw = bestYawErr * stepFrac;
        dPitch = bestPitchErr * stepFrac;
      }
    } else if (targetLocked) {
      slowdown = 0.70;
    }
  }

  const nextLockTimer = targetLocked ? lockTimer + dt : Math.max(0, lockTimer - dt * 3.5);
  const shouldAutoFire = Boolean(autoFireEnabled && targetLocked && nextLockTimer >= lockDelay);

  return {
    dYaw,
    dPitch,
    slowdown,
    targetLocked,
    shouldAutoFire,
    lockTimer: nextLockTimer,
    lockedTargetId,
  };
}
