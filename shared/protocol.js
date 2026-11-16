export const MSG = {
  JOIN: 'join',
  WELCOME: 'welcome',
  PING: 'p',
  PONG: 'q',
  INPUT: 'in',
  ACTION: 'act',
  BUY: 'buy',
  EQUIP_WEAPON: 'wpn',
  MATCH_CMD: 'mcmd',
  SNAPSHOT: 'snap',
  EVENT: 'evt',
  HIT_CONFIRM: 'hit',
  CHAT: 'chat',
  EMOTE: 'emo',
  P2P_JOIN: 'p2p_join',
  P2P_ROLE: 'p2p_role',
  P2P_PEER_JOINED: 'p2p_pjoin',
  P2P_PEER_LEFT: 'p2p_pleft',
  P2P_SIGNAL: 'p2p_sig',
  P2P_RELAY: 'p2p_relay',
  P2P_CHECKPOINT: 'p2p_cp',
  P2P_HOST_MIGRATE: 'p2p_mig',
  P2P_LATENCY: 'p2p_lat',
  P2P_PREP_MIGRATE: 'p2p_prep',
};

export const EVT = {
  BEAM: 'beam',
  SLASH: 'slash',
  EXPLOSION: 'boom',
  BLINK: 'blink',
  SIPHON: 'siphon',
  METEOR_WARN: 'mwarn',
  PARRY: 'parry',
  KILL: 'kill',
  MATCH_END: 'mend',
  MATCH_START: 'mstart',
  ORB_PICKUP: 'orb',
  EMOTE: 'emo',
  PAN_SPAWN: 'pspawn',
  PAN_PICKUP: 'ppick',
  PAN_SWING: 'pswing',
  PAN_CLANG: 'pclang',
};

export function r2(n) {
  return Math.round(n * 100) / 100;
}

export function r3(n) {
  return Math.round(n * 1000) / 1000;
}
