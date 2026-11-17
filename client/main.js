import {
  EMOTE_COOLDOWN,
  EMOTES,
  FIXED_DT,
  GAME_MODES,
  MAX_STAMINA_BASE,
  PLAYER_EYE_HEIGHT,
  POWERS,
  WEAPONS,
} from '../shared/constants.js';
import { ARENA_BOXES, JUMP_PADS } from '../shared/arena.js';
import { clamp, getAimDirection, raycastArena, stepPlayerPhysics } from '../shared/physics.js';
import { EVT, MSG, r3 } from '../shared/protocol.js';
import { NetClient } from './NetClient.js';
import { InputManager } from './InputManager.js';
import { evaluateMobileCombatAssist } from './mobileAssist.js';
import { Renderer } from './Renderer.js';
import { SoundEngine } from './SoundEngine.js';
import { HudUI } from './HudUI.js';

const canvas = document.getElementById('game-canvas');
const renderer = new Renderer(canvas);
const net = new NetClient();
const input = new InputManager(canvas);
const sfx = new SoundEngine();

let latestSnap = null;
let myServerState = null;
let lastHp = null;
let currentMode = GAME_MODES.FFA;

// Prediction & reconciliation state
let predState = {
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
  dashTimer: 0,
  dashCd: 0,
  jumpPadCd: 0,
  coyoteTimer: 0,
  slowTimer: 0,
  stamina: MAX_STAMINA_BASE,
  windRank: 0,
};
let visualOffset = { x: 0, y: 0, z: 0 };
let inputSeq = 0;
let pendingInputs = [];
let outboundTicks = [];
let localWeaponCd = 0;
let localPowerCds = {};
let lastEmoteAt = 0;
let joined = false;
let lastNonPanWeapon = 'staff';
let panShotPending = false;
let panShotAt = 0;
let wasRailScoped = false;
let autoFireLockTimer = 0;
let isTargetLocked = false;

