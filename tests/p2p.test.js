import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { P2PCoordinator } from '../server/P2PCoordinator.js';
import { NetClient } from '../client/NetClient.js';
import { resolveSavedPlayerName, sanitizePlayerName } from '../client/HudUI.js';
import { InputManager } from '../client/InputManager.js';
import { computeTouchLookDelta, evaluateMobileCombatAssist } from '../client/mobileAssist.js';
import { FIXED_DT, GAME_MODES, MAX_LOBBY_PLAYERS, PLAYER_EYE_HEIGHT, TEAMS, WEAPONS } from '../shared/constants.js';
import { ARENA_BOXES, ARENA_HALF_SIZE } from '../shared/arena.js';
import { raycastArena } from '../shared/physics.js';
import { MSG } from '../shared/protocol.js';

function createRecordingSocket() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
}

function createHubSocketFactory(coordinator) {
  const socketsByPeer = new Map();

  class HubWebSocket {
    constructor() {
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._peerId = null;

      this._serverWs = {
        readyState: 1,
        send: (raw) => {
          queueMicrotask(() => {
            if (this.readyState === 1 && this.onmessage) {
              this.onmessage({ data: raw });
            }
          });
        },
      };

      queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }

    send(raw) {
      if (this.readyState !== 1) return;
      const msg = JSON.parse(raw);
      if (!this._peerId) {
        if (msg.t === MSG.P2P_JOIN || msg.t === MSG.JOIN) {
          this._peerId = coordinator.handleJoin(this._serverWs, msg);
          socketsByPeer.set(this._peerId, this);
        }
        return;
      }
      coordinator.handleMessage(this._peerId, msg);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._serverWs.readyState = 3;
      const id = this._peerId;
      this._peerId = null;
      if (id) {
        socketsByPeer.delete(id);
        coordinator.handleDisconnect(id);
      }
      if (this.onclose) this.onclose();
    }
  }

  return { HubWebSocket, socketsByPeer };
}

function createPairedRtcClass() {
  const registry = new Map();
  let nextDcId = 1;

  class MockDataChannel {
    constructor(label, opts = {}) {
      this.id = nextDcId++;
      this.label = label;
      this.ordered = opts.ordered !== false;
      this.maxRetransmits = opts.maxRetransmits;
      this.readyState = 'connecting';
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      this._peerChannel = null;
      this.sentMessages = [];
    }

    send(data) {
      if (this.readyState !== 'open' || !this._peerChannel) {
        throw new Error('DataChannel not open');
      }
      this.sentMessages.push(data);
      const target = this._peerChannel;
      queueMicrotask(() => {
        if (target.readyState === 'open' && target.onmessage) {
          target.onmessage({ data });
        }
      });
    }

    close() {
      this.readyState = 'closed';
      if (this.onclose) this.onclose();
    }
  }

  class MockRTCPeerConnection {
    constructor() {
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.ondatachannel = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this._channels = [];
      this._pairedPeer = null;
      this._id = `rtc_${Math.random().toString(36).slice(2, 8)}`;
      registry.set(this._id, this);
    }

    createDataChannel(label, opts) {
      const ch = new MockDataChannel(label, opts);
      this._channels.push(ch);
      return ch;
    }

    async createOffer() {
      return { type: 'offer', sdp: this._id };
    }

    async setLocalDescription(desc) {
      this.localDescription = desc;
    }

    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      if (desc.type === 'offer') {
        const remotePc = registry.get(desc.sdp);
        this._pairedPeer = remotePc;
        remotePc._pairedPeer = this;
      } else if (desc.type === 'answer' && this._pairedPeer) {
        const answerer = this._pairedPeer;
        this.connectionState = 'connected';
        answerer.connectionState = 'connected';
        for (const hostCh of this._channels) {
          const guestCh = new MockDataChannel(hostCh.label, {
            ordered: hostCh.ordered,
            maxRetransmits: hostCh.maxRetransmits,
          });
          hostCh._peerChannel = guestCh;
          guestCh._peerChannel = hostCh;
          answerer._channels.push(guestCh);
          if (answerer.ondatachannel) {
            answerer.ondatachannel({ channel: guestCh });
          }
          hostCh.readyState = 'open';
          guestCh.readyState = 'open';
          if (hostCh.onopen) hostCh.onopen();
          if (guestCh.onopen) guestCh.onopen();
        }
      }
    }

    async createAnswer() {
      return { type: 'answer', sdp: this._id };
    }

    async addIceCandidate() {}

    close() {
      this.connectionState = 'closed';
      for (const ch of this._channels) {
        if (ch.readyState !== 'closed') ch.close();
      }
    }
  }

  return MockRTCPeerConnection;
}

function waitUntil(predicate, timeoutMs = 1500, stepMs = 15) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error('Timed out waiting for condition'));
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

