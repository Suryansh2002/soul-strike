import { TEAMS } from './constants.js';

export const ARENA_HALF_SIZE = 24; // 48m x 48m arena

/**
 * Axis-aligned bounding boxes representing static solid geometry.
 * Each box: { id, x, y, z, w, h, d, kind } where (x, y, z) is the center.
 */
export function buildArenaBoxes() {
  const boxes = [];
  const add = (id, x, y, z, w, h, d, kind = 'stone') => {
    boxes.push({
      id,
      x,
      y,
      z,
      w,
      h,
      d,
      minX: x - w / 2,
      maxX: x + w / 2,
      minY: y - h / 2,
      maxY: y + h / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2,
      kind,
    });
  };

  // Main ground floor (top surface at y = 0)
  add('floor', 0, -1, 0, 52, 2, 52, 'grass_floor');

  // Outer perimeter walls (top at y = 9)
  const S = ARENA_HALF_SIZE;
  add('wall_n', 0, 4.5, -S - 1, 52, 9, 2, 'garden_wall');
  add('wall_s', 0, 4.5, S + 1, 52, 9, 2, 'garden_wall');
  add('wall_w', -S - 1, 4.5, 0, 2, 9, 50, 'garden_wall');
  add('wall_e', S + 1, 4.5, 0, 2, 9, 50, 'garden_wall');

  // Central Sunlit Shrine Plaza (platform top at y = 2.0)
  add('altar_base', 0, 1.0, 0, 10, 2.0, 10, 'cobble');
  // Central Sun Obelisk spire in exact center (cover + landmark)
  add('altar_obelisk', 0, 4.5, 0, 1.8, 5.0, 1.8, 'sun_pillar');

  // 4 stepped stairs onto the Central Plaza (4 steps each side, 0.5m rise per step)
  const stepWidths = 4.6;
  for (let i = 0; i < 4; i++) {
    const h = (i + 1) * 0.5;
    const dist = 5 + (3 - i) * 1.1 + 0.55;
    add(`stair_n_${i}`, 0, h / 2, -dist, stepWidths, h, 1.1, 'cobble');
    add(`stair_s_${i}`, 0, h / 2, dist, stepWidths, h, 1.1, 'cobble');
    add(`stair_w_${i}`, -dist, h / 2, 0, 1.1, h, stepWidths, 'cobble');
    add(`stair_e_${i}`, dist, h / 2, 0, 1.1, h, stepWidths, 'cobble');
  }

  // 4 Mid Cover Pillars around the central ring (stone & timber watch-pillars)
  const midPillarCoords = [
    [-9.5, -9.5],
    [9.5, -9.5],
    [-9.5, 9.5],
    [9.5, 9.5],
  ];
  midPillarCoords.forEach(([px, pz], idx) => {
    add(`mid_pillar_${idx}`, px, 2.2, pz, 2.2, 4.4, 2.2, 'timber_pillar');
  });

  // 4 Low tactical Golden Hay Bale & Crate walls for peek cover
  add('cover_nw_w', -14.5, 0.75, -5.5, 1.2, 1.5, 4.4, 'hay');
  add('cover_sw_w', -14.5, 0.75, 5.5, 1.2, 1.5, 4.4, 'hay');
  add('cover_ne_e', 14.5, 0.75, -5.5, 1.2, 1.5, 4.4, 'hay');
  add('cover_se_e', 14.5, 0.75, 5.5, 1.2, 1.5, 4.4, 'hay');

  // 4 Elevated Corner Loft Towers (top at y = 3.6)
  const corners = [
    [-18.5, -18.5],
    [18.5, -18.5],
    [-18.5, 18.5],
    [18.5, 18.5],
  ];
  corners.forEach(([cx, cz], idx) => {
    // Platform deck (wooden loft slab)
    add(`bastion_deck_${idx}`, cx, 3.3, cz, 9.0, 0.6, 9.0, 'wood_deck');
    // Main outer-corner stone support column
    const sx = cx > 0 ? cx + 3.2 : cx - 3.2;
    const sz = cz > 0 ? cz + 3.2 : cz - 3.2;
    add(`bastion_col_${idx}`, sx, 1.5, sz, 2.0, 3.0, 2.0, 'cobble');
    // Timber support posts under the other 3 deck corners (deck no longer floats on one column)
    for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const postX = cx + ox * 4.1;
      const postZ = cz + oz * 4.1;
      if (Math.abs(postX) > Math.abs(cx) && Math.abs(postZ) > Math.abs(cz)) continue;
      add(`bastion_post_${idx}_${ox}_${oz}`, postX, 1.5, postZ, 0.6, 3.0, 0.6, 'timber_pillar');
    }
    // Hay parapet on the deck edge facing the arena centre along Z.
    // (Previously it sat on the X edge and blocked the sky-bridge entrance.)
    const pz = cz > 0 ? cz - 4.1 : cz + 4.1;
    add(`bastion_rail_${idx}`, cx, 4.1, pz, 4.5, 1.0, 0.7, 'wood_rail');
  });

  // 2 High Wooden Sky-Bridges connecting North & South towers (top at y = 3.6)
  add('bridge_n', 0, 3.35, -18.5, 28, 0.5, 3.4, 'wood_deck');
  add('bridge_s', 0, 3.35, 18.5, 28, 0.5, 3.4, 'wood_deck');
  // Solid wooden balustrades on the outer bridge edges (visual fence == collider)
  add('fence_n', 0, 4.05, -20.05, 27.2, 0.9, 0.18, 'fence');
  add('fence_s', 0, 4.05, 20.05, 27.2, 0.9, 0.18, 'fence');

  // Golden braziers in the 4 corners of the central plaza (visual bowl == collider)
  for (const [bx, bz] of [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]]) {
    add(`brazier_${bx}_${bz}`, bx, 2.4, bz, 0.7, 0.8, 0.7, 'brazier');
  }

  // Spawn Team Gates (West = Red Barn Pavilion, East = Blue Windmill Pavilion)
  add('gate_w_l', -21.5, 2.0, -4.5, 2.0, 4.0, 1.8, 'crimson_stone');
  add('gate_w_r', -21.5, 2.0, 4.5, 2.0, 4.0, 1.8, 'crimson_stone');
  add('gate_w_top', -21.5, 4.6, 0, 2.2, 1.2, 10.8, 'crimson_stone');

  add('gate_e_l', 21.5, 2.0, -4.5, 2.0, 4.0, 1.8, 'azure_stone');
  add('gate_e_r', 21.5, 2.0, 4.5, 2.0, 4.0, 1.8, 'azure_stone');
  add('gate_e_top', 21.5, 4.6, 0, 2.2, 1.2, 10.8, 'azure_stone');

  return boxes;
}