const hud = new HudUI({
  onEnterGame(name, mode) {
    sfx.ensure();
    hud.showLobby(false);
    hud.setTouchMode(input.isTouch);
    input.bindTouchControls();
    if (input.isTouch && input.gyroEnabled) {
      input.enableGyroFromGesture(false);
    }
    input.requestPointerLock();
    if (!joined) {
      joined = true;
      net.connect(name, null, mode);
    }
  },
  onResumePointer() {
    hud.setShopOpen(false);
    hud.setEmoteTrayOpen(false);
    hud.setScoreboardOpen(false);
    hud.setPauseOverlay(false);
    input.setUiBlocked(false);
    input.requestPointerLock();
  },
  onOpenShop() {
    input.onToggleShop();
  },
  onToggleEmoteTray() {
    input.onToggleEmoteTray();
  },
  onTriggerEmote(emoteId) {
    triggerEmote(emoteId);
  },
  onTogglePerspective() {
    input.togglePerspective();
  },
  async onToggleGyro() {
    const st = await input.toggleGyro();
    hud.setGyroUi(st);
    hud.showEmoteToast(
      !st.supported
        ? 'GYRO UNSUPPORTED'
        : st.permission === 'denied'
          ? 'ALLOW MOTION ACCESS'
          : st.enabled
            ? 'GYRO AIM ON'
            : 'GYRO AIM OFF'
    );
  },
  onGyroSensChange(val) {
    input.setGyroSensitivity(val);
  },
  onTouchSensChange(val) {
    const mult = input.setTouchSensitivity(val);
    hud.setTouchSensitivityUi(mult);
  },
  onToggleAutoFire() {
    const enabled = input.toggleAutoFire();
    hud.setAutoFireUi(enabled);
    hud.showEmoteToast(enabled ? 'AUTO-FIRE ON' : 'AUTO-FIRE OFF');
  },
  onToggleAimAssist() {
    const enabled = input.toggleAimAssist();
    hud.setAimAssistUi(enabled);
    hud.showEmoteToast(enabled ? 'AIM ASSIST ON' : 'AIM ASSIST OFF');
  },
  onOpenTouchLayoutEditor() {
    input.setEditingLayout(true);
  },
  onCloseTouchLayoutEditor() {
    input.setEditingLayout(false);
    hud.setShopOpen(false);
    hud.setEmoteTrayOpen(false);
    hud.setScoreboardOpen(false);
    hud.setPauseOverlay(false);
    input.setUiBlocked(false);
    input.requestPointerLock();
    hud.showEmoteToast('TOUCH CONTROLS SAVED');
  },
  onOpenMenu() {
    if (!joined) return;
    hud.setShopOpen(false);
    hud.setEmoteTrayOpen(false);
    hud.setScoreboardOpen(false);
    hud.setPauseOverlay(true);
    input.setUiBlocked(true);
    input.exitPointerLock();
  },
  onToggleScoreboard() {
    const open = !hud.isScoreboardOpen();
    hud.setScoreboardOpen(open);
    input.setUiBlocked(open);
    if (open) input.exitPointerLock();
    else input.requestPointerLock();
  },
  onSelectWeapon(weaponId) {
    input.onWeaponKey(weaponId);
  },
  onCastPower(powerId) {
    input.onPowerKey(powerId);
  },
  onBuy(category, id) {
    net.send({ t: MSG.BUY, category, id });
  },
  onMatchCmd(cmd) {
    if (!net.canManageServer()) {
      hud.showEmoteToast('ONLY THE LOBBY HOST CAN MANAGE SERVER SETTINGS');
      return;
    }
    net.send({ t: MSG.MATCH_CMD, cmd });
  },
  onSetBotDifficulty(difficulty) {
    if (!net.canManageServer()) {
      hud.showEmoteToast('ONLY THE LOBBY HOST CAN MANAGE SERVER SETTINGS');
      return;
    }
    net.send({ t: MSG.MATCH_CMD, cmd: 'set_bot_difficulty', difficulty });
    hud.showEmoteToast(`BOT AI: ${String(difficulty || 'normal').toUpperCase()}`);
  },
  onToggleMode() {
    if (!net.canManageServer()) {
      hud.showEmoteToast('ONLY THE LOBBY HOST CAN MANAGE SERVER SETTINGS');
      return;
    }
    const next = currentMode === GAME_MODES.FFA ? GAME_MODES.TDM : GAME_MODES.FFA;
    net.send({ t: MSG.MATCH_CMD, cmd: 'set_mode', mode: next });
  },
});

hud.setTouchMode(input.isTouch);
renderer.setPerspective(input.perspectiveMode);
hud.setPerspective(input.perspectiveMode);
hud.setGyroUi(input.getGyroStatus());
hud.setTouchSensitivityUi(input.touchSensMultiplier);
hud.setAutoFireUi(input.autoFireEnabled);
hud.setAimAssistUi(input.aimAssistEnabled);

input.onPointerLockChange = (locked) => {
  if (joined && !input.isTouch) hud.setPauseOverlay(!locked);
};

input.onTogglePerspective = (mode) => {
  renderer.setPerspective(mode);
  hud.setPerspective(mode);
  hud.showEmoteToast(mode === 'tpp' ? '3RD PERSON (TPP)' : '1ST PERSON (FPP)');
};

input.onGyroStateChange = (st) => {
  hud.setGyroUi(st);
};

input.onScoreboard = (open) => {
  hud.setScoreboardOpen(open);
};

input.onToggleShop = () => {
  if (!joined) return;
  if (!hud.shopOpen) {
    hud.setShopOpen(true, myServerState);
    input.setUiBlocked(true);
    input.exitPointerLock();
  } else {
    hud.setShopOpen(false);
    input.setUiBlocked(false);
    input.requestPointerLock();
  }
};

input.onToggleEmoteTray = () => {
  if (!joined) return;
  if (!hud.emoteTrayOpen) {
    hud.setShopOpen(false);
    hud.setScoreboardOpen(false);
    hud.setEmoteTrayOpen(true);
    if (!input.isTouch) {
      input.setUiBlocked(true);
      input.exitPointerLock();
    }
  } else {
    hud.setEmoteTrayOpen(false);
    if (!input.isTouch) {
      input.setUiBlocked(false);
      input.requestPointerLock();
    }
  }
};

