import {
  AIR_ACCEL,
  BASE_MOVE_SPEED,
  BLOCK_STAMINA_DRAIN,
  DASH_COOLDOWN,
  DASH_COST,
  DASH_DURATION,
  DASH_SPEED,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  HEAD_CENTER_OFFSET,
  HEAD_RADIUS,
  JUMP_SPEED,
  MAX_STAMINA_BASE,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STAMINA_REGEN_BASE,
  STEP_HEIGHT,
} from './constants.js';
import { ARENA_BOXES, JUMP_PADS } from './arena.js';

export function clamp(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function finiteNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeYaw(yaw) {
  const y = finiteNum(yaw, 0);
  return Math.atan2(Math.sin(y), Math.cos(y));
}

export function getAimDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

export function getEyePosition(state) {
  return {
    x: state.x,
    y: state.y + PLAYER_EYE_HEIGHT,
    z: state.z,
  };
}

/**
 * Deterministic player movement & arena collision step shared identically by client prediction & server.
 */
export function stepPlayerPhysics(state, input, dt, boxes = ARENA_BOXES, jumpPads = JUMP_PADS) {
  if (!state.alive) return;

  const windRank = state.windRank || 0;
  const speedMult = (1 + windRank * 0.09) * (state.slowTimer > 0 ? 0.6 : 1.0) * (input.block ? 0.62 : 1.0);
  const staminaRegen = STAMINA_REGEN_BASE * (1 + windRank * 0.15);

  if (state.slowTimer > 0) state.slowTimer = Math.max(0, state.slowTimer - dt);
  if (state.dashTimer > 0) state.dashTimer = Math.max(0, state.dashTimer - dt);
  if (state.dashCd > 0) state.dashCd = Math.max(0, state.dashCd - dt);
  if (state.jumpPadCd > 0) state.jumpPadCd = Math.max(0, state.jumpPadCd - dt);
  if (state.coyoteTimer > 0) state.coyoteTimer = Math.max(0, state.coyoteTimer - dt);

  // Stamina drain while blocking or regen otherwise
  if (input.block && state.stamina > 0) {
    state.stamina = Math.max(0, state.stamina - BLOCK_STAMINA_DRAIN * dt);
  } else if (state.dashTimer <= 0) {
    state.stamina = Math.min(MAX_STAMINA_BASE, state.stamina + staminaRegen * dt);
  }

  // Forward / right horizontal basis from yaw (YXZ convention)
  const sinY = Math.sin(input.yaw);
  const cosY = Math.cos(input.yaw);
  const fwdX = -sinY;
  const fwdZ = -cosY;
  const rightX = cosY;
  const rightZ = -sinY;

  let wishX = rightX * input.moveX + fwdX * input.moveZ;
  let wishZ = rightZ * input.moveX + fwdZ * input.moveZ;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 0.001) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  // Trigger Soul Dash
  if (input.dash && state.dashCd <= 0 && state.stamina >= DASH_COST && state.dashTimer <= 0) {
    state.stamina -= DASH_COST;
    state.dashTimer = DASH_DURATION;
    state.dashCd = DASH_COOLDOWN;
    const dx = wishLen > 0.001 ? wishX : fwdX;
    const dz = wishLen > 0.001 ? wishZ : fwdZ;
    state.vx = dx * DASH_SPEED;
    state.vz = dz * DASH_SPEED;
    if (state.vy < 1.5) state.vy = 1.5;
    state.justDashed = true;
  } else {
    state.justDashed = false;
  }

  // Acceleration / friction when not actively dashing
  if (state.dashTimer <= 0) {
    const maxSpeed = BASE_MOVE_SPEED * speedMult;

    if (state.grounded) {
      const speed = Math.hypot(state.vx, state.vz);
      if (speed > 0.001) {
        const drop = speed * GROUND_FRICTION * dt;
        const newSpeed = Math.max(0, speed - drop);
        const scale = newSpeed / speed;
        state.vx *= scale;
        state.vz *= scale;
      }
    }

    const accel = state.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const targetVx = wishX * maxSpeed;
    const targetVz = wishZ * maxSpeed;

    if (state.grounded) {
      const dvx = targetVx - state.vx;
      const dvz = targetVz - state.vz;
      const dLen = Math.hypot(dvx, dvz);
      const maxAdd = accel * dt;
      if (dLen > maxAdd && dLen > 0.0001) {
        state.vx += (dvx / dLen) * maxAdd;
        state.vz += (dvz / dLen) * maxAdd;
      } else {
        state.vx = targetVx;
        state.vz = targetVz;
      }
    } else if (wishLen > 0.001) {
      // Air strafe control
      const curProj = state.vx * wishX + state.vz * wishZ;
      const addSpeed = maxSpeed - curProj;
      if (addSpeed > 0) {
        const accelSpeed = Math.min(addSpeed, accel * maxSpeed * dt * 0.25);
        state.vx += wishX * accelSpeed;
        state.vz += wishZ * accelSpeed;
      }
    }
  }

  // Jump (with coyote time)
  if (input.jump && (state.grounded || state.coyoteTimer > 0)) {
    state.vy = JUMP_SPEED;
    state.grounded = false;
    state.coyoteTimer = 0;
  }

  // Gravity
  const gravScale = state.dashTimer > 0 ? 0.35 : 1.0;
  state.vy -= GRAVITY * gravScale * dt;

  // Move & collide horizontally (X/Z) with step-up support
  const nextX = state.x + state.vx * dt;
  const nextZ = state.z + state.vz * dt;
  resolveHorizontalWithStep(state, nextX, nextZ, boxes);

  // Move & collide vertically (Y)
  const prevGrounded = state.grounded;
  state.y += state.vy * dt;
  state.grounded = false;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!overlapsCylinderXZ(state.x, state.z, PLAYER_RADIUS * 0.96, b)) continue;

    if (state.vy <= 0 && state.y <= b.maxY && state.y + PLAYER_HEIGHT > b.maxY && state.y >= b.maxY - 0.85) {
      state.y = b.maxY;
      state.vy = 0;
      state.grounded = true;
    } else if (state.vy > 0 && state.y + PLAYER_HEIGHT >= b.minY && state.y < b.minY) {
      state.y = b.minY - PLAYER_HEIGHT;
      state.vy = 0;
    }
  }

  if (prevGrounded && !state.grounded && state.vy <= 0) {
    state.coyoteTimer = 0.11;
  }

  // Safety floor clamp
  if (state.y < -10) {
    state.y = 0.1;
    state.vy = 0;
    state.grounded = true;
  }

  // Arcane Jump Pads
  state.justJumpPadded = false;
  if (state.jumpPadCd <= 0) {
    for (let i = 0; i < jumpPads.length; i++) {
      const jp = jumpPads[i];
      const dx = state.x - jp.x;
      const dz = state.z - jp.z;
      if (Math.abs(state.y - jp.y) < 1.1 && dx * dx + dz * dz <= jp.radius * jp.radius) {
        state.vy = jp.boostY;
        state.vx += jp.boostX;
        state.vz += jp.boostZ;
        state.grounded = false;
        state.jumpPadCd = 0.45;
        state.justJumpPadded = true;
        break;
      }
    }
  }

  state.yaw = input.yaw;
  state.pitch = clamp(input.pitch, -Math.PI * 0.48, Math.PI * 0.48);
}