test('GameRoom checkpoint export and import preserves full arena, pan, and combat state', () => {
  const room1 = new GameRoom();
  room1.mode = GAME_MODES.TDM;
  room1.teamScores = { [TEAMS.CRIMSON]: 9, [TEAMS.AZURE]: 6 };
  room1.matchTimeLeft = 184.5;

  const p1 = room1.createPlayerEntity('p1', 'CrimsonAce', null, false, TEAMS.CRIMSON);
  const p2 = room1.createPlayerEntity('p2', 'AzureMage', null, false, TEAMS.AZURE);
  room1.players.set(p1.id, p1);
  room1.players.set(p2.id, p2);
  const bot = room1.addBot();

  p1.x = 4.25;
  p1.y = 1.5;
  p1.z = -3.75;
  p1.essence = 420;
  p1.kills = 5;
  p1.unlockedWeapons.add('runeblade');
  p1.unlockedWeapons.add('rail');
  p1.prevWeapon = 'rail';
  p1.weapon = 'pan';

  p2.hp = 77;
  p2.unlockedPowers.add('blink');
  p2.runes.vitality = 2;

  room1.spawnPanPickup({ x: -8.5, y: 0.5, z: 6.0 });
  room1.orbs[0].active = false;
  room1.orbs[0].respawnTimer = 9.25;
  room1.spawnProjectile({
    ownerId: 'p2',
    team: TEAMS.AZURE,
    kind: 'fireball',
    label: 'Pyre Orb',
    color: '#fb923c',
    x: 1,
    y: 2,
    z: 3,
    vx: 10,
    vy: 0,
    vz: -15,
    damage: 42,
    radius: 0.4,
    splash: 3.5,
    life: 2.2,
  });

  const cp = room1.exportCheckpoint();

  const room2 = new GameRoom();
  const attachedWs = createRecordingSocket();
  const ok = room2.importCheckpoint(cp, (id) => (id === 'p1' ? attachedWs : null));
  assert.equal(ok, true);
  assert.equal(room2.mode, GAME_MODES.TDM);
  assert.equal(room2.teamScores[TEAMS.CRIMSON], 9);
  assert.equal(room2.teamScores[TEAMS.AZURE], 6);
  assert.equal(room2.matchTimeLeft, 184.5);
  assert.deepEqual(room2.panPickup, { x: -8.5, y: 0.5, z: 6.0 });
  assert.equal(room2.orbs[0].active, false);
  assert.equal(room2.orbs[0].respawnTimer, 9.25);
  assert.equal(room2.projectiles.length, 1);
  assert.equal(room2.projectiles[0].kind, 'fireball');

  const rP1 = room2.players.get('p1');
  const rP2 = room2.players.get('p2');
  assert.ok(rP1 && rP2 && room2.bots.has(bot.id));
  assert.equal(rP1.weapon, 'pan');
  assert.equal(rP1.prevWeapon, 'rail');
  assert.equal(rP1.unlockedWeapons.has('runeblade'), true);
  assert.equal(rP1.essence, 420);
  assert.equal(rP1.kills, 5);
  assert.equal(rP1.ws, attachedWs);
  assert.equal(rP2.hp, 77);
  assert.equal(rP2.unlockedPowers.has('blink'), true);
  assert.equal(rP2.runes.vitality, 2);

  // Reattaching p2 sends WELCOME without erasing checkpoint progression
  const p2Ws = createRecordingSocket();
  room2.attachOrAddHuman('p2', p2Ws, 'AzureMage', TEAMS.AZURE);
  assert.equal(room2.players.get('p2').hp, 77);
  assert.equal(p2Ws.sent[0].t, MSG.WELCOME);
  assert.equal(p2Ws.sent[0].id, 'p2');
});

test('P2PCoordinator elects first host, relays signals/packets, and migrates host on disconnect', () => {
  const coord = new P2PCoordinator();
  const ws1 = createRecordingSocket();
  const ws2 = createRecordingSocket();
  const ws3 = createRecordingSocket();

  const id1 = coord.handleJoin(ws1, { name: 'Alpha' });
  const id2 = coord.handleJoin(ws2, { name: 'Bravo' });
  const id3 = coord.handleJoin(ws3, { name: 'Charlie' });

  assert.equal(id1, 'p1');
  assert.equal(id2, 'p2');
  assert.equal(id3, 'p3');

  assert.equal(ws1.sent[0].t, MSG.P2P_ROLE);
  assert.equal(ws1.sent[0].isHost, true);
  assert.equal(ws1.sent[0].hostId, 'p1');
  assert.equal(ws2.sent[0].isHost, false);
  assert.equal(ws2.sent[0].hostId, 'p1');

  // Host join notification to existing peers
  assert.ok(ws1.sent.some((m) => m.t === MSG.P2P_PEER_JOINED && m.peerId === 'p2'));

  // WebRTC SDP signaling forwards between peers
  coord.handleMessage('p1', { t: MSG.P2P_SIGNAL, toId: 'p2', desc: { type: 'offer', sdp: 'test' } });
  const sigMsg = ws2.sent.find((m) => m.t === MSG.P2P_SIGNAL);
  assert.ok(sigMsg);
  assert.equal(sigMsg.fromId, 'p1');
  assert.equal(sigMsg.desc.type, 'offer');

  // Relay fallback delivers guest fast/reliable payload to current host
  coord.handleMessage('p2', { t: MSG.P2P_RELAY, fast: 1, data: { t: MSG.INPUT, ticks: [{ seq: 1 }] } });
  const relayMsg = ws1.sent.find((m) => m.t === MSG.P2P_RELAY);
  assert.ok(relayMsg);
  assert.equal(relayMsg.fromId, 'p2');
  assert.equal(relayMsg.fast, true);
  assert.equal(relayMsg.data.t, MSG.INPUT);

  // Checkpoint updates broadcast to non-host peers
  coord.handleMessage('p1', {
    t: MSG.P2P_CHECKPOINT,
    checkpoint: {
      seq: 3,
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    },
  });
  assert.equal(ws2.sent.some((m) => m.t === MSG.P2P_CHECKPOINT), true);

  // Disconnect Host p1 -> p2 automatically becomes new host with p1 pruned from checkpoint
  coord.handleDisconnect('p1');
  const mig2 = ws2.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  const mig3 = ws3.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  assert.ok(mig2 && mig3);
  assert.equal(mig2.newHostId, 'p2');
  assert.equal(mig2.prevHostId, 'p1');
  assert.equal(coord.hostId, 'p2');
  assert.deepEqual(
    mig2.checkpoint.players.map((pl) => pl.id),
    ['p2', 'p3']
  );

  // Last disconnects reset coordinator cleanly
  coord.handleDisconnect('p2');
  coord.handleDisconnect('p3');
  assert.equal(coord.hostId, null);
  assert.equal(coord.latestCheckpoint, null);
});