input.onEmoteKey = (emoteId) => {
  triggerEmote(emoteId);
};

function triggerEmote(emoteId) {
  if (!joined || !myServerState || !myServerState.al) return;
  const em = EMOTES[emoteId];
  if (!em) return;
  const nowPerf = performance.now();
  if (nowPerf - lastEmoteAt < EMOTE_COOLDOWN * 1000) return;
  lastEmoteAt = nowPerf;

  if (hud.emoteTrayOpen) {
    hud.setEmoteTrayOpen(false);
    if (!input.isTouch) {
      input.setUiBlocked(false);
      input.requestPointerLock();
    }
  }

  renderer.triggerLocalEmote(emoteId, input.yaw, predState);
  sfx.emote(emoteId, 1.0);
  hud.showEmoteToast(em.name);
  net.send({ t: MSG.EMOTE, id: emoteId });
}

input.onWeaponKey = (weaponId) => {
  if (!myServerState || !myServerState.uw.includes(weaponId)) return;
  if (myServerState.wp === 'pan') return;
  net.send({ t: MSG.EQUIP_WEAPON, id: weaponId });
  myServerState.wp = weaponId;
  lastNonPanWeapon = weaponId;
};

function flushPendingTicks() {
  if (outboundTicks.length === 0) return;
  net.send({ t: MSG.INPUT, ticks: outboundTicks });
  outboundTicks = [];
  netSendAccum = 0;
}

input.onPowerKey = (powerId) => {
  if (!myServerState || !myServerState.al || !myServerState.up.includes(powerId)) return;
  const pw = POWERS[powerId];
  if (!pw) return;
  if ((localPowerCds[powerId] || 0) > 0 || (myServerState.cds?.[powerId] || 0) > 0) return;
  if (myServerState.mn < pw.manaCost) return;

  flushPendingTicks();
  renderer.cancelLocalEmote();
  localPowerCds[powerId] = 0.3;
  if (powerId === 'blink') sfx.blink();
  else if (powerId === 'fireball' || powerId === 'frostlance') sfx.bolt();
  else sfx.unlock();

  net.send({
    t: MSG.ACTION,
    kind: 'power',
    id: powerId,
    yaw: input.yaw,
    pitch: input.pitch,
    sx: r3(predState.x),
    sy: r3(predState.y),
    sz: r3(predState.z),
    viewTime: net.getRenderTime(),
  });
};

net.onWelcome = (msg) => {
  currentMode = msg.mode;
};

net.onHostMigrate = (info) => {
  if (info.reason !== 'latency') {
    hud.showEmoteToast(
      info.isHost ? 'HOST MIGRATED — YOU ARE NOW HOST!' : `HOST MIGRATED TO ${info.hostName || info.hostId}`,
      'pan-toast'
    );
  }
};

net.onHitConfirm = (msg) => {
  sfx.hit(msg.hs);
  if (msg.kill) sfx.kill();
  hud.triggerHitmarker(msg.hs);
  renderer.addDamageNumber(msg.x, msg.y, msg.z, msg.dmg, msg.hs);
};

net.onBuyResult = (res) => {
  if (myServerState) {
    myServerState.es = res.essence;
    myServerState.wp = res.weapon;
    myServerState.uw = res.uw;
    myServerState.up = res.up;
    myServerState.rn = res.rn;
  }
  if (res.ok) {
    sfx.unlock();
    const verb = res.category === 'weapon' && res.uw.includes(res.id) ? 'Equipped / Unlocked' : 'Unlocked';
    hud.showShopFeedback(`✦ ${verb} ${res.label || res.id}!`, false);
  } else {
    sfx.hurt();
    hud.showShopFeedback('Not enough Soul Essence!', true);
  }
  if (hud.shopOpen && myServerState) hud.renderShop(myServerState);
};