function overlapsCylinderXZ(px, pz, r, box) {
  const cx = clamp(px, box.minX, box.maxX);
  const cz = clamp(pz, box.minZ, box.maxZ);
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz < r * r;
}

function resolveHorizontalWithStep(state, targetX, targetZ, boxes) {
  state.x = targetX;
  state.z = targetZ;

  // First try resolving; if hitting a low step <= STEP_HEIGHT, step up smoothly
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (state.y >= b.maxY - 0.001 || state.y + PLAYER_HEIGHT <= b.minY + 0.001) continue;

      const cx = clamp(state.x, b.minX, b.maxX);
      const cz = clamp(state.z, b.minZ, b.maxZ);
      const dx = state.x - cx;
      const dz = state.z - cz;
      const distSq = dx * dx + dz * dz;

      if (distSq >= PLAYER_RADIUS * PLAYER_RADIUS) continue;

      // Check step-up feasibility
      const stepDelta = b.maxY - state.y;
      if (stepDelta > 0 && stepDelta <= STEP_HEIGHT && state.vy <= 2.0) {
        if (!hasCeilingCollision(state.x, b.maxY, state.z, boxes)) {
          state.y = b.maxY;
          state.vy = Math.max(0, state.vy);
          state.grounded = true;
          continue;
        }
      }

      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = PLAYER_RADIUS - dist;
        const nx = dx / dist;
        const nz = dz / dist;
        state.x += nx * push;
        state.z += nz * push;
        const vn = state.vx * nx + state.vz * nz;
        if (vn < 0) {
          state.vx -= vn * nx;
          state.vz -= vn * nz;
        }
      } else {
        // Center inside AABB: push out via nearest face
        const left = state.x - b.minX;
        const right = b.maxX - state.x;
        const front = state.z - b.minZ;
        const back = b.maxZ - state.z;
        const minPen = Math.min(left, right, front, back);
        if (minPen === left) {
          state.x = b.minX - PLAYER_RADIUS;
          state.vx = Math.min(0, state.vx);
        } else if (minPen === right) {
          state.x = b.maxX + PLAYER_RADIUS;
          state.vx = Math.max(0, state.vx);
        } else if (minPen === front) {
          state.z = b.minZ - PLAYER_RADIUS;
          state.vz = Math.min(0, state.vz);
        } else {
          state.z = b.maxZ + PLAYER_RADIUS;
          state.vz = Math.max(0, state.vz);
        }
      }
    }
  }
}

function hasCeilingCollision(x, newY, z, boxes) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (newY >= b.maxY - 0.01 || newY + PLAYER_HEIGHT <= b.minY + 0.01) continue;
    if (overlapsCylinderXZ(x, z, PLAYER_RADIUS * 0.9, b)) return true;
  }
  return false;
}