test('End-to-end NetClient hosts locally, upgrades to WebRTC DataChannels, falls back to relay, and survives host migration', async (t) => {
  const coord = new P2PCoordinator();
  const { HubWebSocket } = createHubSocketFactory(coord);
  const MockRTC = createPairedRtcClass();

  const c1 = new NetClient({
    WebSocketImpl: HubWebSocket,
    RTCPeerConnectionImpl: MockRTC,
    forceInProcessHost: true,
    url: 'ws://mock',
  });
  const c2 = new NetClient({
    WebSocketImpl: HubWebSocket,
    RTCPeerConnectionImpl: MockRTC,
    forceInProcessHost: true,
    url: 'ws://mock',
  });

  t.after(() => {
    c1.disconnect();
    c2.disconnect();
  });

  let c1Snap = null;
  let c2Snap = null;
  let c2Migrated = null;

  c1.onSnapshot = (s) => {
    c1Snap = s;
  };
  c2.onSnapshot = (s) => {
    c2Snap = s;
  };
  c2.onHostMigrate = (info) => {
    c2Migrated = info;
  };

  c1.connect('HostAlpha');
  await waitUntil(() => c1.isHost && c1Snap !== null);
  assert.equal(c1.transportMode, 'host');

  c2.connect('GuestBravo');
  await waitUntil(() => c2Snap !== null && c2Snap.pl.some((p) => p.id === 'p2'));
  await waitUntil(() => c2.transportMode === 'p2p-udp');

  // Guest buys Shadow Blink (cost 150 <= starting 175) over WebRTC DataChannel
  c2.send({ t: MSG.BUY, category: 'power', id: 'blink' });
  await waitUntil(() => {
    const me2 = c2Snap?.pl.find((p) => p.id === 'p2');
    return me2 && me2.up.includes('blink') && me2.es === 25;
  });

  // Abruptly disconnect Host c1!
  c1.ws.close();

  await waitUntil(() => c2Migrated !== null && c2.isHost && c2.transportMode === 'host');
  assert.equal(c2Migrated.isHost, true);
  assert.equal(c2Migrated.hostId, 'p2');

  // Clear old snapshot & verify newly migrated Host c2 keeps generating snapshots with preserved progression & without p1
  c2Snap = null;
  await waitUntil(() => c2Snap !== null);
  const meAfterMigrate = c2Snap.pl.find((p) => p.id === 'p2');
  assert.ok(meAfterMigrate, 'New host p2 should be in migrated snapshots');
  assert.equal(meAfterMigrate.up.includes('blink'), true);
  assert.equal(meAfterMigrate.es, 25);
  assert.equal(
    c2Snap.pl.some((p) => p.id === 'p1'),
    false,
    'Disconnected former host p1 must be removed'
  );
});

test('NetClient operates seamlessly over P2P relay fallback when RTCPeerConnection is unavailable', async (t) => {
  const coord = new P2PCoordinator();
  const { HubWebSocket } = createHubSocketFactory(coord);

  const host = new NetClient({
    WebSocketImpl: HubWebSocket,
    RTCPeerConnectionImpl: null,
    forceInProcessHost: true,
    url: 'ws://mock',
  });
  const guest = new NetClient({
    WebSocketImpl: HubWebSocket,
    forceInProcessHost: true,
    url: 'ws://mock',
  });
  // Explicitly simulate browser/firewall blocking WebRTC
  guest.opts.RTCPeerConnectionImpl = undefined;

  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });

  let guestSnap = null;
  let guestWelcome = null;
  guest.onWelcome = (w) => {
    guestWelcome = w;
  };
  guest.onSnapshot = (s) => {
    guestSnap = s;
  };

  const origRtc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  try {
    host.connect('RelayHost');
    await waitUntil(() => host.isHost && host.playerId === 'p1');
    guest.connect('RelayGuest');
    await waitUntil(() => guestWelcome !== null && guestSnap !== null);
    assert.equal(guest.transportMode, 'p2p-relay');
    assert.ok(guestSnap.pl.some((p) => p.id === 'p2'));
  } finally {
    globalThis.RTCPeerConnection = origRtc;
  }
});

test('Only the first/host or sole player in lobby can manage server settings (bots, mode, reset)', () => {
  const room = new GameRoom();
  const ws1 = createRecordingSocket();
  const ws2 = createRecordingSocket();

  const p1 = room.addHumanPlayer(ws1, 'FirstHost');
  const p2 = room.addHumanPlayer(ws2, 'SecondGuest');

  assert.equal(room.canManageRoom(p1), true, 'first player who joined should be host');
  assert.equal(room.canManageRoom(p2), false, 'non-host guest must not manage room settings');

  // Guest attempts to add bots, clear bots, switch mode, or reset match are ignored
  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'add_bot' });
  assert.equal(room.bots.size, 0, 'guest cannot add bots');

  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'set_mode', mode: GAME_MODES.TDM });
  assert.equal(room.mode, GAME_MODES.FFA, 'guest cannot switch mode');

  p1.kills = 4;
  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'reset_match' });
  assert.equal(p1.kills, 4, 'guest cannot reset match');

  // Host can add bots, switch modes, and clear bots
  room.handleClientMessage(p1, { t: MSG.MATCH_CMD, cmd: 'add_bot' });
  assert.equal(room.bots.size, 1, 'host can add bots');

  room.handleClientMessage(p1, { t: MSG.MATCH_CMD, cmd: 'set_mode', mode: GAME_MODES.TDM });
  assert.equal(room.mode, GAME_MODES.TDM, 'host can switch mode to TDM');

  // Guest still cannot clear host-added bots while host is present
  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'clear_bots' });
  assert.equal(room.bots.size, 1, 'guest still cannot clear bots while host is connected');

  // When first host leaves, remaining sole player p2 automatically gains room control
  room.removePlayer(p1.id);
  assert.equal(room.canManageRoom(p2), true, 'remaining sole human should gain room settings control');

  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'clear_bots' });
  assert.equal(room.bots.size, 0, 'sole remaining player can clear bots');

  room.handleClientMessage(p2, { t: MSG.MATCH_CMD, cmd: 'set_mode', mode: GAME_MODES.FFA });
  assert.equal(room.mode, GAME_MODES.FFA, 'sole remaining player can switch mode back to FFA');
});

