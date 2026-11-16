export const SIM_HZ = 60;
export const FIXED_DT = 1 / SIM_HZ;
export const SNAPSHOT_HZ = 30;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
export const HISTORY_DURATION_MS = 1000;
export const MAX_REWIND_MS = 400;
export const HOST_EVAL_INTERVAL_MS = 5000;
export const LAG_COMP_HITBOX_PAD = 0.08;

export const PLAYER_RADIUS = 0.44;
export const PLAYER_HEIGHT = 1.82;
export const PLAYER_EYE_HEIGHT = 1.62;
export const HEAD_RADIUS = 0.25;
export const HEAD_CENTER_OFFSET = 1.56;

export const GRAVITY = 24.0;
export const JUMP_SPEED = 9.4;
export const BASE_MOVE_SPEED = 7.6;
export const GROUND_ACCEL = 58.0;
export const AIR_ACCEL = 18.0;
export const GROUND_FRICTION = 10.5;
export const STEP_HEIGHT = 0.65;

export const MAX_HP_BASE = 120;
export const MAX_MANA_BASE = 100;
export const MAX_STAMINA_BASE = 100;
export const MANA_REGEN_BASE = 12.0;
export const STAMINA_REGEN_BASE = 24.0;

export const DASH_COST = 34;
export const DASH_DURATION = 0.22;
export const DASH_SPEED = 18.5;
export const DASH_COOLDOWN = 0.85;

export const PARRY_WINDOW = 0.26;
export const BLOCK_STAMINA_DRAIN = 14.0;

export const RESPAWN_TIME = 3.0;
export const MATCH_DURATION_SEC = 300;
export const MAX_LOBBY_PLAYERS = 8;
export const FFA_KILL_LIMIT = 25;
export const TDM_KILL_LIMIT = 40;

export const PAN_INITIAL_SPAWN_MIN = 4;
export const PAN_INITIAL_SPAWN_MAX = 7;
export const PAN_RESPAWN_MIN = 10;
export const PAN_RESPAWN_MAX = 15;
export const PAN_PICKUP_RADIUS = 1.45;
export const PAN_THROW_INITIAL_SCALE = 1.0;
export const PAN_THROW_MAX_SCALE = 4.6;
export const PAN_THROW_GROWTH_PER_METER = 0.14;
export const PAN_THROW_GROWTH_START_DIST = 1.5;
export const PAN_THROW_BASE_HIT_RADIUS = 0.18;

export function getThrownPanScale(distanceTraveled = 0) {
  const effectiveDist = Math.max(0, (Number(distanceTraveled) || 0) - PAN_THROW_GROWTH_START_DIST);
  return Math.min(PAN_THROW_MAX_SCALE, PAN_THROW_INITIAL_SCALE + effectiveDist * PAN_THROW_GROWTH_PER_METER);
}

export function getThrownPanHitRadius(
  panScale = PAN_THROW_INITIAL_SCALE,
  baseExtraRadius = PAN_THROW_BASE_HIT_RADIUS
) {
  return baseExtraRadius + Math.max(0, panScale - PAN_THROW_INITIAL_SCALE) * 0.42;
}

export const GAME_MODES = {
  FFA: 'ffa',
  TDM: 'tdm',
};

export const TEAMS = {
  NONE: 0,
  CRIMSON: 1,
  AZURE: 2,
};

export const WEAPONS = {
  staff: {
    id: 'staff',
    name: 'Arcane Bolt',
    slot: 1,
    cost: 0,
    cooldown: 0.22,
    damage: 22,
    headshotMult: 1.85,
    range: 75,
    spreadMove: 0.012,
    spreadAir: 0.025,
    type: 'hitscan',
    color: '#38bdf8',
    desc: 'Rapid precision soul bolts. Crisp headshot multiplier.',
  },
  runeblade: {
    id: 'runeblade',
    name: 'Runeblade',
    slot: 2,
    cost: 200,
    cooldown: 0.42,
    damage: 48,
    waveDamage: 32,
    headshotMult: 1.5,
    meleeRange: 3.7,
    waveSpeed: 34,
    waveRange: 20,
    type: 'melee_wave',
    color: '#fbbf24',
    desc: 'Heavy melee cleave + Crescent Soul Wave. Stronger Parry.',
  },
  rail: {
    id: 'rail',
    name: 'Astral Rail',
    slot: 3,
    cost: 350,
    cooldown: 1.15,
    damage: 68,
    headshotMult: 1.9,
    range: 95,
    spreadMove: 0.018,
    spreadAir: 0.045,
    type: 'hitscan',
    color: '#c084fc',
    desc: 'High-impact void beam with 2.8x Astral Scope (RMB). One-tap headshots.',
  },
  pan: {
    id: 'pan',
    name: 'Golden Pan',
    slot: '★',
    cost: 0,
    cooldown: 0.4,
    damage: 500,
    headshotMult: 1.0,
    meleeRange: 4.1,
    throwSpeed: 38,
    throwRange: 55,
    type: 'pan',
    pickupOnly: true,
    color: '#f59e0b',
    desc: 'One-shot, one-kill cast-iron battle pan. Expands as it flies to crush distant foes!',
  },
};