/**
 * Ray vs Arena static AABBs. Returns nearest hit { dist, point, normal, box } or null.
 */
export function raycastArena(origin, dir, maxDist, boxes = ARENA_BOXES) {
  let closestDist = maxDist;
  let hitBox = null;
  let hitNormal = null;

  const invX = Math.abs(dir.x) > 1e-8 ? 1 / dir.x : 1e8;
  const invY = Math.abs(dir.y) > 1e-8 ? 1 / dir.y : 1e8;
  const invZ = Math.abs(dir.z) > 1e-8 ? 1 / dir.z : 1e8;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];

    const tx1 = (b.minX - origin.x) * invX;
    const tx2 = (b.maxX - origin.x) * invX;
    let tmin = Math.min(tx1, tx2);
    let tmax = Math.max(tx1, tx2);
    let nAxis = 0;
    let nSign = tx1 < tx2 ? -1 : 1;

    const ty1 = (b.minY - origin.y) * invY;
    const ty2 = (b.maxY - origin.y) * invY;
    const tyMin = Math.min(ty1, ty2);
    const tyMax = Math.max(ty1, ty2);
    if (tyMin > tmin) {
      tmin = tyMin;
      nAxis = 1;
      nSign = ty1 < ty2 ? -1 : 1;
    }
    tmax = Math.min(tmax, tyMax);

    const tz1 = (b.minZ - origin.z) * invZ;
    const tz2 = (b.maxZ - origin.z) * invZ;
    const tzMin = Math.min(tz1, tz2);
    const tzMax = Math.max(tz1, tz2);
    if (tzMin > tmin) {
      tmin = tzMin;
      nAxis = 2;
      nSign = tz1 < tz2 ? -1 : 1;
    }
    tmax = Math.min(tmax, tzMax);

    if (tmax >= Math.max(0, tmin) && tmin < closestDist && tmin >= 0) {
      closestDist = tmin;
      hitBox = b;
      hitNormal = {
        x: nAxis === 0 ? nSign : 0,
        y: nAxis === 1 ? nSign : 0,
        z: nAxis === 2 ? nSign : 0,
      };
    }
  }

  if (!hitBox) return null;
  return {
    dist: closestDist,
    point: {
      x: origin.x + dir.x * closestDist,
      y: origin.y + dir.y * closestDist,
      z: origin.z + dir.z * closestDist,
    },
    normal: hitNormal,
    box: hitBox,
  };
}

/**
 * Ray vs sphere helper.
 */
function raycastSphere(origin, dir, center, radius, maxDist) {
  const ocX = origin.x - center.x;
  const ocY = origin.y - center.y;
  const ocZ = origin.z - center.z;
  const b = ocX * dir.x + ocY * dir.y + ocZ * dir.z;
  const c = ocX * ocX + ocY * ocY + ocZ * ocZ - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  let t = -b - sqrtD;
  if (t < 0) t = -b + sqrtD;
  if (t < 0 || t > maxDist) return null;
  return t;
}

/**
 * Ray vs upright finite cylinder (body hitbox).
 */
function raycastCylinder(origin, dir, basePos, radius, height, maxDist) {
  const ox = origin.x - basePos.x;
  const oz = origin.z - basePos.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  let bestT = null;

  if (a > 1e-8) {
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtD = Math.sqrt(disc);
      const t1 = (-b - sqrtD) / (2 * a);
      const t2 = (-b + sqrtD) / (2 * a);
      for (const t of [t1, t2]) {
        if (t >= 0 && t <= maxDist) {
          const py = origin.y + dir.y * t;
          if (py >= basePos.y && py <= basePos.y + height) {
            if (bestT === null || t < bestT) bestT = t;
          }
        }
      }
    }
  }

  return bestT;
}

/**
 * Raycast against a target player's head sphere + body cylinder.
 * Returns { dist, headshot, point } or null.
 */
export function raycastPlayerHitbox(origin, dir, maxDist, playerPos, extraRadius = 0) {
  const headCenter = {
    x: playerPos.x,
    y: playerPos.y + HEAD_CENTER_OFFSET,
    z: playerPos.z,
  };
  const headT = raycastSphere(origin, dir, headCenter, HEAD_RADIUS + 0.02 + extraRadius, maxDist);
  const bodyT = raycastCylinder(origin, dir, playerPos, PLAYER_RADIUS + extraRadius, PLAYER_HEIGHT - 0.46, maxDist);

  if (headT !== null && (bodyT === null || headT <= bodyT + 0.25)) {
    return {
      dist: headT,
      headshot: true,
      point: {
        x: origin.x + dir.x * headT,
        y: origin.y + dir.y * headT,
        z: origin.z + dir.z * headT,
      },
    };
  }
  if (bodyT !== null) {
    return {
      dist: bodyT,
      headshot: false,
      point: {
        x: origin.x + dir.x * bodyT,
        y: origin.y + dir.y * bodyT,
        z: origin.z + dir.z * bodyT,
      },
    };
  }
  return null;
}