test('NetClient canManageServer reflects host vs guest role and initial mode gating', async (t) => {
  const coord = new P2PCoordinator();
  const { HubWebSocket } = createHubSocketFactory(coord);

  const c1 = new NetClient({
    WebSocketImpl: HubWebSocket,
    RTCPeerConnectionImpl: null,
    forceInProcessHost: true,
    url: 'ws://mock',
  });
  const c2 = new NetClient({
    WebSocketImpl: HubWebSocket,
    RTCPeerConnectionImpl: null,
    forceInProcessHost: true,
    url: 'ws://mock',
  });

  t.after(() => {
    c1.disconnect();
    c2.disconnect();
  });

  let c1Snap = null;
  let c2Snap = null;
  c1.onSnapshot = (s) => {
    c1Snap = s;
  };
  c2.onSnapshot = (s) => {
    c2Snap = s;
  };

  const origRtc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  try {
    // Host joins choosing TDM; second guest joins choosing FFA (guest's lobby choice must not override host's TDM)
    c1.connect('HostTDM', null, GAME_MODES.TDM);
    await waitUntil(() => c1.isHost && c1Snap && c1Snap.md === GAME_MODES.TDM);
    assert.equal(c1.canManageServer(), true);

    c2.connect('GuestFFA', null, GAME_MODES.FFA);
    await waitUntil(() => c2Snap && c2Snap.pl.some((p) => p.id === 'p2'));
    assert.equal(c2.canManageServer(), false);
    assert.equal(c2Snap.md, GAME_MODES.TDM, 'guest joining must inherit host TDM mode');

    // Host leaves -> c2 becomes host and regains management privileges
    c1.ws.close();
    await waitUntil(() => c2.isHost && c2.canManageServer());
  } finally {
    globalThis.RTCPeerConnection = origRtc;
  }
});

test('Player name starts empty without generic SoulKnight default until user confirms a name once', () => {
  function createMemoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  }

  // Fresh storage returns empty string
  const fresh = createMemoryStorage();
  assert.equal(resolveSavedPlayerName(fresh), '');

  // Unconfirmed legacy default stored from prior builds is wiped and returns empty string
  const legacy = createMemoryStorage({ soulstrike_name: 'SoulKnight' });
  assert.equal(resolveSavedPlayerName(legacy), '');
  assert.equal(legacy.getItem('soulstrike_name'), null);

  // Blank or whitespace-only input is rejected (empty string)
  assert.equal(sanitizePlayerName(''), '');
  assert.equal(sanitizePlayerName('    '), '');
  assert.equal(sanitizePlayerName('  Aria  '), 'Aria');

  // Once explicitly confirmed, the saved name is restored on future visits
  const confirmed = createMemoryStorage({
    soulstrike_name: 'Aria',
    soulstrike_name_confirmed: '1',
  });
  assert.equal(resolveSavedPlayerName(confirmed), 'Aria');
});

test('Astral Rail scope metadata and InputManager zoom sensitivity scaling work cleanly', () => {
  assert.match(WEAPONS.rail.desc, /Scope/i);

  const mockInput = Object.create(InputManager.prototype);
  mockInput.keys = new Set();
  mockInput.scoped = false;
  mockInput.scopeSensMultiplier = 0.42;
  mockInput.mouseDownRight = true;
  mockInput.blockTouchId = 3;

  assert.equal(mockInput.activeZoomSensScale, 1.0);
  mockInput.setScoped(true);
  assert.equal(mockInput.scoped, true);
  assert.equal(mockInput.activeZoomSensScale, 0.42);
  mockInput.setScoped(false);
  assert.equal(mockInput.scoped, false);
  assert.equal(mockInput.activeZoomSensScale, 1.0);

  mockInput.setUiBlocked(true);
  assert.equal(mockInput.mouseDownRight, false);
  assert.equal(mockInput.blockTouchId, null);
});