export const ARENA_BOXES = buildArenaBoxes();

/**
 * Arcane Jump Pads launching players onto the sky-bridges.
 * Pads sit beside (not under) the bridges; arcs verified to clear the bridge edge
 * with feet above the deck (apex ~4.7m vs deck top 3.6m) and land mid-bridge.
 */
export const JUMP_PADS = [
  { id: 'jp_nw', x: -10.5, y: 0.1, z: -14.2, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: -5.0 },
  { id: 'jp_ne', x: 10.5, y: 0.1, z: -14.2, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: -5.0 },
  { id: 'jp_sw', x: -10.5, y: 0.1, z: 14.2, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: 5.0 },
  { id: 'jp_se', x: 10.5, y: 0.1, z: 14.2, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: 5.0 },
  { id: 'jp_n', x: 0, y: 0.1, z: -12.6, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: -5.6 },
  { id: 'jp_s', x: 0, y: 0.1, z: 12.6, radius: 1.45, boostY: 15.0, boostX: 0, boostZ: 5.6 },
];

/**
 * Soul Essence Orb spawn nodes.
 */
export const ORB_SPAWNS = [
  { id: 'orb_altar_n', x: 0, y: 2.8, z: -3.2 },
  { id: 'orb_altar_s', x: 0, y: 2.8, z: 3.2 },
  { id: 'orb_bridge_n', x: 0, y: 4.4, z: -18.5 },
  { id: 'orb_bridge_s', x: 0, y: 4.4, z: 18.5 },
];

/**
 * Spawn points for FFA and TDM.
 */