export const POWERS = {
  blink: {
    id: 'blink',
    key: 'Q',
    name: 'Shadow Blink',
    cost: 150,
    cooldown: 5.0,
    manaCost: 22,
    distance: 9.5,
    color: '#a855f7',
    desc: 'Teleport-dash in aim/move direction with brief evasion.',
  },
  fireball: {
    id: 'fireball',
    key: 'E',
    name: 'Pyre Fireball',
    cost: 200,
    cooldown: 6.0,
    manaCost: 30,
    speed: 31,
    radius: 4.3,
    damage: 56,
    color: '#f97316',
    desc: 'Explosive fireball dealing splash damage & knockback.',
  },
  frostlance: {
    id: 'frostlance',
    key: 'R',
    name: 'Glacial Lance',
    cost: 225,
    cooldown: 7.5,
    manaCost: 32,
    speed: 44,
    radius: 2.8,
    damage: 46,
    slowDuration: 2.6,
    color: '#67e8f9',
    desc: 'Piercing ice spear that chills & slows enemies by 40%.',
  },
  souldrain: {
    id: 'souldrain',
    key: 'F',
    name: 'Soul Siphon',
    cost: 250,
    cooldown: 9.5,
    manaCost: 36,
    radius: 6.2,
    damage: 40,
    healRatio: 0.9,
    color: '#f43f5e',
    desc: 'Crimson nova draining nearby foes and healing you.',
  },
  meteor: {
    id: 'meteor',
    key: 'G',
    name: 'Void Meteor',
    cost: 425,
    cooldown: 15.0,
    manaCost: 55,
    range: 34,
    delay: 0.65,
    radius: 5.6,
    damage: 88,
    color: '#e879f9',
    desc: 'Calls a devastating meteor strike at target ground.',
  },
};

export const RUNES = {
  vitality: {
    id: 'vitality',
    name: 'Vitality Rune',
    maxRank: 3,
    costs: [125, 225, 350],
    desc: '+25 Max HP & +2.5 HP/s regen per rank.',
  },
  windwalker: {
    id: 'windwalker',
    name: 'Windwalker Rune',
    maxRank: 3,
    costs: [125, 225, 350],
    desc: '+9% Move Speed & +15% Stamina regen per rank.',
  },
  conduit: {
    id: 'conduit',
    name: 'Arcane Conduit',
    maxRank: 3,
    costs: [150, 250, 375],
    desc: '-13% Cooldowns & +22% Mana regen per rank.',
  },
  executioner: {
    id: 'executioner',
    name: 'Executioner Sigil',
    maxRank: 3,
    costs: [175, 300, 450],
    desc: '+10% Damage & +15% Headshot multiplier per rank.',
  },
};

export const ESSENCE_REWARDS = {
  STARTING: 175,
  KILL: 150,
  HEADSHOT_BONUS: 50,
  ASSIST: 65,
  ORB_PICKUP: 85,
  PASSIVE_AMOUNT: 10,
  PASSIVE_INTERVAL: 3.0,
};

export const EMOTE_COOLDOWN = 1.2;

export const EMOTES = {
  wave: { id: 'wave', key: '4', name: 'Wave', color: '#f59e0b', duration: 2.0 },
  dance: { id: 'dance', key: '5', name: 'Dance', color: '#a855f7', duration: 2.8 },
  twerk: { id: 'twerk', key: '6', name: 'Twerk', color: '#f43f5e', duration: 2.4 },
  cheer: { id: 'cheer', key: '7', name: 'Cheer', color: '#22c55e', duration: 2.2 },
  spin: { id: 'spin', key: '8', name: 'Spin', color: '#0ea5e9', duration: 1.8 },
  bow: { id: 'bow', key: '9', name: 'Salute', color: '#ec4899', duration: 1.9 },
};
