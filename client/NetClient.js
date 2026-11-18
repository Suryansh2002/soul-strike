import { MSG } from '../shared/protocol.js';
import { clamp, lerp } from '../shared/physics.js';
import { BrowserHostEngine } from './BrowserHostEngine.js';

const ALLOWED_CLIENT_HOST_MSGS = new Set([
  MSG.INPUT,
  MSG.ACTION,
  MSG.BUY,
  MSG.EQUIP_WEAPON,
  MSG.EMOTE,
  MSG.PING,
  MSG.MATCH_CMD,
]);

export class NetClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.ws = null;
    this.connected = false;
    this.playerId = null;
    this.playerName = 'Wanderer';
    this.preferredTeam = null;
    this.preferredMode = null;

    this.isHost = false;
    this.hostId = null;
    this.managerId = null;
    this.lobbyId = null;
    this.authToken = null;
    this.hostToken = null;
    this.fps = 60;
    this.transportMode = 'connecting'; // 'host' | 'p2p-udp' | 'p2p-relay' | 'connecting'
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    this.hostEngine = null;
    this.peerConnections = new Map();
    this.peerRtts = new Map();
    this.knownPeers = new Map();
    this.latestCheckpoint = null;
    this.pendingReliableOutbox = [];

    this.rtt = 0;
    this.jitter = 0;
    this.lastRtt = 0;
    this.serverRtt = 0;
    this.serverJitter = 0;
    this.lastServerRtt = 0;
    this.serverTimeOffset = 0; // estimatedServerTime = performance.now() + serverTimeOffset
    this.hasClockSync = false;

    this.snapshots = [];
    this.pingTimer = null;

    this.onWelcome = null;
    this.onSnapshot = null;
    this.onHitConfirm = null;
    this.onBuyResult = null;
    this.onStatusChange = null;
    this.onHostMigrate = null;
  }

  canManageServer() {
    let humanPeers = 0;
    for (const p of this.knownPeers.values()) {
      if (p && p.peerId) humanPeers++;
    }
    if (this.playerId && humanPeers === 1) return true;
    if (this.managerId) {
      return Boolean(this.playerId && this.playerId === this.managerId);
    }
    if (this.isHost) return true;
    if (this.playerId && this.hostId && this.playerId === this.hostId) return true;
    return Boolean(this.playerId && humanPeers <= 1);
  }

  _sendSignal(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _closePeerConnection(peerId) {
    this.peerRtts.delete(peerId);
    const rec = this.peerConnections.get(peerId);
    if (!rec) return;
    this.peerConnections.delete(peerId);
    try {
      rec.reliableDc?.close();
    } catch {}
    try {
      rec.fastDc?.close();
    } catch {}
    try {
      rec.pc?.close();
    } catch {}
  }

  _closeAllPeerConnections() {
    for (const peerId of [...this.peerConnections.keys()]) {
      this._closePeerConnection(peerId);
    }
  }

  _hasActivePeerConnection(peerId) {
    const rec = this.peerConnections.get(peerId);
    return Boolean(
      rec && rec.pc && rec.pc.connectionState !== 'failed' && rec.pc.connectionState !== 'closed'
    );
  }

  _hasOpenDataChannel(peerId) {
    const rec = this.peerConnections.get(peerId);
    return Boolean(
      rec && (rec.fastDc?.readyState === 'open' || rec.reliableDc?.readyState === 'open')
    );
  }

  _sendToPeerChannel(peerId, obj, fast = true) {
    const rec = this.peerConnections.get(peerId);
    if (!rec) return false;
    const raw = JSON.stringify(obj);
    if (fast && rec.fastDc?.readyState === 'open') {
      try {
        rec.fastDc.send(raw);
        return true;
      } catch {}
    }
    if (rec.reliableDc?.readyState === 'open') {
      try {
        rec.reliableDc.send(raw);
        return true;
      } catch {}
    }
    return false;
  }

  _updateGuestTransportMode() {
    if (this.isHost) {
      this.transportMode = 'host';
      return;
    }
    const rec = this.hostId ? this.peerConnections.get(this.hostId) : null;
    const hasOpenDc =
      rec && (rec.fastDc?.readyState === 'open' || rec.reliableDc?.readyState === 'open');
    this.transportMode = hasOpenDc ? 'p2p-udp' : 'p2p-relay';
  }

  _wireDataChannel(rec, channel, kind) {
    if (kind === 'fast') rec.fastDc = channel;
    else rec.reliableDc = channel;

    channel.onopen = () => {
      rec.isConnected = true;
      this._updateGuestTransportMode();
    };
    channel.onclose = () => {
      this._updateGuestTransportMode();
    };
    channel.onerror = () => {
      this._updateGuestTransportMode();
    };
    channel.onmessage = (ev) => {
      this._onPeerDataMessage(rec.peerId, ev.data);
    };
  }

  _onPeerDataMessage(fromId, rawData) {
    let msg;
    try {
      msg = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === MSG.PEER_PING && typeof msg.c === 'number') {
      this._sendToPeerChannel(fromId, { t: MSG.PEER_PONG, c: msg.c }, true);
      return;
    }

    if (msg.t === MSG.PEER_PONG && typeof msg.c === 'number') {
      const sample = Math.max(1, performance.now() - msg.c);
      const prev = this.peerRtts.get(fromId) || 0;
      this.peerRtts.set(fromId, prev > 0 ? prev * 0.7 + sample * 0.3 : sample);
      return;
    }

    if (this.isHost) {
      if (
        this.hostEngine &&
        fromId !== this.playerId &&
        this.knownPeers.has(fromId) &&
        ALLOWED_CLIENT_HOST_MSGS.has(msg.t)
      ) {
        this.hostEngine.handleClientMessage(fromId, msg);
      }
      return;
    }

    if (fromId === this.hostId) {
      this._handleGameMessage(msg);
    }
  }

  async _initiateWebRtcOffer(peerId) {
    const RTCPeerCtor =
      this.opts.RTCPeerConnectionImpl ||
      (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    if (!RTCPeerCtor || peerId === this.playerId) return;

    this._closePeerConnection(peerId);

    let pc;
    try {
      pc = new RTCPeerCtor({ iceServers: this.iceServers });
    } catch {
      return;
    }

    const rec = {
      peerId,
      pc,
      reliableDc: null,
      fastDc: null,
      remoteDescSet: false,
      pendingCandidates: [],
      isConnected: false,
    };
    this.peerConnections.set(peerId, rec);

    try {
      const reliableDc = pc.createDataChannel('reliable', { ordered: true });
      const fastDc = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
      this._wireDataChannel(rec, reliableDc, 'reliable');
      this._wireDataChannel(rec, fastDc, 'fast');
    } catch {
      this._closePeerConnection(peerId);
      return;
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._sendSignal({ t: MSG.P2P_SIGNAL, toId: peerId, candidate: ev.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._closePeerConnection(peerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      if (this.peerConnections.get(peerId) !== rec) return;
      await pc.setLocalDescription(offer);
      this._sendSignal({
        t: MSG.P2P_SIGNAL,
        toId: peerId,
        desc: pc.localDescription || offer,
      });
    } catch {
      this._closePeerConnection(peerId);
    }
  }

  async _handleWebRtcSignal(msg) {
    const RTCPeerCtor =
      this.opts.RTCPeerConnectionImpl ||
      (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    if (!RTCPeerCtor || !msg.fromId || msg.fromId === this.playerId) return;

    let rec = this.peerConnections.get(msg.fromId);

    if (msg.desc) {
      if (msg.desc.type === 'offer') {
        if (!this.knownPeers.has(msg.fromId) && msg.fromId !== this.hostId) return;
        this._closePeerConnection(msg.fromId);

        let pc;
        try {
          pc = new RTCPeerCtor({ iceServers: this.iceServers });
        } catch {
          return;
        }

        rec = {
          peerId: msg.fromId,
          pc,
          reliableDc: null,
          fastDc: null,
          remoteDescSet: false,
          pendingCandidates: [],
          isConnected: false,
        };
        this.peerConnections.set(msg.fromId, rec);

        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          const kind = ch.label === 'fast' ? 'fast' : 'reliable';
          this._wireDataChannel(rec, ch, kind);
        };
        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            this._sendSignal({ t: MSG.P2P_SIGNAL, toId: msg.fromId, candidate: ev.candidate });
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            this._closePeerConnection(msg.fromId);
            this._updateGuestTransportMode();
          }
        };

        try {
          await pc.setRemoteDescription(msg.desc);
          rec.remoteDescSet = true;
          while (rec.pendingCandidates.length > 0) {
            const c = rec.pendingCandidates.shift();
            await pc.addIceCandidate(c).catch(() => {});
          }
          const answer = await pc.createAnswer();
          if (this.peerConnections.get(msg.fromId) !== rec) return;
          await pc.setLocalDescription(answer);
          this._sendSignal({
            t: MSG.P2P_SIGNAL,
            toId: msg.fromId,
            desc: pc.localDescription || answer,
          });
        } catch {
          this._closePeerConnection(msg.fromId);
          this._updateGuestTransportMode();
        }
        return;
      }

      if (msg.desc.type === 'answer' && rec) {
        try {
          await rec.pc.setRemoteDescription(msg.desc);
          rec.remoteDescSet = true;
          while (rec.pendingCandidates.length > 0) {
            const c = rec.pendingCandidates.shift();
            await rec.pc.addIceCandidate(c).catch(() => {});
          }
        } catch {}
        return;
      }
    }

    if (msg.candidate && rec) {
      if (rec.remoteDescSet) {
        rec.pc.addIceCandidate(msg.candidate).catch(() => {});
      } else {
        rec.pendingCandidates.push(msg.candidate);
      }
    }
  }

  _routeHostPacket(toId, raw, fast) {
    let parsed = null;
    const getParsed = () => {
      if (!parsed) {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
      return parsed;
    };

    if (toId === this.playerId) {
      this._handleGameMessage(getParsed());
      return;
    }

    const rec = this.peerConnections.get(toId);
    const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (fast && rec?.fastDc?.readyState === 'open') {
      try {
        rec.fastDc.send(serialized);
        return;
      } catch {}
    } else if (rec?.reliableDc?.readyState === 'open') {
      try {
        rec.reliableDc.send(serialized);
        return;
      } catch {}
    }

    this._sendSignal({
      t: MSG.P2P_RELAY,
      toId,
      fast: fast ? 1 : 0,
      data: getParsed(),
    });
  }

  _becomeHost(checkpoint = null) {
    if (this.hostEngine) {
      this.hostEngine.stop();
      this.hostEngine = null;
    }
    for (const pid of [...this.peerConnections.keys()]) {
      if (!this.knownPeers.has(pid)) {
        this._closePeerConnection(pid);
        this.peerRtts.delete(pid);
      }
    }

    this.isHost = true;
    this.hostId = this.playerId;
    this.transportMode = 'host';
    this.rtt = 0;
    this.jitter = 0;
    this.lastRtt = 0;
    this.hasClockSync = false;

    const engine = new BrowserHostEngine({ forceInProcess: Boolean(this.opts.forceInProcessHost) });
    engine.onSendPacket = (toId, raw, fast) => this._routeHostPacket(toId, raw, fast);
    engine.onCheckpoint = (cp) => {
      this.latestCheckpoint = cp;
      this._sendSignal({ t: MSG.P2P_CHECKPOINT, hostToken: this.hostToken, checkpoint: cp });
    };

    this.hostEngine = engine;
    engine.start({ checkpoint, initialBots: 0 });

    if (!this.knownPeers.has(this.playerId)) {
      this.knownPeers.set(this.playerId, {
        peerId: this.playerId,
        name: this.playerName,
        team: this.preferredTeam,
      });
    }

    for (const peer of this.knownPeers.values()) {
      engine.addOrAttachPeer(peer.peerId, peer.name, peer.team);
      if (peer.peerId !== this.playerId && !this._hasActivePeerConnection(peer.peerId)) {
        this._initiateWebRtcOffer(peer.peerId);
      }
    }

    this._flushOutbox();
  }

  _flushOutbox() {
    if (!this.playerId || !this.hostId) return;
    while (this.pendingReliableOutbox.length > 0) {
      const m = this.pendingReliableOutbox.shift();
      this.send(m);
    }
  }

  _handleSignalingMessage(msg) {
    if (msg.t === MSG.P2P_ROLE) {
      this.playerId = msg.peerId;
      this.lobbyId = msg.lobbyId || null;
      this.authToken = msg.authToken || null;
      this.hostToken = msg.hostToken || null;
      this.hostId = msg.hostId;
      this.managerId = msg.managerId || msg.hostId || null;
      this.isHost = Boolean(msg.isHost);
      if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
        this.iceServers = msg.iceServers;
      }

      this.knownPeers.clear();
      if (Array.isArray(msg.peers)) {
        for (const p of msg.peers) {
          this.knownPeers.set(p.peerId, p);
        }
      }

      if (msg.checkpoint) {
        this.latestCheckpoint = msg.checkpoint;
      }

      if (this.isHost) {
        this._becomeHost(this.latestCheckpoint);
        if (!msg.checkpoint && this.preferredMode && this.preferredMode !== 'ffa') {
          this.send({ t: MSG.MATCH_CMD, cmd: 'set_mode', mode: this.preferredMode });
        }
      } else {
        this.transportMode = 'p2p-relay';
        this._flushOutbox();
      }
      this.sendPing();
      return;
    }

    if (msg.t === MSG.P2P_PEER_JOINED) {
      this.knownPeers.set(msg.peerId, { peerId: msg.peerId, name: msg.name, team: msg.team });
      if (this.isHost && this.hostEngine && msg.peerId !== this.playerId) {
        this.hostEngine.addOrAttachPeer(msg.peerId, msg.name, msg.team);
      }
      if (msg.peerId !== this.playerId) {
        this._initiateWebRtcOffer(msg.peerId);
      }
      return;
    }

    if (msg.t === MSG.P2P_PEER_LEFT) {
      if (msg.managerId) this.managerId = msg.managerId;
      this.knownPeers.delete(msg.peerId);
      this.peerRtts.delete(msg.peerId);
      this._closePeerConnection(msg.peerId);
      if (this.isHost && this.hostEngine) {
        this.hostEngine.removePeer(msg.peerId);
      }
      return;
    }

    if (msg.t === MSG.P2P_SIGNAL) {
      this._handleWebRtcSignal(msg);
      return;
    }

    if (msg.t === MSG.P2P_RELAY) {
      if (!msg.data || typeof msg.data !== 'object') return;
      if (this.isHost) {
        if (
          this.hostEngine &&
          msg.fromId &&
          msg.fromId !== this.playerId &&
          this.knownPeers.has(msg.fromId) &&
          ALLOWED_CLIENT_HOST_MSGS.has(msg.data.t)
        ) {
          this.hostEngine.handleClientMessage(msg.fromId, msg.data);
        }
      } else if (msg.fromId === this.hostId) {
        this._handleGameMessage(msg.data);
      }
      return;
    }

    if (msg.t === MSG.P2P_CHECKPOINT) {
      if (!this.isHost && msg.checkpoint && typeof msg.checkpoint === 'object') {
        if (!this.latestCheckpoint || (msg.checkpoint.seq || 0) >= (this.latestCheckpoint.seq || 0)) {
          this.latestCheckpoint = msg.checkpoint;
        }
      }
      return;
    }

    if (msg.t === MSG.P2P_PREP_MIGRATE) {
      if (this.isHost && this.hostEngine) {
        this.hostEngine.requestImmediateCheckpoint((cp) => {
          if (cp) {
            this.latestCheckpoint = cp;
            this._sendSignal({ t: MSG.P2P_CHECKPOINT, hostToken: this.hostToken, checkpoint: cp });
          }
        });
      }
      return;
    }

    if (msg.t === MSG.P2P_LATENCY && typeof msg.probeTs === 'number') {
      const sampleServerRtt = Math.max(1, performance.now() - msg.probeTs);
      this.serverJitter = this.lastServerRtt
        ? this.serverJitter * 0.75 + Math.abs(sampleServerRtt - this.lastServerRtt) * 0.25
        : 0;
      this.lastServerRtt = sampleServerRtt;
      this.serverRtt = this.serverRtt ? this.serverRtt * 0.7 + sampleServerRtt * 0.3 : sampleServerRtt;
      return;
    }

    if (msg.t === MSG.P2P_HOST_MIGRATE) {
      const prevHostId = msg.prevHostId || this.hostId;
      this.lobbyId = msg.lobbyId || this.lobbyId;
      this.hostId = msg.newHostId;
      this.managerId = msg.managerId || this.managerId;
      this.hostToken = msg.hostToken || (this.playerId === msg.newHostId ? this.hostToken : null);
      this.rtt = 0;
      this.jitter = 0;
      this.lastRtt = 0;
      this.hasClockSync = false;

      if (Array.isArray(msg.peers)) {
        this.knownPeers.clear();
        for (const p of msg.peers) {
          this.knownPeers.set(p.peerId, p);
        }
      } else if (prevHostId) {
        this.knownPeers.delete(prevHostId);
      }

      if (msg.checkpoint && (!this.latestCheckpoint || (msg.checkpoint.seq || 0) >= (this.latestCheckpoint.seq || 0))) {
        this.latestCheckpoint = msg.checkpoint;
      }
      if (
        this.latestCheckpoint &&
        Array.isArray(this.latestCheckpoint.players) &&
        prevHostId &&
        !this.knownPeers.has(prevHostId)
      ) {
        this.latestCheckpoint = {
          ...this.latestCheckpoint,
          players: this.latestCheckpoint.players.filter((pl) => pl.id !== prevHostId),
        };
      }

      if (prevHostId && prevHostId !== this.playerId && !this.knownPeers.has(prevHostId)) {
        this._closePeerConnection(prevHostId);
        this.peerRtts.delete(prevHostId);
      }
      for (const pid of [...this.peerConnections.keys()]) {
        if (!this.knownPeers.has(pid)) {
          this._closePeerConnection(pid);
          this.peerRtts.delete(pid);
        }
      }

      if (this.playerId === msg.newHostId) {
        this._becomeHost(this.latestCheckpoint);
      } else {
        if (this.hostEngine) {
          this.hostEngine.stop();
          this.hostEngine = null;
        }
        this.isHost = false;
        this._updateGuestTransportMode();
        this.sendPing();
      }

      if (this.onHostMigrate) {
        this.onHostMigrate({
          isHost: this.isHost,
          hostId: this.hostId,
          managerId: this.managerId,
          reason: msg.reason || 'disconnect',
          hostName: msg.hostName || this.hostId,
        });
      }
    }
  }

  _handleGameMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === MSG.PONG) {
      const nowPerf = performance.now();
      const sampleRtt = Math.max(0, nowPerf - msg.c);
      const isSpike = this.hasClockSync && this.rtt > 0 && sampleRtt > this.rtt * 2.4;
      this.jitter = this.lastRtt ? this.jitter * 0.75 + Math.abs(sampleRtt - this.lastRtt) * 0.25 : 0;
      this.lastRtt = sampleRtt;
      this.rtt = this.rtt ? this.rtt * 0.7 + sampleRtt * 0.3 : sampleRtt;
      if (!isSpike) {
        const estOffset = msg.s + sampleRtt * 0.5 - nowPerf;
        this.serverTimeOffset = this.hasClockSync
          ? this.serverTimeOffset * 0.8 + estOffset * 0.2
          : estOffset;
        this.hasClockSync = true;
      }
      return;
    }

    if (msg.t === MSG.WELCOME) {
      this.playerId = msg.id;
      if (msg.hostId) this.hostId = msg.hostId;
      if (msg.managerId) this.managerId = msg.managerId;
      this.serverTimeOffset = msg.serverTime - performance.now();
      this.hasClockSync = true;
      if (this.onWelcome) this.onWelcome(msg);
      return;
    }

    if (msg.t === MSG.HIT_CONFIRM) {
      if (this.onHitConfirm) this.onHitConfirm(msg);
      return;
    }

    if (msg.t === MSG.BUY) {
      if (this.onBuyResult) this.onBuyResult(msg);
      return;
    }

    if (msg.t === MSG.SNAPSHOT) {
      if (msg.hi) this.hostId = msg.hi;
      if (msg.mi) this.managerId = msg.mi;
      const snapOffset = msg.st + this.rtt * 0.5 - performance.now();
      if (!this.hasClockSync) {
        this.serverTimeOffset = snapOffset;
        this.hasClockSync = true;
      }
      while (this.snapshots.length > 0 && this.snapshots[this.snapshots.length - 1].st >= msg.st) {
        this.snapshots.pop();
      }
      this.snapshots.push(msg);
      if (this.snapshots.length > 36) {
        this.snapshots.shift();
      }
      if (this.onSnapshot) this.onSnapshot(msg);
    }
  }

  connect(name, preferredTeam = null, preferredMode = null) {
    this.disconnect();

    this.playerName = String(name || 'Wanderer').slice(0, 16);
    this.preferredTeam = preferredTeam;
    this.preferredMode = preferredMode;
    this.transportMode = 'connecting';

    const WsCtor = this.opts.WebSocketImpl || WebSocket;
    let url = this.opts.url;
    if (!url) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = `${proto}//${window.location.host}/ws`;
    }

    const ws = new WsCtor(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      if (this.onStatusChange) this.onStatusChange(true);
      this._sendSignal({ t: MSG.P2P_JOIN, name: this.playerName, team: preferredTeam });
      this.pingTimer = setInterval(() => this.sendPing(), 900);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t && String(msg.t).startsWith('p2p_')) {
        this._handleSignalingMessage(msg);
      } else {
        this._handleGameMessage(msg);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.hostEngine) {
        this.hostEngine.stop();
        this.hostEngine = null;
      }
      this._closeAllPeerConnections();
      this.isHost = false;
      this.transportMode = 'connecting';
      if (this.onStatusChange) this.onStatusChange(false);
    };
  }

  disconnect() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.hostEngine) {
      this.hostEngine.stop();
      this.hostEngine = null;
    }
    this._closeAllPeerConnections();
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try {
        oldWs.onclose = null;
        oldWs.close();
      } catch {}
    }
    this.connected = false;
    this.isHost = false;
    this.hostId = null;
    this.managerId = null;
    this.lobbyId = null;
    this.authToken = null;
    this.hostToken = null;
    this.playerId = null;
    this.rtt = 0;
    this.jitter = 0;
    this.lastRtt = 0;
    this.serverRtt = 0;
    this.serverJitter = 0;
    this.lastServerRtt = 0;
    this.peerRtts.clear();
    this.knownPeers.clear();
    this.pendingReliableOutbox = [];
  }

  sendPing() {
    if (!this.playerId || !this.hostId) return;
    const now = performance.now();
    for (const peerId of this.knownPeers.keys()) {
      if (peerId !== this.playerId) {
        this._sendToPeerChannel(peerId, { t: MSG.PEER_PING, c: now }, true);
      }
    }

    const latencyReport = {
      t: MSG.P2P_LATENCY,
      probeTs: now,
      fps: Math.round(this.fps || 60),
    };
    if (this.serverRtt > 0 || (!this.isHost && this.rtt > 0)) {
      const rttVal = this.serverRtt > 0 ? this.serverRtt : this.rtt;
      const jitterVal = this.serverRtt > 0 ? this.serverJitter : this.jitter;
      latencyReport.rtt = Math.max(1, Math.round(rttVal));
      latencyReport.jitter = Math.round(jitterVal);
    }

    const peerRtts = {};
    for (const peerId of this.knownPeers.keys()) {
      if (peerId === this.playerId) continue;
      if (!this._hasOpenDataChannel(peerId)) {
        this.peerRtts.delete(peerId);
        continue;
      }
      const measured = this.peerRtts.get(peerId);
      if (measured > 0) {
        peerRtts[peerId] = Math.max(1, Math.round(measured));
      }
    }
    if (!this.isHost && this.transportMode === 'p2p-udp' && this.rtt > 0 && !peerRtts[this.hostId]) {
      peerRtts[this.hostId] = Math.max(1, Math.round(this.rtt));
    }
    latencyReport.peerRtts = peerRtts;

    this._sendSignal(latencyReport);
    this.send({ t: MSG.PING, c: performance.now() });
  }

  send(obj) {
    if (!obj || typeof obj !== 'object') return;
    const isFast = obj.t === MSG.INPUT || obj.t === MSG.PING;

    if (!this.playerId || !this.hostId) {
      if (!isFast) {
        this.pendingReliableOutbox.push(obj);
      }
      return;
    }

    if (this.isHost && this.hostEngine) {
      this.hostEngine.handleClientMessage(this.playerId, obj);
      return;
    }

    const rec = this.peerConnections.get(this.hostId);
    const raw = JSON.stringify(obj);
    if (isFast && rec?.fastDc?.readyState === 'open') {
      try {
        rec.fastDc.send(raw);
        return;
      } catch {}
    } else if (rec?.reliableDc?.readyState === 'open') {
      try {
        rec.reliableDc.send(raw);
        return;
      } catch {}
    }

    this._sendSignal({
      t: MSG.P2P_RELAY,
      toId: this.hostId,
      fast: isFast ? 1 : 0,
      data: obj,
    });
  }

  getEstimatedServerTime() {
    return performance.now() + this.serverTimeOffset;
  }

  getInterpDelayMs() {
    if (this.isHost) return 12;
    if (this.transportMode === 'p2p-udp') {
      return clamp(18 + this.jitter * 1.2, 18, 90);
    }
    return clamp(30 + this.jitter * 1.2, 30, 100);
  }

  getRenderTime() {
    return this.getEstimatedServerTime() - this.getInterpDelayMs();
  }

  /**
   * Returns interpolated remote players & projectiles at renderTime.
   */
  sampleInterpolated(renderTime) {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) {
      const s = this.snapshots[0];
      return { players: s.pl, projectiles: s.pj };
    }

    let snapA = this.snapshots[0];
    let snapB = this.snapshots[this.snapshots.length - 1];

    if (renderTime <= snapA.st) {
      return { players: snapA.pl, projectiles: snapA.pj };
    }
    if (renderTime >= snapB.st) {
      const dtExtra = Math.min(0.04, (renderTime - snapB.st) / 1000);
      const players = snapB.pl.map((p) => ({
        ...p,
        x: p.x + p.vx * dtExtra,
        y: p.y + p.vy * dtExtra,
        z: p.z + p.vz * dtExtra,
      }));
      return { players, projectiles: snapB.pj };
    }

    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].st <= renderTime && this.snapshots[i + 1].st >= renderTime) {
        snapA = this.snapshots[i];
        snapB = this.snapshots[i + 1];
        break;
      }
    }

    const span = Math.max(1, snapB.st - snapA.st);
    const t = clamp((renderTime - snapA.st) / span, 0, 1);

    const mapA = new Map();
    for (const p of snapA.pl) mapA.set(p.id, p);

    const players = snapB.pl.map((pb) => {
      const pa = mapA.get(pb.id);
      if (!pa || !pa.al || !pb.al) return pb;
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) > 4.5) return pb;

      return {
        ...pb,
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t),
        z: lerp(pa.z, pb.z, t),
        yw: lerpAngle(pa.yw, pb.yw, t),
        pt: lerp(pa.pt, pb.pt, t),
      };
    });

    const projA = new Map();
    for (const pr of snapA.pj) projA.set(pr.id, pr);
    const projectiles = snapB.pj.map((prB) => {
      const prA = projA.get(prB.id);
      if (!prA) return prB;
      return {
        ...prB,
        x: lerp(prA.x, prB.x, t),
        y: lerp(prA.y, prB.y, t),
        z: lerp(prA.z, prB.z, t),
        ...(typeof prB.sc === 'number'
          ? { sc: lerp(typeof prA.sc === 'number' ? prA.sc : prB.sc, prB.sc, t) }
          : {}),
      };
    });

    return { players, projectiles };
  }
}

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