test('Mobile touch look acceleration, aim assist, auto-fire lock, and InputManager toggles work properly', () => {
  // 1. computeTouchLookDelta: speed curve, pitch scaling, zoom scale, and assist slowdown
  const baseSens = 0.0044;
  const micro = computeTouchLookDelta(1, 0, baseSens, 1.0, 1.0);
  const flick = computeTouchLookDelta(25, 0, baseSens, 1.0, 1.0);
  assert.ok(Math.abs(micro.dYaw) / 1 < baseSens, 'micro swipe should stay below 1.0x for fine aiming');
  assert.ok(Math.abs(flick.dYaw) / 25 > baseSens * 1.25, 'fast flick should accelerate turn speed');

  const diag = computeTouchLookDelta(10, 10, baseSens, 1.0, 1.0);
  assert.ok(Math.abs(diag.dPitch / diag.dYaw - 0.78) < 1e-6, 'vertical touch pitch should be scaled to 0.78x');

  const unzoomed = computeTouchLookDelta(10, 0, baseSens, 1.0, 1.0);
  const zoomed = computeTouchLookDelta(10, 0, baseSens, 0.42, 1.0);
  assert.ok(Math.abs(zoomed.dYaw - unzoomed.dYaw * 0.42) < 1e-6, 'zoom scale should apply cleanly');

  const slowed = computeTouchLookDelta(25, 0, baseSens, 1.0, 0.55);
  assert.ok(Math.abs(slowed.dYaw) < Math.abs(flick.dYaw) * 0.6, 'aim-assist slowdown should damp sensitivity on target');

  // 2. evaluateMobileCombatAssist on open lane (-19.5, y, 8 -> -4 along -Z)
  const eye = { x: -19.5, y: PLAYER_EYE_HEIGHT, z: 8.0 };
  assert.equal(raycastArena(eye, { x: 0, y: 0, z: -1 }, 12.5, ARENA_BOXES), null);

  const openEnemy = { id: 'e1', al: true, tm: TEAMS.AZURE, x: -19.5, y: 0, z: -4.0 };
  // ~0.08 rad slightly off crosshair (yaw=0 aims straight at -Z; negative x is yaw > 0)
  const offCenterYaw = -0.08;
  const pullAssist = evaluateMobileCombatAssist({
    eye,
    yaw: offCenterYaw,
    pitch: -0.02,
    weaponId: 'staff',
    enemies: [openEnemy],
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: FIXED_DT,
    isActivelyAimingOrMoving: true,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0,
  });
  assert.ok(pullAssist.dYaw > 0, 'rotational aim assist should gently pull yaw toward nearby visible enemy');
  assert.ok(pullAssist.slowdown < 1.0, 'sensitivity slowdown should activate inside assist cone');

  // Direct reticle lock triggers auto-fire once lockTimer crosses staff lockDelay (0.025s)
  const lockStep1 = evaluateMobileCombatAssist({
    eye,
    yaw: 0,
    pitch: -0.03,
    weaponId: 'staff',
    enemies: [openEnemy],
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: 0.016,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0,
  });
  assert.equal(lockStep1.targetLocked, true);
  assert.equal(lockStep1.shouldAutoFire, false);

  const lockStep2 = evaluateMobileCombatAssist({
    eye,
    yaw: 0,
    pitch: -0.03,
    weaponId: 'staff',
    enemies: [openEnemy],
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: 0.016,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: lockStep1.lockTimer,
  });
  assert.equal(lockStep2.shouldAutoFire, true, 'auto-fire should fire once target lock persists past delay');

  // Wall occlusion blocks both aim assist and auto-fire (across central obelisk)
  const occludedAssist = evaluateMobileCombatAssist({
    eye: { x: 0, y: PLAYER_EYE_HEIGHT, z: 8.0 },
    yaw: 0,
    pitch: -0.02,
    weaponId: 'staff',
    enemies: [{ id: 'e2', al: true, tm: TEAMS.AZURE, x: 0, y: 0, z: -8.0 }],
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: 0.05,
    isActivelyAimingOrMoving: true,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0,
  });
  assert.equal(occludedAssist.targetLocked, false);
  assert.equal(occludedAssist.shouldAutoFire, false);
  assert.equal(occludedAssist.slowdown, 1.0);
  assert.equal(occludedAssist.dYaw, 0);

  // TDM teammate protection ignores allies
  const teammateAssist = evaluateMobileCombatAssist({
    eye,
    yaw: 0,
    pitch: -0.03,
    weaponId: 'staff',
    enemies: [{ id: 'ally1', al: true, tm: TEAMS.CRIMSON, x: -19.5, y: 0, z: -4.0 }],
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.TDM,
    dt: 0.05,
    isActivelyAimingOrMoving: true,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0.5,
  });
  assert.equal(teammateAssist.targetLocked, false);
  assert.equal(teammateAssist.shouldAutoFire, false);

  // Golden Pan never auto-throws at distant enemy, only auto-swings in guaranteed melee range
  const panFar = evaluateMobileCombatAssist({
    eye,
    yaw: 0,
    pitch: -0.03,
    weaponId: 'pan',
    enemies: [openEnemy], // 12m away > meleeRange 4.1m
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: 0.05,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0,
  });
  assert.equal(panFar.targetLocked, false);
  assert.equal(panFar.shouldAutoFire, false);

  const panMelee = evaluateMobileCombatAssist({
    eye,
    yaw: 0,
    pitch: -0.1,
    weaponId: 'pan',
    enemies: [{ id: 'eNear', al: true, tm: TEAMS.AZURE, x: -19.5, y: 0, z: 5.0 }], // 3m away <= 4.1m
    myId: 'p1',
    myTeam: TEAMS.CRIMSON,
    mode: GAME_MODES.FFA,
    dt: 0.05,
    aimAssistEnabled: true,
    autoFireEnabled: true,
    lockTimer: 0,
  });
  assert.equal(panMelee.targetLocked, true);
  assert.equal(panMelee.shouldAutoFire, true);

  // 3. InputManager toggles & applyTouchLookDelta
  const mockInput = Object.create(InputManager.prototype);
  mockInput.baseTouchSensitivity = 0.0054;
  mockInput.touchSensMultiplier = 1.0;
  mockInput.scoped = false;
  mockInput.scopeSensMultiplier = 0.42;
  mockInput.aimAssistSlowdown = 1.0;
  mockInput.autoFireEnabled = true;
  mockInput.aimAssistEnabled = true;
  mockInput.yaw = 0;
  mockInput.pitch = 0;

  assert.equal(mockInput.toggleAutoFire(), false);
  assert.equal(mockInput.autoFireEnabled, false);
  assert.equal(mockInput.toggleAimAssist(), false);
  assert.equal(mockInput.aimAssistEnabled, false);

  mockInput.applyTouchLookDelta(10, -5);
  assert.ok(mockInput.yaw < 0, 'dragging right should decrease yaw');
  assert.ok(mockInput.pitch > 0, 'dragging up should increase pitch');
});