export const SPAWN_POINTS = [
  { x: -20.5, y: 0.1, z: 0, yaw: -Math.PI / 2, team: TEAMS.CRIMSON },
  { x: -18.5, y: 0.1, z: -11, yaw: -Math.PI * 0.35, team: TEAMS.CRIMSON },
  { x: -18.5, y: 0.1, z: 11, yaw: -Math.PI * 0.65, team: TEAMS.CRIMSON },
  { x: -18.5, y: 3.8, z: -18.5, yaw: -Math.PI * 0.25, team: TEAMS.CRIMSON },
  { x: 20.5, y: 0.1, z: 0, yaw: Math.PI / 2, team: TEAMS.AZURE },
  { x: 18.5, y: 0.1, z: -11, yaw: Math.PI * 0.35, team: TEAMS.AZURE },
  { x: 18.5, y: 0.1, z: 11, yaw: Math.PI * 0.65, team: TEAMS.AZURE },
  { x: 18.5, y: 3.8, z: 18.5, yaw: Math.PI * 0.75, team: TEAMS.AZURE },
  { x: 0, y: 0.1, z: -20.5, yaw: Math.PI, team: TEAMS.NONE },
  { x: 0, y: 0.1, z: 20.5, yaw: 0, team: TEAMS.NONE },
  { x: -18.5, y: 3.8, z: 18.5, yaw: -Math.PI * 0.75, team: TEAMS.NONE },
  { x: 18.5, y: 3.8, z: -18.5, yaw: Math.PI * 0.25, team: TEAMS.NONE },
];

const PAN_WALKABLE_KINDS = new Set(['grass_floor', 'cobble', 'wood_deck']);
const PAN_FALLBACK_POINTS = [
  { x: 0, y: 2.0, z: 3.2 },
  { x: 0, y: 2.0, z: -3.2 },
  { x: -11.5, y: 0, z: 0 },
  { x: 11.5, y: 0, z: 0 },
  { x: 0, y: 3.6, z: -18.5 },
  { x: 0, y: 3.6, z: 18.5 },
];

function overlapsCircleXZ(px, pz, r, box) {
  const cx = Math.max(box.minX, Math.min(px, box.maxX));
  const cz = Math.max(box.minZ, Math.min(pz, box.maxZ));
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz < r * r;
}

/**
 * Picks a random walkable, unobstructed arena location for the Pan pickup.
 */
export function findRandomPanSpawn(
  boxes = ARENA_BOXES,
  jumpPads = JUMP_PADS,
  orbSpawns = ORB_SPAWNS,
  rng = Math.random
) {
  const maxCoord = ARENA_HALF_SIZE - 1.6;
  const edgeMargin = 0.68;
  const clearanceRadius = 0.95;

  for (let attempt = 0; attempt < 60; attempt++) {
    const x = (rng() * 2 - 1) * maxCoord;
    const z = (rng() * 2 - 1) * maxCoord;

    let surfaceY = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!PAN_WALKABLE_KINDS.has(b.kind)) continue;
      if (b.maxY < 0 || b.maxY > 3.7) continue;
      if (
        x >= b.minX + edgeMargin &&
        x <= b.maxX - edgeMargin &&
        z >= b.minZ + edgeMargin &&
        z <= b.maxZ - edgeMargin
      ) {
        if (surfaceY === null || b.maxY > surfaceY) {
          surfaceY = b.maxY;
        }
      }
    }
    if (surfaceY === null) continue;

    let blocked = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.minY >= surfaceY + 1.85 || b.maxY <= surfaceY + 0.05) continue;
      if (overlapsCircleXZ(x, z, clearanceRadius, b)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    for (let i = 0; i < jumpPads.length; i++) {
      const jp = jumpPads[i];
      if (Math.abs(surfaceY - jp.y) < 1.2 && Math.hypot(x - jp.x, z - jp.z) < jp.radius + 0.65) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    for (let i = 0; i < orbSpawns.length; i++) {
      const ob = orbSpawns[i];
      if (Math.abs(surfaceY - ob.y) < 1.6 && Math.hypot(x - ob.x, z - ob.z) < 1.45) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    return { x, y: surfaceY, z };
  }

  return { ...PAN_FALLBACK_POINTS[Math.floor(rng() * PAN_FALLBACK_POINTS.length)] };
}
