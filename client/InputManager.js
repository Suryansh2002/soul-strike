import { clamp } from '../shared/physics.js';
import { computeGyroDelta, deviceOrientationToQuat } from './gyroMath.js';
import { computeTouchLookDelta } from './mobileAssist.js';

function readStorage(key, fallback) {
  try {
    const val = window.localStorage?.getItem(key);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {}
}

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.baseTouchSensitivity = 0.0054;
    this.scoped = false;
    this.scopeSensMultiplier = 0.42;

    this.isTouch =
      'ontouchstart' in window ||
      (navigator.maxTouchPoints || 0) > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches;

    this.touchSensMultiplier = clamp(Number(readStorage('soulstrike_touch_sens', '1')) || 1, 0.4, 2.5);
    this.autoFireEnabled = this.isTouch ? readStorage('soulstrike_autofire', 'true') !== 'false' : false;
    this.aimAssistEnabled = this.isTouch ? readStorage('soulstrike_aim_assist', 'true') !== 'false' : false;
    this.aimAssistSlowdown = 1.0;
    this.perspectiveMode = readStorage('soulstrike_perspective', 'fpp') === 'tpp' ? 'tpp' : 'fpp';

    this.gyroSupported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
    this.gyroSensitivity = clamp(Number(readStorage('soulstrike_gyro_sens', '1.8')) || 1.8, 0.4, 3.0);
    const savedGyro = readStorage('soulstrike_gyro', null);
    this.gyroEnabled = this.isTouch && this.gyroSupported ? savedGyro !== 'false' : false;
    this.gyroPermission =
      this.gyroSupported && typeof DeviceOrientationEvent?.requestPermission === 'function' ? 'prompt' : 'granted';
    this.gyroHasData = false;
    this.prevGyroQuat = null;
    this.lastScreenOrient = null;
    this.gyroBound = false;

    this.pointerLocked = false;
    this.activePlay = false;
    this.uiBlocked = false;
    this.editingLayout = false;
    this.touchBound = false;

    this.mouseDownLeft = false;
    this.mouseDownRight = false;
    this.dashBuffered = false;
    this.jumpBuffered = false;

    // Touch state
    this.joyX = 0;
    this.joyZ = 0;
    this.touchJumpHeld = false;
    this.moveTouchId = null;
    this.moveOrigin = { x: 0, y: 0 };
    this.moveMaxRadius = 44;
    this.lookTouchId = null;
    this.lookLast = { x: 0, y: 0 };
    this.fireTouchId = null;
    this.fireLast = { x: 0, y: 0 };
    this.jumpTouchId = null;
    this.jumpLast = { x: 0, y: 0 };
    this.dashTouchId = null;
    this.dashLast = { x: 0, y: 0 };
    this.blockTouchId = null;
    this.blockLast = { x: 0, y: 0 };

    this.onPowerKey = null;
    this.onWeaponKey = null;
    this.onEmoteKey = null;
    this.onToggleEmoteTray = null;
    this.onToggleShop = null;
    this.onScoreboard = null;
    this.onPointerLockChange = null;
    this.onTogglePerspective = null;
    this.onGyroStateChange = null;

    this.bindEvents();
  }

  get touchSensitivity() {
    return this.baseTouchSensitivity * this.touchSensMultiplier;
  }

  get isControlling() {
    if (this.uiBlocked) return false;
    return this.isTouch ? this.activePlay : this.pointerLocked;
  }

  setUiBlocked(blocked) {
    this.uiBlocked = blocked;
    if (blocked) {
      this.keys.clear();
      this.mouseDownLeft = false;
      this.mouseDownRight = false;
      this.touchJumpHeld = false;
      this.lookTouchId = null;
      this.fireTouchId = null;
      this.jumpTouchId = null;
      this.dashTouchId = null;
      this.blockTouchId = null;
      this.resetJoystickVisuals();
    } else {
      this.prevGyroQuat = null;
    }
  }

  setPerspective(mode) {
    this.perspectiveMode = mode === 'tpp' ? 'tpp' : 'fpp';
    writeStorage('soulstrike_perspective', this.perspectiveMode);
    this.onTogglePerspective?.(this.perspectiveMode);
    return this.perspectiveMode;
  }

  togglePerspective() {
    return this.setPerspective(this.perspectiveMode === 'fpp' ? 'tpp' : 'fpp');
  }

  getGyroStatus() {
    return {
      enabled: this.gyroEnabled,
      supported: this.gyroSupported,
      permission: this.gyroPermission,
      hasData: this.gyroHasData,
      sensitivity: this.gyroSensitivity,
    };
  }

  setGyroSensitivity(val) {
    this.gyroSensitivity = clamp(Number(val) || 1.8, 0.4, 3.0);
    writeStorage('soulstrike_gyro_sens', this.gyroSensitivity.toFixed(2));
    this.onGyroStateChange?.(this.getGyroStatus());
    return this.gyroSensitivity;
  }

  setTouchSensitivity(val) {
    this.touchSensMultiplier = clamp(Number(val) || 1.0, 0.4, 2.5);
    writeStorage('soulstrike_touch_sens', this.touchSensMultiplier.toFixed(2));
    return this.touchSensMultiplier;
  }

  setAutoFire(enabled) {
    this.autoFireEnabled = Boolean(enabled);
    writeStorage('soulstrike_autofire', this.autoFireEnabled ? 'true' : 'false');
    return this.autoFireEnabled;
  }

  toggleAutoFire() {
    return this.setAutoFire(!this.autoFireEnabled);
  }

  setAimAssist(enabled) {
    this.aimAssistEnabled = Boolean(enabled);
    writeStorage('soulstrike_aim_assist', this.aimAssistEnabled ? 'true' : 'false');
    if (!this.aimAssistEnabled) this.aimAssistSlowdown = 1.0;
    return this.aimAssistEnabled;
  }

  toggleAimAssist() {
    return this.setAimAssist(!this.aimAssistEnabled);
  }

  setAimAssistSlowdown(val) {
    this.aimAssistSlowdown = clamp(Number(val) || 1, 0.35, 1.0);
  }

  applyTouchLookDelta(dx, dy, buttonScale = 1.0) {
    const { dYaw, dPitch } = computeTouchLookDelta(
      dx,
      dy,
      this.touchSensitivity * buttonScale,
      this.activeZoomSensScale,
      this.aimAssistSlowdown
    );
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -Math.PI * 0.47, Math.PI * 0.47);
  }

  resetJoystickVisuals() {
    this.moveTouchId = null;
    this.joyX = 0;
    this.joyZ = 0;
    if (typeof document === 'undefined') return;
    const knob = document.getElementById('touch-joy-knob');
    const joyBase = document.getElementById('touch-joy-base');
    if (knob) knob.style.transform = 'translate(-50%, -50%)';
    if (joyBase) {
      joyBase.classList.remove('active');
      joyBase.style.left = joyBase.dataset.customLeft || '';
      joyBase.style.top = joyBase.dataset.customTop || '';
      joyBase.style.bottom = joyBase.dataset.customTop ? 'auto' : '';
    }
    document.querySelectorAll?.('#touch-controls .touch-btn.active').forEach((b) => b.classList.remove('active'));
  }

  setEditingLayout(editing) {
    this.editingLayout = Boolean(editing);
    if (this.editingLayout) {
      this.setUiBlocked(true);
    }
  }

  setScoped(scoped) {
    this.scoped = Boolean(scoped);
  }

  get activeZoomSensScale() {
    return this.scoped ? this.scopeSensMultiplier : 1.0;
  }

  bindGyroListener() {
    if (this.gyroBound || !this.gyroSupported) return;
    this.gyroBound = true;
    window.addEventListener('deviceorientation', (e) => this.handleDeviceOrientation(e));
    window.addEventListener('orientationchange', () => {
      this.prevGyroQuat = null;
      this.lastScreenOrient = null;
    });
  }

  async enableGyroFromGesture(forceEnable = false) {
    if (!this.gyroSupported) {
      this.gyroEnabled = false;
      this.gyroPermission = 'unsupported';
      this.onGyroStateChange?.(this.getGyroStatus());
      return this.getGyroStatus();
    }

    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        this.gyroPermission = res === 'granted' ? 'granted' : 'denied';
      } catch {
        this.gyroPermission = 'denied';
      }
      if (this.gyroPermission !== 'granted') {
        this.gyroEnabled = false;
        writeStorage('soulstrike_gyro', 'false');
        this.onGyroStateChange?.(this.getGyroStatus());
        return this.getGyroStatus();
      }
    } else {
      this.gyroPermission = 'granted';
    }

    this.bindGyroListener();
    this.prevGyroQuat = null;
    if (forceEnable) {
      this.gyroEnabled = true;
      writeStorage('soulstrike_gyro', 'true');
    }
    this.onGyroStateChange?.(this.getGyroStatus());
    return this.getGyroStatus();
  }

  async toggleGyro() {
    if (!this.gyroEnabled) {
      return this.enableGyroFromGesture(true);
    }
    this.gyroEnabled = false;
    this.prevGyroQuat = null;
    writeStorage('soulstrike_gyro', 'false');
    const st = this.getGyroStatus();
    this.onGyroStateChange?.(st);
    return st;
  }

  handleDeviceOrientation(e) {
    if (!this.gyroEnabled) return;
    if (e.alpha == null || e.beta == null || e.gamma == null) return;

    this.gyroHasData = true;
    const orient = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    const currQuat = deviceOrientationToQuat(e.alpha, e.beta, e.gamma, orient);

    if (!this.prevGyroQuat || this.lastScreenOrient !== orient || !this.isControlling) {
      this.prevGyroQuat = currQuat;
      this.lastScreenOrient = orient;
      return;
    }

    const { dYaw, dPitch } = computeGyroDelta(this.prevGyroQuat, currQuat);
    this.prevGyroQuat = currQuat;

    // Ignore sub-milliradian MEMS sensor jitter and anomalous orientation-change spikes
    const noiseFloor = 0.00028;
    const maxStep = 0.35;
    if (Math.abs(dYaw) > maxStep || Math.abs(dPitch) > maxStep) return;

    const zoomScale = this.activeZoomSensScale;
    if (Math.abs(dYaw) > noiseFloor) {
      this.yaw += dYaw * this.gyroSensitivity * zoomScale;
    }
    if (Math.abs(dPitch) > noiseFloor) {
      this.pitch = clamp(this.pitch + dPitch * this.gyroSensitivity * 0.85 * zoomScale, -Math.PI * 0.47, Math.PI * 0.47);
    }
  }

  requestPointerLock() {
    this.uiBlocked = false;
    if (this.isTouch) {
      this.activePlay = true;
      this.onPointerLockChange?.(true);
      return;
    }
    if (document.pointerLockElement !== this.canvas) {
      try {
        this.canvas.requestPointerLock?.();
      } catch {}
    }
  }

  exitPointerLock() {
    if (this.isTouch) {
      this.activePlay = false;
      this.mouseDownLeft = false;
      this.mouseDownRight = false;
      this.touchJumpHeld = false;
      this.lookTouchId = null;
      this.fireTouchId = null;
      this.jumpTouchId = null;
      this.dashTouchId = null;
      this.blockTouchId = null;
      this.resetJoystickVisuals();
      return;
    }
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
  }

  bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      if (this.isTouch) return;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        this.keys.clear();
        this.mouseDownLeft = false;
        this.mouseDownRight = false;
      }
      this.onPointerLockChange?.(this.pointerLocked);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isTouch || !this.pointerLocked) return;
      const sens = this.sensitivity * this.activeZoomSensScale;
      this.yaw -= e.movementX * sens;
      this.pitch = clamp(this.pitch - e.movementY * sens, -Math.PI * 0.47, Math.PI * 0.47);
    });

    window.addEventListener('mousedown', (e) => {
      if (this.isTouch || !this.pointerLocked) return;
      if (e.button === 0) this.mouseDownLeft = true;
      if (e.button === 2) this.mouseDownRight = true;
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isTouch) return;
      if (e.button === 0) this.mouseDownLeft = false;
      if (e.button === 2) this.mouseDownRight = false;
    });

    window.addEventListener('contextmenu', (e) => {
      if (this.pointerLocked || this.isTouch) e.preventDefault();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

      const code = e.code;
      if (code === 'Tab') {
        e.preventDefault();
        this.onScoreboard?.(true);
        return;
      }

      if (code === 'KeyB' && !e.repeat) {
        this.onToggleShop?.();
        return;
      }

      if (code === 'KeyT' && !e.repeat) {
        this.onToggleEmoteTray?.();
        return;
      }

      if (code === 'KeyV' && !e.repeat) {
        this.togglePerspective();
        return;
      }

      if (!e.repeat) {
        const emoteMap = {
          Digit4: 'wave',
          Digit5: 'dance',
          Digit6: 'twerk',
          Digit7: 'cheer',
          Digit8: 'spin',
          Digit9: 'bow',
        };
        if (emoteMap[code] && (this.isControlling || document.getElementById('emote-tray')?.classList.contains('hidden') === false)) {
          this.onEmoteKey?.(emoteMap[code]);
          return;
        }
      }

      if (!this.isControlling) return;

      this.keys.add(code);
      if (code === 'Space' && !e.repeat) this.jumpBuffered = true;
      if ((code === 'ShiftLeft' || code === 'ShiftRight') && !e.repeat) this.dashBuffered = true;

      if (!e.repeat) {
        if (code === 'Digit1') this.onWeaponKey?.('staff');
        if (code === 'Digit2') this.onWeaponKey?.('runeblade');
        if (code === 'Digit3') this.onWeaponKey?.('rail');

        if (code === 'KeyQ') this.onPowerKey?.('blink');
        if (code === 'KeyE') this.onPowerKey?.('fireball');
        if (code === 'KeyR') this.onPowerKey?.('frostlance');
        if (code === 'KeyF') this.onPowerKey?.('souldrain');
        if (code === 'KeyG') this.onPowerKey?.('meteor');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        this.onScoreboard?.(false);
      }
      this.keys.delete(e.code);
    });
  }

  bindTouchControls() {
    if (this.touchBound) return;
    const moveZone = document.getElementById('touch-move-zone');
    const joyBase = document.getElementById('touch-joy-base');
    const knob = document.getElementById('touch-joy-knob');
    const lookZone = document.getElementById('touch-look-zone');
    const fireBtn = document.getElementById('touch-fire-btn');
    const jumpBtn = document.getElementById('touch-jump-btn');
    const dashBtn = document.getElementById('touch-dash-btn');
    const blockBtn = document.getElementById('touch-block-btn');
    if (!moveZone || !lookZone) return;
    this.touchBound = true;

    const startMoveTouch = (t, keepFixedCenter = false) => {
      if (this.moveTouchId !== null) return;
      this.moveTouchId = t.identifier;
      const baseHalf = joyBase ? joyBase.offsetWidth / 2 || 58 : 58;
      this.moveMaxRadius = clamp(baseHalf * 0.78, 28, 96);
      if (keepFixedCenter && joyBase) {
        const jRect = joyBase.getBoundingClientRect();
        this.moveOrigin = {
          x: jRect.left + jRect.width / 2,
          y: jRect.top + jRect.height / 2,
        };
        joyBase.classList.add('active');
        this.updateJoystick(t, knob, this.moveMaxRadius);
        return;
      }
      const rect = moveZone.getBoundingClientRect();
      const pad = this.moveMaxRadius + 10;
      const minX = rect.left + pad;
      const maxX = Math.max(minX, rect.right - pad);
      const minY = rect.top + pad;
      const maxY = Math.max(minY, rect.bottom - pad);
      const originX = clamp(t.clientX, minX, maxX);
      const originY = clamp(t.clientY, minY, maxY);
      this.moveOrigin = { x: originX, y: originY };
      if (joyBase) {
        const isFixed = Boolean(joyBase.dataset.customLeft);
        joyBase.style.left = `${originX - (isFixed ? 0 : rect.left) - baseHalf}px`;
        joyBase.style.top = `${originY - (isFixed ? 0 : rect.top) - baseHalf}px`;
        joyBase.style.bottom = 'auto';
        joyBase.classList.add('active');
      }
      this.updateJoystick(t, knob, this.moveMaxRadius);
    };

    moveZone.addEventListener(
      'touchstart',
      (e) => {
        if (this.editingLayout) return;
        e.preventDefault();
        startMoveTouch(e.changedTouches[0], false);
      },
      { passive: false }
    );

    moveZone.addEventListener(
      'touchmove',
      (e) => {
        if (this.editingLayout) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier === this.moveTouchId) {
            this.updateJoystick(t, knob, this.moveMaxRadius);
          }
        }
      },
      { passive: false }
    );

    const endMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.moveTouchId) {
          this.resetJoystickVisuals();
        }
      }
    };
    moveZone.addEventListener('touchend', endMove, { passive: false });
    moveZone.addEventListener('touchcancel', endMove, { passive: false });

    if (joyBase) {
      joyBase.addEventListener(
        'touchstart',
        (e) => {
          if (this.editingLayout || !joyBase.dataset.customLeft) return;
          e.preventDefault();
          e.stopPropagation();
          startMoveTouch(e.changedTouches[0], true);
        },
        { passive: false }
      );
      joyBase.addEventListener(
        'touchmove',
        (e) => {
          if (this.editingLayout || !joyBase.dataset.customLeft) return;
          e.preventDefault();
          e.stopPropagation();
          for (const t of e.changedTouches) {
            if (t.identifier === this.moveTouchId) {
              this.updateJoystick(t, knob, this.moveMaxRadius);
            }
          }
        },
        { passive: false }
      );
      joyBase.addEventListener('touchend', endMove, { passive: false });
      joyBase.addEventListener('touchcancel', endMove, { passive: false });
    }

    const bindTouchLookTrack = (el, idProp, lastProp, buttonScale, onStart, onEnd, { ignoreIfActive = false } = {}) => {
      if (!el) return;
      el.addEventListener(
        'touchstart',
        (e) => {
          if (this.editingLayout) return;
          e.preventDefault();
          if (ignoreIfActive && this[idProp] !== null) return;
          const t = e.changedTouches[0];
          this[idProp] = t.identifier;
          this[lastProp] = { x: t.clientX, y: t.clientY };
          onStart?.(t);
        },
        { passive: false }
      );
      el.addEventListener(
        'touchmove',
        (e) => {
          if (this.editingLayout) return;
          e.preventDefault();
          if (!this.isControlling) return;
          for (const t of e.changedTouches) {
            if (t.identifier === this[idProp]) {
              const dx = t.clientX - this[lastProp].x;
              const dy = t.clientY - this[lastProp].y;
              this[lastProp] = { x: t.clientX, y: t.clientY };
              this.applyTouchLookDelta(dx, dy, buttonScale);
            }
          }
        },
        { passive: false }
      );
      const handleEnd = (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === this[idProp]) {
            this[idProp] = null;
            onEnd?.(t);
          }
        }
      };
      el.addEventListener('touchend', handleEnd, { passive: false });
      el.addEventListener('touchcancel', handleEnd, { passive: false });
    };

    bindTouchLookTrack(lookZone, 'lookTouchId', 'lookLast', 1.0, null, null, { ignoreIfActive: true });

    // All right-thumb action buttons support simultaneous drag-to-aim while held!
    bindTouchLookTrack(
      fireBtn,
      'fireTouchId',
      'fireLast',
      1.28,
      () => {
        this.mouseDownLeft = true;
        fireBtn.classList.add('active');
      },
      () => {
        this.mouseDownLeft = false;
        fireBtn.classList.remove('active');
      }
    );

    bindTouchLookTrack(
      jumpBtn,
      'jumpTouchId',
      'jumpLast',
      1.05,
      () => {
        this.jumpBuffered = true;
        this.touchJumpHeld = true;
        jumpBtn.classList.add('active');
      },
      () => {
        this.touchJumpHeld = false;
        jumpBtn.classList.remove('active');
      }
    );

    bindTouchLookTrack(
      dashBtn,
      'dashTouchId',
      'dashLast',
      1.05,
      () => {
        this.dashBuffered = true;
        dashBtn.classList.add('active');
      },
      () => {
        dashBtn.classList.remove('active');
      }
    );

    bindTouchLookTrack(
      blockBtn,
      'blockTouchId',
      'blockLast',
      1.12,
      () => {
        this.mouseDownRight = true;
        blockBtn.classList.add('active');
      },
      () => {
        this.mouseDownRight = false;
        blockBtn.classList.remove('active');
      }
    );
  }

  updateJoystick(touch, knob, maxRadius) {
    const dx = touch.clientX - this.moveOrigin.x;
    const dy = touch.clientY - this.moveOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(maxRadius, dist);
    const angle = Math.atan2(dy, dx);
    const rawMag = maxRadius > 0 ? clamped / maxRadius : 0;
    const deadzone = 0.08;

    if (rawMag < deadzone) {
      this.joyX = 0;
      this.joyZ = 0;
    } else {
      const effMag = (rawMag - deadzone) / (1 - deadzone);
      this.joyX = Math.cos(angle) * effMag;
      this.joyZ = -Math.sin(angle) * effMag;
    }

    if (knob) {
      knob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * clamped}px), calc(-50% + ${
        Math.sin(angle) * clamped
      }px))`;
    }
  }

  sampleMovementTick() {
    let moveX = this.joyX;
    let moveZ = this.joyZ;
    if (this.keys.has('KeyD')) moveX += 1;
    if (this.keys.has('KeyA')) moveX -= 1;
    if (this.keys.has('KeyW')) moveZ += 1;
    if (this.keys.has('KeyS')) moveZ -= 1;

    moveX = clamp(moveX, -1, 1);
    moveZ = clamp(moveZ, -1, 1);

    const jump = this.jumpBuffered || this.keys.has('Space') || this.touchJumpHeld;
    const dash = this.dashBuffered;
    this.jumpBuffered = false;
    this.dashBuffered = false;

    return {
      moveX,
      moveZ,
      jump,
      dash,
      block: this.mouseDownRight,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
}