net.onSnapshot = (snap) => {
  latestSnap = snap;
  currentMode = snap.md;

  // Dispatch server events
  if (Array.isArray(snap.ev)) {
    for (const ev of snap.ev) handleServerEvent(ev);
  }

  const me = snap.pl.find((p) => p.id === net.playerId);
  if (!me) return;

  if (lastHp !== null && me.hp < lastHp && me.al) {
    hud.flashDamage();
    sfx.hurt();
    renderer.screenShake = Math.max(renderer.screenShake, 0.05);
  }
  lastHp = me.hp;

  const wasDead = myServerState && !myServerState.al && me.al;
  if (!me.al) {
    panShotPending = false;
  }
  if (me.wp && me.wp !== 'pan') {
    lastNonPanWeapon = me.wp;
    panShotPending = false;
  } else if (me.wp === 'pan' && panShotPending) {
    if (performance.now() - panShotAt < 450) {
      me.wp = lastNonPanWeapon;
    } else {
      panShotPending = false;
    }
  }
  myServerState = me;
  if (hud.shopOpen) hud.renderShop(me);

  if (wasDead) {
    input.yaw = me.yw;
    input.pitch = me.pt;
    pendingInputs = [];
  }

  reconcileWithServer(me);
};

function reconcileWithServer(me) {
  const prevX = predState.x;
  const prevY = predState.y;
  const prevZ = predState.z;

  // Discard acknowledged ticks
  pendingInputs = pendingInputs.filter((inp) => inp.seq > me.ack);

  predState.x = me.x;
  predState.y = me.y;
  predState.z = me.z;
  predState.vx = me.vx;
  predState.vy = me.vy;
  predState.vz = me.vz;
  predState.grounded = Boolean(me.gr);
  predState.alive = Boolean(me.al);
  predState.dashTimer = me.dt || 0;
  predState.slowTimer = me.sl || 0;
  predState.stamina = me.st;
  predState.windRank = (me.rn && me.rn.windwalker) || 0;

  for (const inp of pendingInputs) {
    stepPlayerPhysics(predState, inp, FIXED_DT, ARENA_BOXES, JUMP_PADS);
  }

  const errDist = Math.hypot(predState.x - prevX, predState.y - prevY, predState.z - prevZ);
  if (errDist > 0.015 && errDist < 2.2) {
    visualOffset.x += prevX - predState.x;
    visualOffset.y += prevY - predState.y;
    visualOffset.z += prevZ - predState.z;
  } else if (errDist >= 2.2) {
    visualOffset.x = 0;
    visualOffset.y = 0;
    visualOffset.z = 0;
  }
}