test('P2PCoordinator enforces max 8 players per lobby, fills earliest lobby first, and isolates lobbies', () => {
  const coord = new P2PCoordinator();
  assert.equal(coord.maxPlayersPerLobby, MAX_LOBBY_PLAYERS);
  assert.equal(coord.maxPlayersPerLobby, 8);

  const sockets = [];
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const ws = createRecordingSocket();
    const id = coord.handleJoin(ws, { name: `Player${i + 1}` });
    sockets.push(ws);
    ids.push(id);
  }

  for (let i = 0; i < 8; i++) {
    const role = sockets[i].sent.find((m) => m.t === MSG.P2P_ROLE);
    assert.ok(role);
    assert.equal(role.lobbyId, 'lobby_1');
    assert.equal(role.maxPlayers, 8);
    assert.equal(role.hostId, ids[0]);
    if (i === 0) {
      assert.equal(role.isHost, true);
      assert.ok(typeof role.hostToken === 'string' && role.hostToken.length >= 16);
    } else {
      assert.equal(role.isHost, false);
      assert.equal(role.hostToken, undefined);
    }
  }

  // 9th and 10th players exceed 8-player cap in lobby_1 -> spawn lobby_2 with 9th player as host
  const ws9 = createRecordingSocket();
  const ws10 = createRecordingSocket();
  const p9 = coord.handleJoin(ws9, { name: 'Player9' });
  const p10 = coord.handleJoin(ws10, { name: 'Player10' });

  const role9 = ws9.sent.find((m) => m.t === MSG.P2P_ROLE);
  const role10 = ws10.sent.find((m) => m.t === MSG.P2P_ROLE);
  assert.equal(role9.lobbyId, 'lobby_2');
  assert.equal(role9.isHost, true);
  assert.equal(role9.hostId, p9);
  assert.equal(role10.lobbyId, 'lobby_2');
  assert.equal(role10.isHost, false);
  assert.equal(role10.hostId, p9);

  // lobby_1 peers must not receive lobby_2 joins, checkpoints, or signals
  assert.equal(sockets[0].sent.some((m) => m.t === MSG.P2P_PEER_JOINED && m.peerId === p9), false);

  coord.handleMessage(p9, {
    t: MSG.P2P_CHECKPOINT,
    hostToken: role9.hostToken,
    checkpoint: { seq: 1, players: [{ id: p9 }, { id: p10 }] },
  });
  assert.equal(ws10.sent.some((m) => m.t === MSG.P2P_CHECKPOINT), true);
  assert.equal(sockets[1].sent.some((m) => m.t === MSG.P2P_CHECKPOINT), false);

  coord.handleMessage(p9, {
    t: MSG.P2P_SIGNAL,
    toId: ids[1],
    desc: { type: 'offer', sdp: 'cross' },
  });
  assert.equal(sockets[1].sent.some((m) => m.t === MSG.P2P_SIGNAL && m.fromId === p9), false);

  // When a spot opens in lobby_1 (7/8), a new joiner fills lobby_1 first before lobby_2 (2/8)
  coord.handleDisconnect(ids[7]);
  const ws11 = createRecordingSocket();
  const p11 = coord.handleJoin(ws11, { name: 'Player11' });
  const role11 = ws11.sent.find((m) => m.t === MSG.P2P_ROLE);
  assert.equal(role11.lobbyId, 'lobby_1');
  assert.equal(role11.hostId, ids[0]);
  assert.ok(p11);
});

