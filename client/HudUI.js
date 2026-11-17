import { EMOTES, GAME_MODES, POWERS, RUNES, TEAMS, WEAPONS } from '../shared/constants.js';

export const TOUCH_LAYOUT_STORAGE_KEY = 'soulstrike_touch_layout';

export const TOUCH_CUSTOMIZABLE_CONTROLS = {
  fire: { id: 'fire', elId: 'touch-fire-btn', label: 'FIRE', baseSize: 74, baseFont: 14 },
  jump: { id: 'jump', elId: 'touch-jump-btn', label: 'JUMP', baseSize: 52, baseFont: 11 },
  dash: { id: 'dash', elId: 'touch-dash-btn', label: 'DASH', baseSize: 50, baseFont: 11 },
  block: { id: 'block', elId: 'touch-block-btn', label: 'GUARD / SCOPE', baseSize: 50, baseFont: 11 },
  joystick: { id: 'joystick', elId: 'touch-joy-base', label: 'JOYSTICK', baseSize: 116, baseKnobSize: 48 },
};

function clampNum(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

export function sanitizeTouchControlEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const x = Number(entry.x);
  const y = Number(entry.y);
  const scale = entry.scale === undefined ? 1.0 : Number(entry.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
  return {
    x: Math.round(clampNum(x, 5, 95) * 10) / 10,
    y: Math.round(clampNum(y, 5, 95) * 10) / 10,
    scale: Math.round(clampNum(scale, 0.5, 1.8) * 100) / 100,
  };
}

export function loadTouchLayout(storage) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(TOUCH_LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const id of Object.keys(TOUCH_CUSTOMIZABLE_CONTROLS)) {
      const clean = sanitizeTouchControlEntry(parsed[id]);
      if (clean) out[id] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTouchLayout(storage, layout) {
  if (!storage || !layout || typeof layout !== 'object') return {};
  const out = {};
  for (const id of Object.keys(TOUCH_CUSTOMIZABLE_CONTROLS)) {
    const clean = sanitizeTouchControlEntry(layout[id]);
    if (clean) out[id] = clean;
  }
  try {
    if (Object.keys(out).length === 0) {
      storage.removeItem(TOUCH_LAYOUT_STORAGE_KEY);
    } else {
      storage.setItem(TOUCH_LAYOUT_STORAGE_KEY, JSON.stringify(out));
    }
  } catch {}
  return out;
}

export function resetTouchLayout(storage) {
  if (!storage) return {};
  try {
    storage.removeItem(TOUCH_LAYOUT_STORAGE_KEY);
  } catch {}
  return {};
}

export function resolveSavedPlayerName(storage) {
  if (!storage) return '';
  const confirmed = storage.getItem('soulstrike_name_confirmed') === '1';
  if (!confirmed) {
    storage.removeItem('soulstrike_name');
    return '';
  }
  return (storage.getItem('soulstrike_name') || '').trim().slice(0, 16);
}

export function sanitizePlayerName(rawValue) {
  return String(rawValue ?? '').trim().slice(0, 16);
}

export class HudUI {
  constructor(callbacks) {
    this.cb = callbacks;
    this.shopOpen = false;
    this.emoteTrayOpen = false;
    this.layoutEditorOpen = false;
    this.isTouchMode = false;
    this.selectedTouchControlId = 'fire';
    this.touchLayout = typeof localStorage !== 'undefined' ? loadTouchLayout(localStorage) : {};
    this.killFeed = [];
    this.hitmarkerTimer = 0;
    this.hitmarkerHeadshot = false;
    this.lastShopKey = '';
    this.lastWeaponKey = '';
    this.lastAbilityKey = '';
    this.lastTouchEssence = null;

    this.el = {
      lobby: document.getElementById('lobby-overlay'),
      nameInput: document.getElementById('player-name'),
      nameError: document.getElementById('name-error'),
      enterBtn: document.getElementById('enter-btn'),
      hud: document.getElementById('hud'),
      timer: document.getElementById('match-timer'),
      scoreBanner: document.getElementById('score-banner'),
      telemetry: document.getElementById('telemetry'),
      hpBar: document.getElementById('hp-fill'),
      hpText: document.getElementById('hp-text'),
      manaBar: document.getElementById('mana-fill'),
      manaText: document.getElementById('mana-text'),
      stamBar: document.getElementById('stam-fill'),
      essenceText: document.getElementById('essence-text'),
      abilityBar: document.getElementById('ability-bar'),
      weaponBar: document.getElementById('weapon-bar'),
      crosshair: document.getElementById('crosshair'),
      scopeOverlay: document.getElementById('rail-scope-overlay'),
      touchBlockBtn: document.getElementById('touch-block-btn'),
      hitmarker: document.getElementById('hitmarker'),
      killfeed: document.getElementById('killfeed'),
      respawnBanner: document.getElementById('respawn-banner'),
      shopModal: document.getElementById('grimoire-modal'),
      shopBody: document.getElementById('grimoire-body'),
      shopEssence: document.getElementById('grimoire-essence'),
      shopFeedback: document.getElementById('grimoire-feedback'),
      scoreboard: document.getElementById('scoreboard-modal'),
      scoreboardBody: document.getElementById('scoreboard-body'),
      pauseHint: document.getElementById('pause-hint'),
      matchEndModal: document.getElementById('match-end-modal'),
      matchEndWinner: document.getElementById('match-end-winner'),
      damageFlash: document.getElementById('damage-flash'),
      emoteTray: document.getElementById('emote-tray'),
      emoteToast: document.getElementById('emote-toast'),
      shopBtn: document.getElementById('hud-shop-btn'),
      scoreBtn: document.getElementById('hud-score-btn'),
      viewBtn: document.getElementById('hud-view-btn'),
      gyroBtn: document.getElementById('hud-gyro-btn'),
      autoFireBtn: document.getElementById('hud-autofire-btn'),
      menuViewBtn: document.getElementById('menu-view-btn'),
      menuGyroBtn: document.getElementById('menu-gyro-btn'),
      menuAutoFireBtn: document.getElementById('menu-autofire-btn'),
      menuAimAssistBtn: document.getElementById('menu-aimassist-btn'),
      gyroSettingRow: document.getElementById('gyro-setting-row'),
      autoFireSettingRow: document.getElementById('autofire-setting-row'),
      aimAssistSettingRow: document.getElementById('aimassist-setting-row'),
      gyroSensRow: document.getElementById('gyro-sens-row'),
      touchSensRow: document.getElementById('touch-sens-row'),
      touchLayoutSettingRow: document.getElementById('touch-layout-setting-row'),
      menuCustomizeHudBtn: document.getElementById('menu-customize-hud-btn'),
      touchLayoutEditor: document.getElementById('touch-layout-editor'),
      touchEditorSelected: document.getElementById('touch-editor-selected'),
      touchBtnSizeSlider: document.getElementById('touch-btn-size-slider'),
      touchBtnSizeVal: document.getElementById('touch-btn-size-val'),
      touchLayoutResetBtn: document.getElementById('touch-layout-reset-btn'),
      touchLayoutSaveBtn: document.getElementById('touch-layout-save-btn'),
      gyroSensSlider: document.getElementById('gyro-sens-slider'),
      gyroSensVal: document.getElementById('gyro-sens-val'),
      touchSensSlider: document.getElementById('touch-sens-slider'),
      touchSensVal: document.getElementById('touch-sens-val'),
      hostSettingsNote: document.getElementById('host-settings-note'),
      matchActionsGroup: document.getElementById('match-actions-group'),
      btnAddBot: document.getElementById('btn-add-bot'),
      btnClearBots: document.getElementById('btn-clear-bots'),
      btnToggleMode: document.getElementById('btn-toggle-mode'),
      btnResetMatch: document.getElementById('btn-reset-match'),
    };
    this.botDiffBtns = typeof document !== 'undefined' ? [...document.querySelectorAll('.bot-diff-btn')] : [];

    this.renderEmoteTray();
    this.bindEvents();
    this.applyTouchLayout();
  }

  setTouchMode(isTouch) {
    this.isTouchMode = Boolean(isTouch);
    document.body.classList.toggle('touch-device', this.isTouchMode);
    const tc = document.getElementById('touch-controls');
    if (tc) tc.classList.toggle('hidden', !isTouch);
    this.el.gyroBtn?.classList.toggle('hidden', !isTouch);
    this.el.autoFireBtn?.classList.toggle('hidden', !isTouch);
    this.el.gyroSettingRow?.classList.toggle('hidden', !isTouch);
    this.el.autoFireSettingRow?.classList.toggle('hidden', !isTouch);
    this.el.aimAssistSettingRow?.classList.toggle('hidden', !isTouch);
    this.el.gyroSensRow?.classList.toggle('hidden', !isTouch);
    this.el.touchSensRow?.classList.toggle('hidden', !isTouch);
    this.el.touchLayoutSettingRow?.classList.toggle('hidden', !isTouch);
    this.applyTouchLayout();
  }

  setAutoFireUi(enabled) {
    const on = Boolean(enabled);
    if (this.el.autoFireBtn) {
      this.el.autoFireBtn.textContent = on ? 'AUTO ON' : 'AUTO OFF';
      this.el.autoFireBtn.classList.toggle('active-mode', on);
    }
    if (this.el.menuAutoFireBtn) {
      this.el.menuAutoFireBtn.textContent = on ? 'ON' : 'OFF';
      this.el.menuAutoFireBtn.classList.toggle('active-btn', on);
    }
  }

  setAimAssistUi(enabled) {
    const on = Boolean(enabled);
    if (this.el.menuAimAssistBtn) {
      this.el.menuAimAssistBtn.textContent = on ? 'ON' : 'OFF';
      this.el.menuAimAssistBtn.classList.toggle('active-btn', on);
    }
  }

  setPerspective(mode) {
    const isTpp = mode === 'tpp';
    if (this.el.viewBtn) {
      this.el.viewBtn.innerHTML = `${isTpp ? 'TPP' : 'FPP'}<span class="kbd-hint"> [V]</span>`;
      this.el.viewBtn.classList.toggle('active-mode', isTpp);
    }
    if (this.el.menuViewBtn) {
      this.el.menuViewBtn.textContent = isTpp ? 'TPP (3rd Person)' : 'FPP (1st Person)';
      this.el.menuViewBtn.classList.toggle('active-btn', isTpp);
    }
  }

  setGyroUi(status) {
    const enabled = Boolean(status?.enabled);
    const supported = status?.supported !== false;
    if (this.el.gyroBtn) {
      this.el.gyroBtn.textContent = !supported ? 'NO GYRO' : enabled ? 'GYRO ON' : 'GYRO';
      this.el.gyroBtn.classList.toggle('active-mode', enabled);
    }
    if (this.el.menuGyroBtn) {
      this.el.menuGyroBtn.textContent = !supported ? 'N/A' : enabled ? 'ON' : 'OFF';
      this.el.menuGyroBtn.classList.toggle('active-btn', enabled);
    }
    if (status?.sensitivity && this.el.gyroSensSlider) {
      this.el.gyroSensSlider.value = String(Number(status.sensitivity).toFixed(1));
    }
    if (status?.sensitivity && this.el.gyroSensVal) {
      this.el.gyroSensVal.textContent = `${Number(status.sensitivity).toFixed(1)}x`;
    }
  }

  setTouchSensitivityUi(mult) {
    const v = Number(mult || 1).toFixed(1);
    if (this.el.touchSensSlider) this.el.touchSensSlider.value = v;
    if (this.el.touchSensVal) this.el.touchSensVal.textContent = `${v}x`;
  }

  setBotDifficultyUi(diff, canManage = true) {
    const active = diff || 'normal';
    for (const btn of this.botDiffBtns) {
      const isMatch = btn.dataset.botDiff === active;
      btn.classList.toggle('active-btn', isMatch);
      btn.disabled = !canManage;
      btn.classList.toggle('disabled-btn', !canManage);
    }
  }

  bindEvents() {
    const savedName = resolveSavedPlayerName(localStorage);
    this.el.nameInput.value = savedName;

    this.el.nameInput.addEventListener('input', () => {
      if (sanitizePlayerName(this.el.nameInput.value)) {
        this.el.nameInput.classList.remove('input-error');
        this.el.nameError?.classList.add('hidden');
      }
    });

    this.el.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.el.enterBtn.click();
      }
    });

    this.el.enterBtn.addEventListener('click', () => {
      const name = sanitizePlayerName(this.el.nameInput.value);
      if (!name) {
        this.el.nameInput.classList.add('input-error');
        this.el.nameError?.classList.remove('hidden');
        this.el.nameInput.focus();
        return;
      }
      this.el.nameInput.classList.remove('input-error');
      this.el.nameError?.classList.add('hidden');
      localStorage.setItem('soulstrike_name', name);
      localStorage.setItem('soulstrike_name_confirmed', '1');
      const modeBtn = document.querySelector('.mode-btn.active');
      const mode = modeBtn ? modeBtn.dataset.mode : 'ffa';
      this.cb.onEnterGame(name, mode);
    });

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.getElementById('close-grimoire').addEventListener('click', () => {
      this.setShopOpen(false);
      this.cb.onResumePointer();
    });

    document.getElementById('resume-btn').addEventListener('click', () => {
      this.cb.onResumePointer();
    });

    this.el.shopBtn?.addEventListener('click', () => this.cb.onOpenShop?.());
    document.getElementById('hud-emote-btn')?.addEventListener('click', () => this.cb.onToggleEmoteTray?.());
    this.el.viewBtn?.addEventListener('click', () => {
      this.el.viewBtn.blur();
      this.cb.onTogglePerspective?.();
    });
    this.el.gyroBtn?.addEventListener('click', () => {
      this.el.gyroBtn.blur();
      this.cb.onToggleGyro?.();
    });
    this.el.autoFireBtn?.addEventListener('click', () => {
      this.el.autoFireBtn.blur();
      this.cb.onToggleAutoFire?.();
    });
    this.el.scoreBtn?.addEventListener('click', () => this.cb.onToggleScoreboard?.());
    this.el.scoreBanner?.addEventListener('click', () => this.cb.onToggleScoreboard?.());
    this.el.timer?.addEventListener('click', () => this.cb.onToggleScoreboard?.());
    document.getElementById('hud-menu-btn')?.addEventListener('click', () => this.cb.onOpenMenu?.());
    this.el.menuViewBtn?.addEventListener('click', () => this.cb.onTogglePerspective?.());
    this.el.menuGyroBtn?.addEventListener('click', () => this.cb.onToggleGyro?.());
    this.el.menuAutoFireBtn?.addEventListener('click', () => this.cb.onToggleAutoFire?.());
    this.el.menuAimAssistBtn?.addEventListener('click', () => this.cb.onToggleAimAssist?.());
    this.el.gyroSensSlider?.addEventListener('input', (e) => {
      this.cb.onGyroSensChange?.(Number(e.target.value));
    });
    this.el.touchSensSlider?.addEventListener('input', (e) => {
      this.cb.onTouchSensChange?.(Number(e.target.value));
    });
    this.el.menuCustomizeHudBtn?.addEventListener('click', () => this.openTouchLayoutEditor());
    this.el.touchLayoutSaveBtn?.addEventListener('click', () => this.closeTouchLayoutEditor());
    this.el.touchLayoutResetBtn?.addEventListener('click', () => {
      this.touchLayout = resetTouchLayout(localStorage);
      this.applyTouchLayout();
      this.selectTouchControl(this.selectedTouchControlId || 'fire');
    });
    this.el.touchBtnSizeSlider?.addEventListener('input', (e) => {
      const id = this.selectedTouchControlId || 'fire';
      const cfg = TOUCH_CUSTOMIZABLE_CONTROLS[id];
      if (!cfg) return;
      const el = document.getElementById(cfg.elId);
      let entry = this.touchLayout[id];
      if (!entry && el) {
        const rect = el.getBoundingClientRect();
        const vw = Math.max(1, window.innerWidth || 1);
        const vh = Math.max(1, window.innerHeight || 1);
        entry = {
          x: ((rect.left + rect.width / 2) / vw) * 100,
          y: ((rect.top + rect.height / 2) / vh) * 100,
          scale: 1.0,
        };
      }
      if (!entry) entry = { x: 50, y: 50, scale: 1.0 };
      const scale = Number(e.target.value) || 1.0;
      const clean = sanitizeTouchControlEntry({ ...entry, scale });
      if (clean) {
        this.touchLayout[id] = clean;
        this.applyTouchLayout();
        if (this.el.touchBtnSizeVal) {
          this.el.touchBtnSizeVal.textContent = `${Math.round(clean.scale * 100)}%`;
        }
        saveTouchLayout(localStorage, this.touchLayout);
      }
    });
    this.bindTouchLayoutDrag();
    document.getElementById('close-scoreboard')?.addEventListener('click', () => {
      this.setScoreboardOpen(false);
      this.cb.onResumePointer();
    });

    document.getElementById('btn-add-bot').addEventListener('click', () => this.cb.onMatchCmd('add_bot'));
    document.getElementById('btn-clear-bots').addEventListener('click', () => this.cb.onMatchCmd('clear_bots'));
    document.getElementById('btn-toggle-mode').addEventListener('click', () => this.cb.onToggleMode());
    document.getElementById('btn-reset-match').addEventListener('click', () => this.cb.onMatchCmd('reset_match'));
    for (const btn of this.botDiffBtns) {
      btn.addEventListener('click', () => this.cb.onSetBotDifficulty?.(btn.dataset.botDiff));
    }

    // Single delegated listener so clicking shop buttons is never lost between snapshot updates
    this.el.shopBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.shop-btn');
      if (!btn || btn.disabled) return;
      this.cb.onBuy(btn.dataset.cat, btn.dataset.id);
    });

    // Tappable weapon & power slots (especially for mobile!)
    const handleWeaponTap = (e) => {
      const pill = e.target.closest('.slot-pill');
      if (!pill || pill.classList.contains('locked')) return;
      e.preventDefault();
      let targetWeapon = pill.dataset.weapon;
      if (pill.classList.contains('active') && targetWeapon !== 'pan' && document.body.classList.contains('touch-device')) {
        const unlocked = [...this.el.weaponBar.querySelectorAll('.slot-pill:not(.locked)')].filter(
          (p) => p.dataset.weapon !== 'pan'
        );
        if (unlocked.length > 1) {
          const idx = unlocked.indexOf(pill);
          targetWeapon = unlocked[(idx + 1) % unlocked.length].dataset.weapon;
        }
      }
      this.cb.onSelectWeapon?.(targetWeapon);
    };
    this.el.weaponBar.addEventListener('touchstart', handleWeaponTap, { passive: false });
    this.el.weaponBar.addEventListener('click', handleWeaponTap);

    const handlePowerTap = (e) => {
      const slot = e.target.closest('.power-slot');
      if (!slot || slot.classList.contains('locked')) return;
      e.preventDefault();
      this.cb.onCastPower?.(slot.dataset.power);
    };
    this.el.abilityBar.addEventListener('touchstart', handlePowerTap, { passive: false });
    this.el.abilityBar.addEventListener('click', handlePowerTap);

    const handleEmoteTap = (e) => {
      const btn = e.target.closest('.emote-btn');
      if (!btn) return;
      e.preventDefault();
      this.cb.onTriggerEmote?.(btn.dataset.emote);
    };
    this.el.emoteTray?.addEventListener('touchstart', handleEmoteTap, { passive: false });
    this.el.emoteTray?.addEventListener('click', handleEmoteTap);
  }

  renderEmoteTray() {
    if (!this.el.emoteTray) return;
    this.el.emoteTray.innerHTML = Object.values(EMOTES)
      .map(
        (em) => `
        <button class="emote-btn" type="button" data-emote="${em.id}" style="--ecolor:${em.color}">
          <span class="emote-key">${em.key}</span>
          <span>${em.name}</span>
        </button>`
      )
      .join('');
  }

  setEmoteTrayOpen(open) {
    this.emoteTrayOpen = open;
    this.el.emoteTray?.classList.toggle('hidden', !open);
    if (open) {
      this.el.pauseHint.classList.add('hidden');
    }
  }

  showEmoteToast(label, variant = '') {
    if (!this.el.emoteToast) return;
    this.el.emoteToast.textContent = label.toUpperCase();
    this.el.emoteToast.classList.remove('hidden', 'pan-toast');
    if (variant) this.el.emoteToast.classList.add(variant);
    clearTimeout(this._emoteToastTimer);
    this._emoteToastTimer = setTimeout(() => {
      this.el.emoteToast.classList.add('hidden');
      this.el.emoteToast.classList.remove('pan-toast');
    }, 1850);
  }

  showLobby(visible) {
    this.el.lobby.classList.toggle('hidden', !visible);
    this.el.hud.classList.toggle('hidden', visible);
  }

  setPauseOverlay(show) {
    this.el.pauseHint.classList.toggle('hidden', !show || this.shopOpen || this.emoteTrayOpen || this.layoutEditorOpen);
  }

  applyTouchLayout() {
    if (typeof document === 'undefined') return;
    for (const cfg of Object.values(TOUCH_CUSTOMIZABLE_CONTROLS)) {
      const el = document.getElementById(cfg.elId);
      if (!el) continue;
      const entry = this.touchLayout[cfg.id];
      if (entry) {
        const size = Math.round(cfg.baseSize * entry.scale);
        el.style.position = 'fixed';
        el.style.left = `calc(${entry.x}% - ${size / 2}px)`;
        el.style.top = `calc(${entry.y}% - ${size / 2}px)`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.zIndex = '16';
        if (cfg.baseFont) {
          el.style.fontSize = `${Math.max(9, Math.round(cfg.baseFont * entry.scale))}px`;
        }
        if (cfg.id === 'joystick') {
          el.dataset.customLeft = el.style.left;
          el.dataset.customTop = el.style.top;
          const knob = document.getElementById('touch-joy-knob');
          if (knob) {
            const ks = Math.round(cfg.baseKnobSize * entry.scale);
            knob.style.width = `${ks}px`;
            knob.style.height = `${ks}px`;
          }
        } else {
          el.dataset.customPos = '1';
        }
      } else {
        el.style.position = '';
        el.style.left = '';
        el.style.top = '';
        el.style.right = '';
        el.style.bottom = '';
        el.style.width = '';
        el.style.height = '';
        el.style.fontSize = '';
        el.style.zIndex = '';
        delete el.dataset.customLeft;
        delete el.dataset.customTop;
        delete el.dataset.customPos;
        if (cfg.id === 'joystick') {
          const knob = document.getElementById('touch-joy-knob');
          if (knob) {
            knob.style.width = '';
            knob.style.height = '';
          }
        }
      }
    }
  }

  selectTouchControl(controlId) {
    const cfg = TOUCH_CUSTOMIZABLE_CONTROLS[controlId] || TOUCH_CUSTOMIZABLE_CONTROLS.fire;
    this.selectedTouchControlId = cfg.id;
    for (const c of Object.values(TOUCH_CUSTOMIZABLE_CONTROLS)) {
      document.getElementById(c.elId)?.classList.toggle('layout-selected', c.id === cfg.id);
    }
    if (this.el.touchEditorSelected) {
      this.el.touchEditorSelected.textContent = `Selected: ${cfg.label}`;
    }
    const scale = this.touchLayout[cfg.id]?.scale ?? 1.0;
    if (this.el.touchBtnSizeSlider) {
      this.el.touchBtnSizeSlider.value = String(scale.toFixed(2));
    }
    if (this.el.touchBtnSizeVal) {
      this.el.touchBtnSizeVal.textContent = `${Math.round(scale * 100)}%`;
    }
  }

  openTouchLayoutEditor() {
    this.layoutEditorOpen = true;
    this.setShopOpen(false);
    this.setEmoteTrayOpen(false);
    this.setScoreboardOpen(false);
    this.setPauseOverlay(false);
    document.body.classList.add('editing-touch-layout');
    document.getElementById('touch-controls')?.classList.remove('hidden');
    this.el.touchLayoutEditor?.classList.remove('hidden');
    this.selectTouchControl(this.selectedTouchControlId || 'fire');
    this.cb.onOpenTouchLayoutEditor?.();
  }

  closeTouchLayoutEditor() {
    this.touchLayout = saveTouchLayout(localStorage, this.touchLayout);
    this.layoutEditorOpen = false;
    document.body.classList.remove('editing-touch-layout');
    for (const c of Object.values(TOUCH_CUSTOMIZABLE_CONTROLS)) {
      document.getElementById(c.elId)?.classList.remove('layout-selected');
    }
    this.el.touchLayoutEditor?.classList.add('hidden');
    if (!this.isTouchMode) {
      document.getElementById('touch-controls')?.classList.add('hidden');
    }
    this.cb.onCloseTouchLayoutEditor?.();
  }

  bindTouchLayoutDrag() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let activeDrag = null;

    for (const cfg of Object.values(TOUCH_CUSTOMIZABLE_CONTROLS)) {
      const el = document.getElementById(cfg.elId);
      if (!el) continue;
      el.addEventListener('pointerdown', (e) => {
        if (!this.layoutEditorOpen) return;
        e.preventDefault();
        e.stopPropagation();
        this.selectTouchControl(cfg.id);
        const rect = el.getBoundingClientRect();
        activeDrag = {
          id: cfg.id,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origCx: rect.left + rect.width / 2,
          origCy: rect.top + rect.height / 2,
        };
        try {
          el.setPointerCapture?.(e.pointerId);
        } catch {}
      });
    }

    window.addEventListener('pointermove', (e) => {
      if (!this.layoutEditorOpen || !activeDrag || e.pointerId !== activeDrag.pointerId) return;
      e.preventDefault();
      const vw = Math.max(1, window.innerWidth || 1);
      const vh = Math.max(1, window.innerHeight || 1);
      const nx = ((activeDrag.origCx + (e.clientX - activeDrag.startX)) / vw) * 100;
      const ny = ((activeDrag.origCy + (e.clientY - activeDrag.startY)) / vh) * 100;
      const prevScale = this.touchLayout[activeDrag.id]?.scale ?? 1.0;
      const clean = sanitizeTouchControlEntry({ x: nx, y: ny, scale: prevScale });
      if (clean) {
        this.touchLayout[activeDrag.id] = clean;
        this.applyTouchLayout();
      }
    });

    const finishDrag = (e) => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      activeDrag = null;
      saveTouchLayout(localStorage, this.touchLayout);
    };
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  }

  setShopOpen(open, me = null) {
    this.shopOpen = open;
    this.el.shopModal.classList.toggle('hidden', !open);
    if (open) {
      this.setEmoteTrayOpen(false);
      this.el.pauseHint.classList.add('hidden');
      this.lastShopKey = '';
      if (me) this.renderShop(me);
    }
  }

  showShopFeedback(msg, isError = false) {
    if (!this.el.shopFeedback) return;
    this.el.shopFeedback.textContent = msg;
    this.el.shopFeedback.classList.toggle('error', isError);
    this.el.shopFeedback.classList.remove('hidden');
    clearTimeout(this._shopFbTimer);
    this._shopFbTimer = setTimeout(() => {
      this.el.shopFeedback.classList.add('hidden');
    }, 2400);
  }

  setScoreboardOpen(open) {
    if (open) this.setEmoteTrayOpen(false);
    this.el.scoreboard.classList.toggle('hidden', !open);
  }

  isScoreboardOpen() {
    return !this.el.scoreboard.classList.contains('hidden');
  }

  flashDamage() {
    this.el.damageFlash.classList.add('active');
    clearTimeout(this._dmgT);
    this._dmgT = setTimeout(() => this.el.damageFlash.classList.remove('active'), 160);
  }

  triggerHitmarker(headshot) {
    this.hitmarkerTimer = 0.18;
    this.hitmarkerHeadshot = headshot;
  }

  pushKillEvent(ev) {
    this.killFeed.unshift({ ...ev, ts: performance.now() });
    if (this.killFeed.length > 5) this.killFeed.pop();
    this.renderKillFeed();
  }

  renderKillFeed() {
    this.el.killfeed.innerHTML = this.killFeed
      .map(
        (k) => `
        <div class="kf-row">
          <span class="kf-killer team-${k.killerTeam}">${escapeHtml(k.killerName)}</span>
          <span class="kf-weapon${k.source === 'Golden Pan' ? ' kf-pan' : ''}">${escapeHtml(k.source)}${k.headshot ? ' <b>HS</b>' : ''}</span>
          <span class="kf-victim team-${k.victimTeam}">${escapeHtml(k.victimName)}</span>
        </div>`
      )
      .join('');
  }

  renderShop(me) {
    if (!me) return;
    this.el.shopEssence.textContent = `${me.es} Souls`;

    const shopKey = `${me.es}|${me.wp}|${me.uw.join(',')}|${me.up.join(',')}|${JSON.stringify(me.rn || {})}`;
    if (shopKey === this.lastShopKey) return;
    this.lastShopKey = shopKey;

    const weaponsHtml = Object.values(WEAPONS)
      .filter((w) => !w.pickupOnly)
      .map((w) => {
        const owned = me.uw.includes(w.id);
        const equipped = me.wp === w.id;
        const canBuy = me.es >= w.cost;
        const btnLabel = equipped ? 'EQUIPPED' : owned ? 'EQUIP' : `UNLOCK · ${w.cost}`;
        return `
          <div class="shop-card ${equipped ? 'equipped' : owned ? 'owned' : ''}" style="--item-accent:${w.color}">
            <div class="shop-card-top">
              <span class="shop-key">${w.slot}</span>
              <span class="shop-title">${w.name}</span>
            </div>
            <div class="shop-desc">${w.desc}</div>
            <button class="shop-btn ${equipped ? 'is-equipped' : ''}" data-cat="weapon" data-id="${w.id}" ${!owned && !canBuy ? 'disabled' : ''}>
              ${btnLabel}
            </button>
          </div>`;
      })
      .join('');

    const powersHtml = Object.values(POWERS)
      .map((p) => {
        const owned = me.up.includes(p.id);
        const canBuy = me.es >= p.cost;
        return `
          <div class="shop-card ${owned ? 'owned' : ''}" style="--item-accent:${p.color}">
            <div class="shop-card-top">
              <span class="shop-key">${p.key}</span>
              <span class="shop-title">${p.name}</span>
            </div>
            <div class="shop-desc">${p.desc}</div>
            <button class="shop-btn ${owned ? 'is-owned' : ''}" data-cat="power" data-id="${p.id}" ${owned || !canBuy ? 'disabled' : ''}>
              ${owned ? 'UNLOCKED' : `UNLOCK · ${p.cost}`}
            </button>
          </div>`;
      })
      .join('');

    const runesHtml = Object.values(RUNES)
      .map((r) => {
        const rank = (me.rn && me.rn[r.id]) || 0;
        const maxed = rank >= r.maxRank;
        const cost = maxed ? 0 : r.costs[rank];
        const canBuy = !maxed && me.es >= cost;
        return `
          <div class="shop-card ${rank > 0 ? 'owned' : ''}" style="--item-accent:#f59e0b">
            <div class="shop-card-top">
              <span class="shop-key">LV ${rank}/${r.maxRank}</span>
              <span class="shop-title">${r.name}</span>
            </div>
            <div class="shop-desc">${r.desc}</div>
            <button class="shop-btn ${maxed ? 'is-owned' : ''}" data-cat="rune" data-id="${r.id}" ${maxed || !canBuy ? 'disabled' : ''}>
              ${maxed ? 'MAXED' : `UPGRADE · ${cost}`}
            </button>
          </div>`;
      })
      .join('');

    this.el.shopBody.innerHTML = `
      <div class="shop-section"><h3>Weapons (Keys 1–3)</h3><div class="shop-grid">${weaponsHtml}</div></div>
      <div class="shop-section"><h3>Spells (Keys Q E R F G)</h3><div class="shop-grid">${powersHtml}</div></div>
      <div class="shop-section"><h3>Passive Upgrades</h3><div class="shop-grid">${runesHtml}</div></div>
    `;
  }

  update(dt, snap, me, predState, telemetry) {
    const isScoped = Boolean(telemetry?.scoped && me && me.al && me.wp === 'rail');
    const isLocked = Boolean(telemetry?.targetLocked && me && me.al);
    this.el.scopeOverlay?.classList.toggle('hidden', !isScoped);
    this.el.scopeOverlay?.classList.toggle('target-locked', isScoped && isLocked);
    this.el.crosshair?.classList.toggle('hidden', isScoped);
    this.el.crosshair?.classList.toggle('target-locked', !isScoped && isLocked);
    if (this.el.touchBlockBtn && me) {
      const wantLabel = me.wp === 'rail' ? 'SCOPE' : 'GUARD';
      if (this.el.touchBlockBtn.textContent !== wantLabel) {
        this.el.touchBlockBtn.textContent = wantLabel;
      }
    }
    if (me && this.el.shopBtn && document.body.classList.contains('touch-device')) {
      if (this.lastTouchEssence !== me.es) {
        this.lastTouchEssence = me.es;
        this.el.shopBtn.textContent = `SHOP · ${me.es}✦`;
      }
    }

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer = Math.max(0, this.hitmarkerTimer - dt);
      this.el.hitmarker.classList.remove('hidden');
      this.el.hitmarker.classList.toggle('headshot', this.hitmarkerHeadshot);
    } else {
      this.el.hitmarker.classList.add('hidden');
    }

    // Expire old killfeed entries
    const nowPerf = performance.now();
    if (this.killFeed.some((k) => nowPerf - k.ts > 7000)) {
      this.killFeed = this.killFeed.filter((k) => nowPerf - k.ts <= 7000);
      this.renderKillFeed();
    }

    const transportMap = {
      host: 'HOST P2P',
      'p2p-udp': 'P2P UDP',
      'p2p-relay': 'P2P RELAY',
    };
    const transportLabel = transportMap[telemetry.transport] || '';
    const modePrefix = transportLabel ? `${transportLabel} · ` : '';
    this.el.telemetry.textContent = `${modePrefix}${Math.round(telemetry.rtt)}ms · ${Math.round(telemetry.fps)} FPS`;

    if (!snap) return;

    const mins = Math.floor(snap.mt / 60);
    const secs = String(snap.mt % 60).padStart(2, '0');
    this.el.timer.textContent = `${mins}:${secs}`;

    if (snap.md === GAME_MODES.TDM) {
      this.el.scoreBanner.innerHTML = `
        <span class="team-1">RED ${snap.ts[TEAMS.CRIMSON] || 0}</span>
        <span class="vs-sep">VS</span>
        <span class="team-2">${snap.ts[TEAMS.AZURE] || 0} BLUE</span>`;
    } else {
      const top = [...snap.pl].sort((a, b) => b.kl - a.kl)[0];
      this.el.scoreBanner.innerHTML = `<span class="ffa-badge">FFA</span>${
        top ? `<span class="leader-txt">1st: ${escapeHtml(top.n)} (${top.kl})</span>` : ''
      }`;
    }

    // Match End screen
    if (snap.ms === 'ended') {
      this.el.matchEndModal.classList.remove('hidden');
    } else {
      this.el.matchEndModal.classList.add('hidden');
    }

    // Scoreboard & Manager/Host Settings Permission State
    const resolvedHostId = telemetry.hostId || snap.hi;
    const resolvedManagerId = telemetry.managerId || snap.mi || resolvedHostId;
    const canManage = Boolean(telemetry.canManageServer);
    const managerPlayer = snap.pl?.find((p) => p.id === resolvedManagerId);

    for (const btn of [this.el.btnAddBot, this.el.btnClearBots, this.el.btnToggleMode, this.el.btnResetMatch]) {
      if (!btn) continue;
      btn.disabled = !canManage;
      btn.classList.toggle('disabled-btn', !canManage);
    }
    this.setBotDifficultyUi(snap.bd || 'normal', canManage);
    if (this.el.hostSettingsNote) {
      this.el.hostSettingsNote.textContent = canManage
        ? 'Server Controls — You are the Lobby Manager'
        : `Server Controls Locked — Managed by ${managerPlayer ? managerPlayer.n : 'Lobby Manager'}`;
      this.el.hostSettingsNote.classList.toggle('locked', !canManage);
    }

    const sorted = [...snap.pl].sort((a, b) => b.kl - a.kl || a.dh - b.dh);
    this.el.scoreboardBody.innerHTML = sorted
      .map(
        (p) => `
        <tr class="${me && p.id === me.id ? 'me-row' : ''}">
          <td class="team-${p.tm}">${escapeHtml(p.n)}${p.b ? ' <small>[BOT]</small>' : ''}${
            resolvedHostId && p.id === resolvedHostId ? ' <small>[HOST]</small>' : ''
          }</td>
          <td>${p.kl}</td>
          <td>${p.dh}</td>
          <td>${p.hs}</td>
          <td>${p.dm}</td>
          <td>${p.es}</td>
        </tr>`
      )
      .join('');

    if (!me) return;

    const hp = me.hp;
    const mhp = me.mhp || 120;
    this.el.hpBar.style.width = `${Math.max(0, Math.min(100, (hp / mhp) * 100))}%`;
    this.el.hpText.textContent = `${hp} / ${mhp}`;

    const mana = me.mn;
    this.el.manaBar.style.width = `${Math.max(0, Math.min(100, mana))}%`;
    this.el.manaText.textContent = `${mana}`;

    const stam = predState ? Math.round(predState.stamina) : me.st;
    this.el.stamBar.style.width = `${Math.max(0, Math.min(100, stam))}%`;
    this.el.essenceText.textContent = `${me.es}`;

    this.el.respawnBanner.classList.toggle('hidden', Boolean(me.al));
    if (!me.al) {
      const shopTip = document.body.classList.contains('touch-device') ? 'Tap SHOP to upgrade' : 'Press B for Shop';
      this.el.respawnBanner.innerHTML = `<div class="respawn-title">KNOCKED OUT</div><div class="respawn-sub">Back in ${Math.max(0.1, me.rt).toFixed(1)}s · ${shopTip}</div>`;
    }

    // Weapon slots
    const weaponKey = `${me.wp}|${me.uw.join(',')}`;
    if (weaponKey !== this.lastWeaponKey) {
      this.lastWeaponKey = weaponKey;
      const standardHtml = Object.values(WEAPONS)
        .filter((w) => !w.pickupOnly)
        .map((w) => {
          const unlocked = me.uw.includes(w.id);
          const active = me.wp === w.id;
          return `<div class="slot-pill ${active ? 'active' : ''} ${!unlocked ? 'locked' : ''}" data-weapon="${w.id}">
            <span class="slot-key">${w.slot}</span>
            <span class="slot-name">${w.name}</span>
          </div>`;
        })
        .join('');
      const panHtml =
        me.wp === 'pan' && WEAPONS.pan
          ? `<div class="slot-pill active pan-pill" data-weapon="pan">
              <span class="slot-key">${WEAPONS.pan.slot}</span>
              <span class="slot-name">${WEAPONS.pan.name} (1 SHOT)</span>
            </div>`
          : '';
      this.el.weaponBar.innerHTML = standardHtml + panHtml;
    }

    // Power slots
    const abilityKey = `${me.mn}|${me.up.join(',')}|${Object.entries(me.cds || {})
      .map(([k, v]) => `${k}:${v > 0 ? v.toFixed(1) : '0'}`)
      .join(',')}`;
    if (abilityKey !== this.lastAbilityKey) {
      this.lastAbilityKey = abilityKey;
      this.el.abilityBar.innerHTML = Object.values(POWERS)
        .map((p) => {
          const unlocked = me.up.includes(p.id);
          const cd = (me.cds && me.cds[p.id]) || 0;
          const noMana = me.mn < p.manaCost;
          return `<div class="power-slot ${!unlocked ? 'locked' : ''} ${cd > 0 ? 'cooldown' : ''} ${
            unlocked && noMana ? 'nomana' : ''
          }" data-power="${p.id}" style="--pcolor:${p.color}">
            <div class="power-key">${p.key}</div>
            <div class="power-label">${unlocked ? p.name.split(' ')[1] || p.name : `${p.cost}g`}</div>
            ${cd > 0 ? `<div class="power-cd">${cd.toFixed(1)}</div>` : ''}
          </div>`;
        })
        .join('');
    }
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