function handleServerEvent(ev) {
  if (ev.kind === EVT.BEAM) {
    // Avoid duplicating our own optimistic beam
    if (ev.fromId !== net.playerId) {
      renderer.addBeam(ev.ax, ev.ay, ev.az, ev.bx, ev.by, ev.bz, ev.color, ev.weapon === 'rail' ? 0.08 : 0.04);
      renderer.triggerRemoteAttack(ev.fromId);
    }
  } else if (ev.kind === EVT.SLASH) {
    if (ev.fromId !== net.playerId) {
      renderer.addSlashArc(ev.x, ev.y, ev.z, ev.yaw, ev.pitch, ev.color);
      renderer.triggerRemoteAttack(ev.fromId);
    }
  } else if (ev.kind === EVT.EXPLOSION) {
    renderer.addExplosion(ev.x, ev.y, ev.z, ev.radius, ev.color);
    sfx.explosion();
    if (Math.hypot(ev.x - predState.x, ev.z - predState.z) < ev.radius * 2) {
      renderer.screenShake = Math.max(renderer.screenShake, 0.08);
    }
  } else if (ev.kind === EVT.BLINK) {
    renderer.addBeam(ev.ax, ev.ay, ev.az, ev.bx, ev.by, ev.bz, '#a855f7', 0.12);
  } else if (ev.kind === EVT.SIPHON) {
    renderer.addRing(ev.x, ev.y, ev.z, ev.radius, '#f43f5e', 0.45);
  } else if (ev.kind === EVT.METEOR_WARN) {
    renderer.addRing(ev.x, ev.y, ev.z, ev.radius, '#e879f9', 0.65);
  } else if (ev.kind === EVT.PARRY) {
    renderer.addRing(ev.x, ev.y, ev.z, 2.2, '#facc15', 0.35);
    sfx.parry();
  } else if (ev.kind === EVT.KILL) {
    hud.pushKillEvent(ev);
  } else if (ev.kind === EVT.EMOTE) {
    if (ev.fromId !== net.playerId) {
      renderer.triggerRemoteEmote(ev.fromId, ev.id);
      const dist = Math.hypot((ev.x || 0) - predState.x, (ev.z || 0) - predState.z);
      if (dist < 30) {
        sfx.emote(ev.id, Math.max(0.2, 1 - dist / 30));
      }
    }
  } else if (ev.kind === EVT.PAN_SPAWN) {
    sfx.panSpawn();
    renderer.addRing(ev.x, (ev.y || 0) + 0.1, ev.z, 2.2, '#facc15', 0.55);
    hud.showEmoteToast('GOLDEN PAN SPAWNED!', 'pan-toast');
  } else if (ev.kind === EVT.PAN_PICKUP) {
    renderer.addClangBurst(ev.x, (ev.y || 0) + 0.85, ev.z, false);
    if (ev.playerId === net.playerId) {
      panShotPending = false;
      if (myServerState) myServerState.wp = 'pan';
      sfx.panSpawn();
      hud.showEmoteToast('GOLDEN PAN! 1 SHOT • 1 KILL', 'pan-toast');
    } else {
      const dist = Math.hypot((ev.x || 0) - predState.x, (ev.z || 0) - predState.z);
      if (dist < 32) {
        sfx.panClang(false, Math.max(0.18, 1 - dist / 32) * 0.65);
      }
      hud.showEmoteToast(`${ev.playerName} GRABBED THE PAN!`, 'pan-toast');
    }
  } else if (ev.kind === EVT.PAN_SWING) {
    if (ev.fromId !== net.playerId) {
      renderer.addSlashArc(ev.x, ev.y, ev.z, ev.yaw, ev.pitch, WEAPONS.pan.color);
      renderer.triggerRemoteAttack(ev.fromId, true);
      const dist = Math.hypot((ev.x || 0) - predState.x, (ev.z || 0) - predState.z);
      if (dist < 28) {
        sfx.panSwing();
      }
    }
  } else if (ev.kind === EVT.PAN_CLANG) {
    const hitPlayer = Boolean(ev.hitPlayer);
    renderer.addClangBurst(ev.x, ev.y, ev.z, hitPlayer);
    const dist = Math.hypot((ev.x || 0) - predState.x, (ev.z || 0) - predState.z);
    if (dist < 48) {
      sfx.panClang(hitPlayer, Math.max(0.2, 1 - dist / 48));
    }
    if (hitPlayer && dist < 8) {
      renderer.screenShake = Math.max(renderer.screenShake, 0.11);
    }
  } else if (ev.kind === EVT.MATCH_END) {
    document.getElementById('match-end-winner').textContent = `${ev.winner} Wins!`;
  }
}

function tryPrimaryAttack() {
  if (!myServerState || !myServerState.al || !input.isControlling) return;
  if (localWeaponCd > 0) return;

  renderer.cancelLocalEmote();

  const wId = myServerState.wp || 'staff';
  const w = WEAPONS[wId] || WEAPONS.staff;
  const cdMult = Math.max(0.55, 1 - ((myServerState.rn && myServerState.rn.conduit) || 0) * 0.13);
  localWeaponCd = w.cooldown * cdMult;

  // Immediate optimistic client VFX & audio for zero-latency feel!
  renderer.triggerFireAnim(wId);
  const eye = { x: predState.x + visualOffset.x, y: predState.y + visualOffset.y + PLAYER_EYE_HEIGHT, z: predState.z + visualOffset.z };
  const dir = getAimDirection(input.yaw, input.pitch);

  if (w.type === 'hitscan') {
    if (wId === 'rail') sfx.rail();
    else sfx.bolt();

    const wall = raycastArena(eye, dir, w.range, ARENA_BOXES);
    const dist = wall ? wall.dist : w.range;
    renderer.addBeam(
      eye.x + dir.x * 0.55,
      eye.y - 0.12 + dir.y * 0.55,
      eye.z + dir.z * 0.55,
      eye.x + dir.x * dist,
      eye.y + dir.y * dist,
      eye.z + dir.z * dist,
      w.color,
      wId === 'rail' ? 0.08 : 0.04
    );
  } else if (w.type === 'pan') {
    sfx.panSwing();
    renderer.addSlashArc(eye.x + dir.x * 0.72, eye.y - 0.14 + dir.y * 0.72, eye.z + dir.z * 0.72, input.yaw, input.pitch, w.color);
    panShotPending = true;
    panShotAt = performance.now();
    myServerState.wp = lastNonPanWeapon;
  } else {
    sfx.slash();
    renderer.addSlashArc(eye.x + dir.x * 0.7, eye.y - 0.15 + dir.y * 0.7, eye.z + dir.z * 0.7, input.yaw, input.pitch, w.color);
  }

  flushPendingTicks();
  net.send({
    t: MSG.ACTION,
    kind: 'primary',
    yaw: input.yaw,
    pitch: input.pitch,
    sx: r3(predState.x),
    sy: r3(predState.y),
    sz: r3(predState.z),
    viewTime: net.getRenderTime(),
  });
}