test('Server authorization and sanitization block Infinity/NaN inputs, relay spoofing, and forged checkpoints', () => {
  // 1. GameRoom input & action finite sanitization
  const room = new GameRoom();
  const wsRoom = createRecordingSocket();
  const player = room.addHumanPlayer(wsRoom, 'FiniteTest');
  player.lastQueuedSeq = 0;

  room.handleClientMessage(player, {
    t: MSG.INPUT,
    ticks: [{ seq: 1, mx: Infinity, mz: -Infinity, y: NaN, p: Infinity }],
  });
  room.stepSimulation(FIXED_DT);
  assert.equal(Number.isFinite(player.x), true);
  assert.equal(Number.isFinite(player.y), true);
  assert.equal(Number.isFinite(player.z), true);
  assert.equal(Number.isFinite(player.yaw), true);
  assert.equal(Number.isFinite(player.pitch), true);

  // Duplicate seq is dropped
  room.handleClientMessage(player, {
    t: MSG.INPUT,
    ticks: [{ seq: 1, mx: 1, mz: 0, y: 0, p: 0 }],
  });
  assert.equal(player.inputQueue.length, 0);

  // Action with Infinity / NaN keeps finite orientation
  room.handleAction(player, { kind: 'primary', yaw: Infinity, pitch: NaN, viewTime: Infinity });
  assert.equal(Number.isFinite(player.yaw), true);
  assert.equal(Number.isFinite(player.pitch), true);

  // 2. P2PCoordinator authorization, relay whitelist, token rotation & checkpoint bounds
  const coord = new P2PCoordinator();
  const ws1 = createRecordingSocket();
  const ws2 = createRecordingSocket();
  const ws3 = createRecordingSocket();
  const p1 = coord.handleJoin(ws1, { name: 'TrueHost' });
  const p2 = coord.handleJoin(ws2, { name: 'GuestReal' });
  const p3 = coord.handleJoin(ws3, { name: 'OtherGuest' });

  const hostRole = ws1.sent.find((m) => m.t === MSG.P2P_ROLE);
  ws1.sent.length = 0;
  ws2.sent.length = 0;
  ws3.sent.length = 0;

  // Guest cannot relay forged SNAPSHOT or WELCOME messages or relay to other guests
  coord.handleMessage(p2, { t: MSG.P2P_RELAY, toId: p3, data: { t: MSG.SNAPSHOT, pl: [] } });
  coord.handleMessage(p2, { t: MSG.P2P_RELAY, data: { t: MSG.WELCOME, id: p2 } });
  assert.equal(ws1.sent.some((m) => m.t === MSG.P2P_RELAY), false);
  assert.equal(ws3.sent.some((m) => m.t === MSG.P2P_RELAY), false);

  // Guest cannot send WebRTC P2P_SIGNAL directly to another non-host guest
  coord.handleMessage(p2, { t: MSG.P2P_SIGNAL, toId: p3, desc: { type: 'offer', sdp: 'x' } });
  assert.equal(ws3.sent.some((m) => m.t === MSG.P2P_SIGNAL), false);

  // Guest or host with wrong hostToken cannot inject checkpoint
  coord.handleMessage(p2, { t: MSG.P2P_CHECKPOINT, checkpoint: { seq: 99, players: [] } });
  coord.handleMessage(p1, { t: MSG.P2P_CHECKPOINT, hostToken: 'bad-token', checkpoint: { seq: 99, players: [] } });
  assert.equal(ws2.sent.some((m) => m.t === MSG.P2P_CHECKPOINT), false);

  // Valid host checkpoint is sanitized: strips forged human IDs, enforces name, clamps stats & bounds
  coord.handleMessage(p1, {
    t: MSG.P2P_CHECKPOINT,
    hostToken: hostRole.hostToken,
    checkpoint: {
      seq: 5,
      players: [
        { id: p1, name: 'TrueHost', hp: 120, maxHp: 120, essence: 100, x: 0, z: 0 },
        { id: p2, name: 'SpoofedName', hp: 999999, maxHp: 120, essence: 999999, x: 500, z: -500 },
        { id: 'fake_human', name: 'Injector', isBot: false, hp: 120 },
      ],
    },
  });

  const cpMsg = ws2.sent.find((m) => m.t === MSG.P2P_CHECKPOINT);
  assert.ok(cpMsg);
  assert.equal(cpMsg.checkpoint.players.some((pl) => pl.id === 'fake_human'), false);
  const cleanP2 = cpMsg.checkpoint.players.find((pl) => pl.id === p2);
  assert.equal(cleanP2.name, 'GuestReal');
  assert.ok(cleanP2.hp <= 10000);
  assert.ok(cleanP2.essence <= 10000);
  assert.ok(cleanP2.x <= ARENA_HALF_SIZE && cleanP2.z >= -ARENA_HALF_SIZE);

  // Host migration sends rotated private hostToken only to newly promoted host p2 (never p3)
  coord.handleDisconnect(p1);
  const mig2 = ws2.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  const mig3 = ws3.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  assert.ok(mig2 && mig3);
  assert.ok(typeof mig2.hostToken === 'string' && mig2.hostToken !== hostRole.hostToken);
  assert.equal(mig3.hostToken, undefined);
});