// Main 60Hz/144Hz Game Loop
let lastFrame = performance.now();
let simAccum = 0;
let netSendAccum = 0;
let fpsSmoothed = 60;

function loop(now) {
  requestAnimationFrame(loop);

  const dt = Math.min(0.08, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) {
    fpsSmoothed = fpsSmoothed * 0.9 + (1 / dt) * 0.1;
    net.fps = fpsSmoothed;
  }

  localWeaponCd = Math.max(0, localWeaponCd - dt);
  for (const k of Object.keys(localPowerCds)) {
    localPowerCds[k] = Math.max(0, localPowerCds[k] - dt);
  }

  const renderTime = net.getRenderTime();
  const interp = net.sampleInterpolated(renderTime);

  const isRailEquipped = Boolean(joined && myServerState && myServerState.al && myServerState.wp === 'rail');
  const isRailScoped = Boolean(isRailEquipped && input.mouseDownRight && input.isControlling);
  input.setScoped(isRailScoped);

  // Mobile Aim Assist + Smart Auto-Fire (evaluated before fire trigger)
  let autoFireTrigger = false;
  if (input.isTouch && joined && myServerState && myServerState.al && input.isControlling) {
    const eye = {
      x: predState.x + visualOffset.x,
      y: predState.y + visualOffset.y + PLAYER_EYE_HEIGHT,
      z: predState.z + visualOffset.z,
    };
    const enemies = interp ? interp.players : latestSnap ? latestSnap.pl : [];
    const isActivelyAimingOrMoving = Boolean(
      input.lookTouchId !== null ||
        input.fireTouchId !== null ||
        input.blockTouchId !== null ||
        input.jumpTouchId !== null ||
        input.dashTouchId !== null ||
        input.gyroEnabled ||
        Math.hypot(input.joyX, input.joyZ) > 0.08
    );
    const assist = evaluateMobileCombatAssist({
      eye,
      yaw: input.yaw,
      pitch: input.pitch,
      weaponId: myServerState.wp || 'staff',
      scoped: isRailScoped,
      enemies,
      myId: net.playerId,
      myTeam: myServerState.tm,
      mode: currentMode,
      boxes: ARENA_BOXES,
      dt,
      isActivelyAimingOrMoving,
      aimAssistEnabled: input.aimAssistEnabled,
      autoFireEnabled: input.autoFireEnabled,
      lockTimer: autoFireLockTimer,
    });
    input.yaw += assist.dYaw;
    input.pitch = clamp(input.pitch + assist.dPitch, -Math.PI * 0.47, Math.PI * 0.47);
    input.setAimAssistSlowdown(assist.slowdown);
    isTargetLocked = assist.targetLocked;
    autoFireLockTimer = assist.lockTimer;
    autoFireTrigger = assist.shouldAutoFire;
  } else {
    input.setAimAssistSlowdown(1.0);
    isTargetLocked = false;
    autoFireLockTimer = 0;
  }

  // Primary fire (hold, tap, or smart auto-fire)
  if (input.mouseDownLeft || autoFireTrigger) {
    tryPrimaryAttack();
  }

  if (isRailScoped !== wasRailScoped) {
    const justClosedScope = wasRailScoped && !isRailScoped;
    wasRailScoped = isRailScoped;
    if (joined && myServerState && myServerState.al) {
      if (justClosedScope && isRailEquipped && input.isControlling) {
        tryPrimaryAttack();
      }
      sfx.scope(isRailScoped);
    }
  }

  // Fixed 60Hz client prediction steps
  simAccum += dt;
  while (simAccum >= FIXED_DT) {
    simAccum -= FIXED_DT;

    if (joined && myServerState) {
      const tickInput = input.sampleMovementTick();
      if (myServerState.wp === 'rail') tickInput.block = false;
      tickInput.seq = ++inputSeq;

      if (predState.alive) {
        stepPlayerPhysics(predState, tickInput, FIXED_DT, ARENA_BOXES, JUMP_PADS);
        if (predState.justDashed) sfx.dash();
        if (predState.justJumpPadded) sfx.jumpPad();
      }

      pendingInputs.push(tickInput);
      if (pendingInputs.length > 90) pendingInputs.shift();

      outboundTicks.push({
        seq: tickInput.seq,
        mx: tickInput.moveX,
        mz: tickInput.moveZ,
        j: tickInput.jump ? 1 : 0,
        d: tickInput.dash ? 1 : 0,
        b: tickInput.block ? 1 : 0,
        y: Math.round(tickInput.yaw * 1000) / 1000,
        p: Math.round(tickInput.pitch * 1000) / 1000,
      });
    }
  }

  // Flush inputs at 60Hz for minimal movement/fire latency
  netSendAccum += dt;
  if (netSendAccum >= 1 / 60 && outboundTicks.length > 0) {
    flushPendingTicks();
  }

  // Smooth visual reconciliation decay
  visualOffset.x *= 0.72;
  visualOffset.y *= 0.72;
  visualOffset.z *= 0.72;

  const renderLocal = joined && myServerState
    ? {
        ...predState,
        x: predState.x + visualOffset.x,
        y: predState.y + visualOffset.y,
        z: predState.z + visualOffset.z,
        yaw: input.yaw,
        pitch: input.pitch,
      }
    : null;

  const localMeta = myServerState
    ? {
        id: net.playerId,
        team: myServerState.tm,
        weapon: myServerState.wp,
        blocking: input.mouseDownRight && myServerState.wp !== 'rail' && predState.stamina > 2,
        scoped: isRailScoped,
        spawnShield: myServerState.sp || 0,
      }
    : null;

  renderer.render(
    dt,
    now / 1000,
    renderLocal,
    localMeta,
    interp ? interp.players : [],
    interp ? interp.projectiles : [],
    latestSnap ? latestSnap.ob : null,
    currentMode,
    latestSnap ? latestSnap.pn : null
  );

  hud.update(dt, latestSnap, myServerState, predState, {
    rtt: net.rtt,
    interp: net.getInterpDelayMs(),
    fps: fpsSmoothed,
    transport: net.transportMode,
    hostId: net.hostId,
    managerId: net.managerId,
    canManageServer: net.canManageServer(),
    scoped: isRailScoped,
    targetLocked: isTargetLocked,
  });
}

requestAnimationFrame(loop);

// PWA Service Worker & Install Prompt setup
function setupPwa() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const registerSw = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    if (document.readyState === 'complete') registerSw();
    else window.addEventListener('load', registerSw);
  }

  const installBtn = document.getElementById('install-app-btn');
  const iosTip = document.getElementById('ios-install-tip');
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isIos && !isStandalone) {
    iosTip?.classList.remove('hidden');
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone) {
      installBtn?.classList.remove('hidden');
      iosTip?.classList.add('hidden');
    }
  });

  installBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice?.outcome === 'accepted') {
      installBtn.classList.add('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn?.classList.add('hidden');
    iosTip?.classList.add('hidden');
  });
}

setupPwa();