test('First joiner stays Menu Manager while simulation host smoothly hands over to lowest-latency peer', (t) => {
  const coord = new P2PCoordinator({ hostEvalIntervalMs: 5000 });
  t.after(() => coord.stop());

  const ws1 = createRecordingSocket();
  const ws2 = createRecordingSocket();
  const ws3 = createRecordingSocket();

  const p1 = coord.handleJoin(ws1, { name: 'MenuOwner' });
  const p2 = coord.handleJoin(ws2, { name: 'LowPingHost' });
  const p3 = coord.handleJoin(ws3, { name: 'MidPingGuest' });

  const role1 = ws1.sent.find((m) => m.t === MSG.P2P_ROLE);
  assert.equal(role1.managerId, p1);
  assert.equal(role1.hostId, p1);
  assert.equal(role1.isManager, true);

  coord.handleMessage(p1, {
    t: MSG.P2P_CHECKPOINT,
    hostToken: role1.hostToken,
    checkpoint: {
      seq: 2,
      players: [
        { id: p1, name: 'MenuOwner', essence: 250 },
        { id: p2, name: 'LowPingHost', essence: 175 },
        { id: p3, name: 'MidPingGuest', essence: 175 },
      ],
    },
  });

  // Report latency: p1 has high ping, p2 has ultra-low RTT toward lobby peers
  coord.handleMessage(p1, { t: MSG.P2P_LATENCY, rtt: 190, jitter: 35, fps: 60 });
  coord.handleMessage(p2, { t: MSG.P2P_LATENCY, rtt: 18, jitter: 2, fps: 60, peerRtts: { [p1]: 190, [p3]: 22 } });
  coord.handleMessage(p3, { t: MSG.P2P_LATENCY, rtt: 55, jitter: 6, fps: 60, peerRtts: { [p1]: 210, [p2]: 22 } });

  ws1.sent.length = 0;
  ws2.sent.length = 0;
  ws3.sent.length = 0;

  // Phase 1: Coordinator requests immediate checkpoint prep from current host p1
  const targetId = coord.evaluateLobbyBestHost('lobby_1', { immediate: false, force: true });
  assert.equal(targetId, p2);
  const prepMsg = ws1.sent.find((m) => m.t === MSG.P2P_PREP_MIGRATE);
  assert.ok(prepMsg);
  assert.equal(prepMsg.targetHostId, p2);

  // Phase 2: p1 sends final pre-handover checkpoint -> coordinator seamlessly switches host to p2
  coord.handleMessage(p1, {
    t: MSG.P2P_CHECKPOINT,
    hostToken: role1.hostToken,
    checkpoint: {
      seq: 3,
      players: [
        { id: p1, name: 'MenuOwner', essence: 310 },
        { id: p2, name: 'LowPingHost', essence: 175 },
        { id: p3, name: 'MidPingGuest', essence: 175 },
      ],
    },
  });

  assert.equal(coord.hostId, p2, 'lowest-latency peer p2 must become simulation host');
  assert.equal(coord.managerId, p1, 'first joiner p1 must remain Lobby Menu Manager');

  const mig1 = ws1.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  const mig2 = ws2.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  const mig3 = ws3.sent.find((m) => m.t === MSG.P2P_HOST_MIGRATE);
  assert.ok(mig1 && mig2 && mig3);
  assert.equal(mig2.reason, 'latency');
  assert.equal(mig2.newHostId, p2);
  assert.equal(mig2.managerId, p1);
  assert.ok(typeof mig2.hostToken === 'string' && mig2.hostToken !== role1.hostToken);
  assert.equal(mig1.hostToken, undefined);
  assert.equal(mig3.hostToken, undefined);
  assert.equal(
    mig2.checkpoint.players.find((pl) => pl.id === p1)?.essence,
    310,
    'previous host p1 must stay in checkpoint on latency handover'
  );

  // Verify GameRoom enforces separated Manager permissions after checkpoint restore
  const room = new GameRoom();
  room.importCheckpoint(mig2.checkpoint, () => createRecordingSocket());
  assert.equal(room.hostId, p2);
  assert.equal(room.managerId, p1);

  const rp1 = room.players.get(p1);
  const rp2 = room.players.get(p2);
  assert.equal(room.canManageRoom(rp1), true, 'p1 retains menu control even while p2 hosts simulation');
  assert.equal(room.canManageRoom(rp2), false, 'low-latency simulation host p2 does not steal menu control');

  room.handleClientMessage(rp2, { t: MSG.MATCH_CMD, cmd: 'add_bot' });
  assert.equal(room.bots.size, 0, 'non-manager host cannot add bots');
  room.handleClientMessage(rp1, { t: MSG.MATCH_CMD, cmd: 'add_bot' });
  assert.equal(room.bots.size, 1, 'menu manager p1 can add bots while hosted on p2');

  // Verify NetClient.canManageServer tracks separated managerId independently of isHost
  const netManagerGuest = new NetClient({ url: 'ws://mock' });
  netManagerGuest.playerId = p1;
  netManagerGuest.hostId = p2;
  netManagerGuest.managerId = p1;
  netManagerGuest.isHost = false;
  netManagerGuest.knownPeers.set(p1, { peerId: p1 });
  netManagerGuest.knownPeers.set(p2, { peerId: p2 });
  assert.equal(netManagerGuest.canManageServer(), true);

  const netHostNonManager = new NetClient({ url: 'ws://mock' });
  netHostNonManager.playerId = p2;
  netHostNonManager.hostId = p2;
  netHostNonManager.managerId = p1;
  netHostNonManager.isHost = true;
  netHostNonManager.knownPeers.set(p1, { peerId: p1 });
  netHostNonManager.knownPeers.set(p2, { peerId: p2 });
  assert.equal(netHostNonManager.canManageServer(), false);
});

test('Reconciled shooter origin and multi-sample lag compensation register hits across jitter and peeking', () => {
  const room = new GameRoom();
  const shooter = room.createPlayerEntity('s1', 'Peeker', null, false, TEAMS.CRIMSON);
  const victim = room.createPlayerEntity('v1', 'StrafeTarget', null, false, TEAMS.AZURE);
  room.players.set(shooter.id, shooter);
  room.players.set(victim.id, victim);

  // Shooter server state is 0.35m right of client-predicted peek in unobstructed western lane (x=-19.5, z=8 -> -4)
  shooter.x = -19.15;
  shooter.y = 0;
  shooter.z = 8.0;

  const tShot = room.now - 100;
  // At tShot-24ms target crossed x=-19.5; at tShot target stepped sideways by 0.65m (within 28ms jitter window)
  room.history.push({
    t: tShot - 24,
    positions: new Map([
      ['v1', { x: -19.5, y: 0, z: -4.0 }],
      ['s1', { x: -19.5, y: 0, z: 8.0 }],
    ]),
  });
  room.history.push({
    t: tShot,
    positions: new Map([
      ['v1', { x: -18.85, y: 0, z: -4.0 }],
      ['s1', { x: -19.15, y: 0, z: 8.0 }],
    ]),
  });
  victim.x = -18.4;
  victim.y = 0;
  victim.z = -4.0;
  room.history.push({
    t: room.now,
    positions: new Map([
      ['v1', { x: -18.4, y: 0, z: -4.0 }],
      ['s1', { x: -19.15, y: 0, z: 8.0 }],
    ]),
  });

  const hpBefore = victim.hp;
  room.handleAction(shooter, {
    kind: 'primary',
    yaw: 0,
    pitch: -0.01,
    sx: -19.5,
    sy: 0,
    sz: 8.0,
    viewTime: tShot,
  });
  assert.ok(victim.hp < hpBefore, 'reconciled peek origin + jitter window should reliably register hit');

  // Spoofed sx/sz trying to shoot through solid mid_pillar_3 (minX=8.4..10.6, z=8.4..10.6) must fall back to serverEye
  shooter.x = 7.8;
  shooter.y = 0;
  shooter.z = 9.5;
  const wallBlockedEye = room._resolveReconciledEye(shooter, { sx: 9.0, sy: 0, sz: 9.5 });
  assert.equal(wallBlockedEye.x, 7.8, 'cannot reconcile shooter origin through a solid wall');
});
