import { randomBytes } from 'node:crypto';
import { ARENA_HALF_SIZE } from '../shared/arena.js';
import { GAME_MODES, HOST_EVAL_INTERVAL_MS, MAX_LOBBY_PLAYERS, SPAWN_SHIELD_DURATION, normalizeBotDifficulty } from '../shared/constants.js';
import { clamp, finiteNum } from '../shared/physics.js';
import { MSG } from '../shared/protocol.js';

const ALLOWED_GUEST_MSG_TYPES = new Set([
  MSG.INPUT,
  MSG.ACTION,
  MSG.BUY,
  MSG.EQUIP_WEAPON,
  MSG.EMOTE,
  MSG.PING,
  MSG.JOIN,
  MSG.MATCH_CMD,
  MSG.P2P_LATENCY,
]);

function generateToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Lightweight WebRTC signaling, fallback relay, and authorization coordinator.
 * Runs zero game physics on the server; enforces 8-player fill-first lobbies,
 * separated menu manager (1st joiner) vs lowest-latency dynamic simulation host
 * (re-evaluated every 5s with two-phase handover), relay whitelisting, and checkpoint bounds.
 */
export class P2PCoordinator {
  constructor(opts = {}) {
    this.maxPlayersPerLobby = Math.max(1, Number(opts.maxPlayersPerLobby) || MAX_LOBBY_PLAYERS);
    this.lobbies = new Map();
    this.peers = new Map();
    this.nextLobbyNum = 1;
    this.nextPeerNum = 1;
    this.iceServers = opts.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];

    this.hostEvalIntervalMs = opts.hostEvalIntervalMs ?? HOST_EVAL_INTERVAL_MS;
    this.hostEvalTimer = null;
    if (this.hostEvalIntervalMs > 0) {
      this.hostEvalTimer = setInterval(() => {
        this.evaluateAllLobbiesForBestHost();
      }, this.hostEvalIntervalMs);
      this.hostEvalTimer.unref?.();
    }
  }

  stop() {
    if (this.hostEvalTimer) {
      clearInterval(this.hostEvalTimer);
      this.hostEvalTimer = null;
    }
    for (const lobby of this.lobbies.values()) {
      if (lobby.handoverTimer) {
        clearTimeout(lobby.handoverTimer);
        lobby.handoverTimer = null;
      }
      lobby.pendingHandoverTargetId = null;
      lobby.challengerHostId = null;
      lobby.challengerStreak = 0;
    }
  }

  _getPrimaryLobby() {
    for (const lobby of this.lobbies.values()) return lobby;
    return null;
  }

  get hostId() {
    return this._getPrimaryLobby()?.hostId || null;
  }

  set hostId(val) {
    const primary = this._getPrimaryLobby();
    if (primary) primary.hostId = val;
  }

  get managerId() {
    return this._getPrimaryLobby()?.managerId || null;
  }

  set managerId(val) {
    const primary = this._getPrimaryLobby();
    if (primary) primary.managerId = val;
  }

  get latestCheckpoint() {
    return this._getPrimaryLobby()?.latestCheckpoint || null;
  }

  set latestCheckpoint(val) {
    const primary = this._getPrimaryLobby();
    if (primary) primary.latestCheckpoint = val;
  }

  getMode() {
    return this._getPrimaryLobby()?.latestCheckpoint?.mode || GAME_MODES.FFA;
  }

  isHostPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    return this.lobbies.get(peer.lobbyId)?.hostId === peerId;
  }

  getLobbySummaries() {
    const summaries = [];
    for (const lobby of this.lobbies.values()) {
      summaries.push({
        lobbyId: lobby.id,
        players: lobby.peers.size,
        maxPlayers: this.maxPlayersPerLobby,
        hostId: lobby.hostId,
        managerId: lobby.managerId,
        mode: lobby.latestCheckpoint?.mode || GAME_MODES.FFA,
      });
    }
    return summaries;
  }

  getPeerList(lobby = null) {
    const source = lobby ? lobby.peers.values() : this.peers.values();
    const list = [];
    for (const p of source) {
      list.push({ peerId: p.id, name: p.name, team: p.team });
    }
    return list;
  }

  _findOrCreateLobby() {
    // Fill earliest non-full lobby first before spawning a new lobby
    for (const lobby of this.lobbies.values()) {
      if (lobby.peers.size < this.maxPlayersPerLobby) {
        return lobby;
      }
    }
    const lobbyId = `lobby_${this.nextLobbyNum++}`;
    const lobby = {
      id: lobbyId,
      peers: new Map(),
      hostId: null,
      managerId: null,
      hostToken: generateToken(),
      latestCheckpoint: null,
      createdAt: Date.now(),
      lastHostSwitchAt: 0,
      latencySwitchCount: 0,
      challengerHostId: null,
      challengerStreak: 0,
      pendingHandoverTargetId: null,
      handoverTimer: null,
    };
    this.lobbies.set(lobbyId, lobby);
    return lobby;
  }

  _send(ws, payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
  }

  _broadcastToLobby(lobby, payload, exceptId = null) {
    if (!lobby) return;
    const raw = JSON.stringify(payload);
    for (const [id, peer] of lobby.peers.entries()) {
      if (id === exceptId) continue;
      if (peer.ws && peer.ws.readyState === 1) {
        peer.ws.send(raw);
      }
    }
  }

  _getPairwiseRtt(candidate, otherPeer) {
    const d1 = candidate.peerRtts?.[otherPeer.id];
    const d2 = otherPeer.peerRtts?.[candidate.id];
    if (d1 > 0 && d2 > 0) return (d1 + d2) * 0.5;
    if (d1 > 0) return d1;
    if (d2 > 0) return d2;
    if (candidate.rtt > 0 && otherPeer.rtt > 0) return candidate.rtt + otherPeer.rtt;
    if (candidate.rtt > 0) return candidate.rtt * 2;
    if (otherPeer.rtt > 0) return otherPeer.rtt * 2;
    return null;
  }

  computePeerLatencyScore(lobby, candidate) {
    if (!lobby || !candidate) return null;
    const hasDirectPeers = Boolean(candidate.peerRtts && Object.keys(candidate.peerRtts).length > 0);
    if ((candidate.rtt === null || candidate.rtt <= 0) && !hasDirectPeers) return null;

    const jitterCost = finiteNum(candidate.jitter, 0) * 1.5;
    const fpsPenalty = candidate.fps < 30 ? 60 : 0;

    const pairRtts = [];
    for (const other of lobby.peers.values()) {
      if (other.id === candidate.id) continue;
      const rtt = this._getPairwiseRtt(candidate, other);
      if (rtt !== null && rtt > 0) {
        pairRtts.push(rtt);
      }
    }

    if (pairRtts.length === 0) {
      if (candidate.rtt === null || candidate.rtt <= 0) return null;
      return candidate.rtt + jitterCost + fpsPenalty;
    }

    const meanPeerRtt = pairRtts.reduce((sum, v) => sum + v, 0) / pairRtts.length;
    const maxPeerRtt = Math.max(...pairRtts);
    const roomRttCost = meanPeerRtt * 0.8 + maxPeerRtt * 0.2;
    const serverTieBreaker = (typeof candidate.rtt === 'number' && candidate.rtt > 0 ? candidate.rtt : meanPeerRtt) * 0.1;

    return roomRttCost + jitterCost + fpsPenalty + serverTieBreaker;
  }

  _pickBestHostCandidate(lobby) {
    let bestPeer = null;
    let bestScore = Infinity;

    for (const candidate of lobby.peers.values()) {
      const score = this.computePeerLatencyScore(lobby, candidate);
      if (score !== null && score < bestScore) {
        bestScore = score;
        bestPeer = candidate;
      }
    }
    if (bestPeer) return bestPeer;

    for (const candidate of lobby.peers.values()) {
      if (!bestPeer || candidate.joinedAt < bestPeer.joinedAt) {
        bestPeer = candidate;
      }
    }
    return bestPeer;
  }

  evaluateAllLobbiesForBestHost() {
    for (const lobby of this.lobbies.values()) {
      this.evaluateLobbyBestHost(lobby);
    }
  }

  evaluateLobbyBestHost(lobbyOrId, { immediate = false, force = false } = {}) {
    const lobby = typeof lobbyOrId === 'string' ? this.lobbies.get(lobbyOrId) : lobbyOrId;
    if (!lobby || lobby.peers.size < 2) return null;
    if (lobby.pendingHandoverTargetId) return null;

    const hasElectedBefore = (lobby.latencySwitchCount || 0) > 0;
    const minCooldownMs = hasElectedBefore ? 30000 : 15000;
    if (!force && Date.now() - (lobby.lastHostSwitchAt || 0) < minCooldownMs) return null;

    let bestPeer = null;
    let bestScore = Infinity;
    for (const peer of lobby.peers.values()) {
      const score = this.computePeerLatencyScore(lobby, peer);
      if (score !== null && score < bestScore) {
        bestScore = score;
        bestPeer = peer;
      }
    }
    if (!bestPeer || bestPeer.id === lobby.hostId) {
      lobby.challengerHostId = null;
      lobby.challengerStreak = 0;
      return null;
    }

    const currentHost = lobby.peers.get(lobby.hostId);
    const currentScore = currentHost ? this.computePeerLatencyScore(lobby, currentHost) : null;
    if (currentScore === null && !force) return null;

    const minAbsDelta = !force && hasElectedBefore ? 40 : 25;
    const maxRatio = !force && hasElectedBefore ? 0.70 : 0.78;
    if (currentScore !== null && !(bestScore + minAbsDelta < currentScore && bestScore < currentScore * maxRatio)) {
      lobby.challengerHostId = null;
      lobby.challengerStreak = 0;
      return null;
    }

    if (!force) {
      if (lobby.challengerHostId === bestPeer.id) {
        lobby.challengerStreak = (lobby.challengerStreak || 0) + 1;
      } else {
        lobby.challengerHostId = bestPeer.id;
        lobby.challengerStreak = 1;
      }
      const requiredStreak = hasElectedBefore ? 3 : 2;
      if (lobby.challengerStreak < requiredStreak) {
        return null;
      }
    }

    if (immediate || !currentHost?.ws) {
      this._switchLobbyHost(lobby, bestPeer.id, 'latency');
      return bestPeer.id;
    }

    lobby.pendingHandoverTargetId = bestPeer.id;
    this._send(currentHost.ws, {
      t: MSG.P2P_PREP_MIGRATE,
      lobbyId: lobby.id,
      targetHostId: bestPeer.id,
    });

    lobby.handoverTimer = setTimeout(() => {
      lobby.handoverTimer = null;
      if (lobby.pendingHandoverTargetId === bestPeer.id) {
        lobby.pendingHandoverTargetId = null;
        this._switchLobbyHost(lobby, bestPeer.id, 'latency');
      }
    }, 200);
    lobby.handoverTimer.unref?.();

    return bestPeer.id;
  }

  _switchLobbyHost(lobby, newHostId, reason = 'latency') {
    if (!lobby || !lobby.peers.has(newHostId) || lobby.hostId === newHostId) return false;
    if (lobby.handoverTimer) {
      clearTimeout(lobby.handoverTimer);
      lobby.handoverTimer = null;
    }
    lobby.pendingHandoverTargetId = null;
    lobby.challengerHostId = null;
    lobby.challengerStreak = 0;

    const prevHostId = lobby.hostId;
    const newHost = lobby.peers.get(newHostId);
    lobby.hostId = newHostId;
    lobby.hostToken = generateToken();
    lobby.lastHostSwitchAt = Date.now();
    if (reason === 'latency') {
      lobby.latencySwitchCount = (lobby.latencySwitchCount || 0) + 1;
    }

    if (lobby.latestCheckpoint && typeof lobby.latestCheckpoint === 'object') {
      lobby.latestCheckpoint = {
        ...lobby.latestCheckpoint,
        hostId: newHostId,
        managerId: lobby.managerId,
      };
    }

    const migratePayload = {
      t: MSG.P2P_HOST_MIGRATE,
      reason,
      lobbyId: lobby.id,
      newHostId: newHost.id,
      prevHostId,
      managerId: lobby.managerId,
      hostName: newHost.name,
      peers: this.getPeerList(lobby),
      checkpoint: lobby.latestCheckpoint,
    };

    this._send(newHost.ws, {
      ...migratePayload,
      hostToken: lobby.hostToken,
    });
    this._broadcastToLobby(lobby, migratePayload, newHost.id);
    return true;
  }

  sanitizeCheckpoint(cp, lobby) {
    if (!cp || typeof cp !== 'object') return null;

    const clean = {
      ...cp,
      hostId: lobby.hostId,
      managerId: lobby.managerId,
      mode: cp.mode === GAME_MODES.TDM ? GAME_MODES.TDM : GAME_MODES.FFA,
      botDifficulty: normalizeBotDifficulty(cp.botDifficulty),
    };

    if (Array.isArray(cp.players)) {
      const sanitizedPlayers = [];
      let botCount = 0;
      const maxTotal = this.maxPlayersPerLobby + 8;

      for (const pl of cp.players) {
        if (!pl || typeof pl !== 'object' || !pl.id) continue;
        if (sanitizedPlayers.length >= maxTotal) break;

        const isBot = Boolean(pl.isBot);
        if (isBot) {
          if (botCount >= 8) continue;
          botCount++;
        } else if (!lobby.peers.has(pl.id)) {
          // Strip unverified/forged human IDs not connected to this lobby
          continue;
        }

        const copy = { ...pl };
        if (!isBot) {
          const authPeer = lobby.peers.get(pl.id);
          copy.name = authPeer.name;
        }
        if (copy.x !== undefined) copy.x = clamp(finiteNum(copy.x, 0), -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
        if (copy.z !== undefined) copy.z = clamp(finiteNum(copy.z, 0), -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
        if (copy.y !== undefined) copy.y = clamp(finiteNum(copy.y, 0.1), -2, 20);
        if (copy.hp !== undefined) copy.hp = clamp(finiteNum(copy.hp, 0), 0, 10000);
        if (copy.maxHp !== undefined) copy.maxHp = clamp(finiteNum(copy.maxHp, 120), 1, 10000);
        if (copy.mana !== undefined) copy.mana = clamp(finiteNum(copy.mana, 0), 0, 10000);
        if (copy.stamina !== undefined) copy.stamina = clamp(finiteNum(copy.stamina, 0), 0, 10000);
        if (copy.essence !== undefined) copy.essence = clamp(finiteNum(copy.essence, 0), 0, 10000);
        if (copy.spawnShieldTimer !== undefined) {
          copy.spawnShieldTimer = clamp(finiteNum(copy.spawnShieldTimer, 0), 0, SPAWN_SHIELD_DURATION);
        }
        sanitizedPlayers.push(copy);
      }

      clean.players = sanitizedPlayers;
    }

    if (Array.isArray(cp.projectiles)) {
      clean.projectiles = cp.projectiles.slice(0, 64);
    }

    if (Array.isArray(cp.meteors)) {
      clean.meteors = cp.meteors.slice(0, 16);
    }

    return clean;
  }

  handleJoin(ws, msg = {}) {
    const lobby = this._findOrCreateLobby();
    const peerId = `p${this.nextPeerNum++}`;
    const rawName = String(msg.name || 'Wanderer').trim().slice(0, 16);
    const peer = {
      id: peerId,
      lobbyId: lobby.id,
      name: rawName || 'Wanderer',
      team: msg.team ?? null,
      authToken: generateToken(),
      ws,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      rtt: null,
      jitter: 0,
      peerRtts: {},
      fps: 60,
      lastLatencyAt: 0,
    };

    this.peers.set(peerId, peer);
    lobby.peers.set(peerId, peer);
    lobby.challengerHostId = null;
    lobby.challengerStreak = 0;

    if (!lobby.managerId || !lobby.peers.has(lobby.managerId)) {
      lobby.managerId = peerId;
    }

    if (!lobby.hostId || !lobby.peers.has(lobby.hostId)) {
      lobby.hostId = peerId;
      lobby.hostToken = generateToken();
    }

    const isHost = peerId === lobby.hostId;
    const isManager = peerId === lobby.managerId;

    this._send(ws, {
      t: MSG.P2P_ROLE,
      peerId,
      lobbyId: lobby.id,
      maxPlayers: this.maxPlayersPerLobby,
      hostId: lobby.hostId,
      managerId: lobby.managerId,
      isHost,
      isManager,
      authToken: peer.authToken,
      ...(isHost ? { hostToken: lobby.hostToken } : {}),
      peers: this.getPeerList(lobby),
      checkpoint: lobby.latestCheckpoint,
      iceServers: this.iceServers,
    });

    this._broadcastToLobby(
      lobby,
      {
        t: MSG.P2P_PEER_JOINED,
        peerId,
        lobbyId: lobby.id,
        name: peer.name,
        team: peer.team,
      },
      peerId
    );

    return peerId;
  }

  handleMessage(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (!peer || !msg || typeof msg !== 'object') return;
    const lobby = this.lobbies.get(peer.lobbyId);
    if (!lobby) return;

    peer.lastSeenAt = Date.now();

    if (msg.t === MSG.P2P_LATENCY) {
      if (typeof msg.probeTs === 'number' && Number.isFinite(msg.probeTs)) {
        this._send(peer.ws, {
          t: MSG.P2P_LATENCY,
          probeTs: msg.probeTs,
        });
      }
      const hadSample = peer.lastLatencyAt > 0;
      const parsedRtt = finiteNum(msg.rtt, 0);
      if (parsedRtt > 0) {
        const clampedRtt = clamp(parsedRtt, 1, 2000);
        peer.rtt = peer.rtt !== null && peer.rtt > 0 ? peer.rtt * 0.65 + clampedRtt * 0.35 : clampedRtt;
      }
      if (msg.jitter !== undefined && msg.jitter !== null) {
        const clampedJitter = clamp(finiteNum(msg.jitter, 0), 0, 1000);
        peer.jitter = hadSample ? peer.jitter * 0.65 + clampedJitter * 0.35 : clampedJitter;
      }
      if (msg.fps !== undefined && msg.fps !== null) {
        const clampedFps = clamp(finiteNum(msg.fps, 60), 1, 360);
        peer.fps = hadSample ? peer.fps * 0.65 + clampedFps * 0.35 : clampedFps;
      }
      peer.lastLatencyAt = Date.now();
      if (msg.peerRtts && typeof msg.peerRtts === 'object') {
        const nextPeerRtts = {};
        for (const [targetId, rttVal] of Object.entries(msg.peerRtts)) {
          if (targetId !== peerId && lobby.peers.has(targetId)) {
            const sample = clamp(finiteNum(rttVal, 60), 1, 2000);
            const prev = peer.peerRtts?.[targetId];
            nextPeerRtts[targetId] = prev > 0 ? prev * 0.65 + sample * 0.35 : sample;
          }
        }
        peer.peerRtts = nextPeerRtts;
      }
      return;
    }

    if (msg.t === MSG.P2P_SIGNAL) {
      const target = lobby.peers.get(msg.toId);
      // Mesh WebRTC signaling within the same lobby so all room peers can measure direct P2P RTT
      if (target && msg.toId !== peerId) {
        this._send(target.ws, {
          t: MSG.P2P_SIGNAL,
          fromId: peerId,
          toId: msg.toId,
          desc: msg.desc,
          candidate: msg.candidate,
        });
      }
      return;
    }

    if (msg.t === MSG.P2P_RELAY) {
      if (!msg.data || typeof msg.data !== 'object') return;
      if (peerId !== lobby.hostId) {
        if (!ALLOWED_GUEST_MSG_TYPES.has(msg.data.t)) return;
        const targetId = lobby.hostId;
        const target = lobby.peers.get(targetId);
        if (target) {
          this._send(target.ws, {
            t: MSG.P2P_RELAY,
            fromId: peerId,
            toId: targetId,
            fast: Boolean(msg.fast),
            data: msg.data,
          });
        }
      } else {
        if (!msg.toId || msg.toId === peerId) return;
        const target = lobby.peers.get(msg.toId);
        if (target) {
          this._send(target.ws, {
            t: MSG.P2P_RELAY,
            fromId: peerId,
            toId: msg.toId,
            fast: Boolean(msg.fast),
            data: msg.data,
          });
        }
      }
      return;
    }

    if (msg.t === MSG.P2P_CHECKPOINT) {
      if (peerId !== lobby.hostId) return;
      if (msg.hostToken !== undefined && msg.hostToken !== lobby.hostToken) return;
      const sanitized = this.sanitizeCheckpoint(msg.checkpoint, lobby);
      if (!sanitized) return;
      lobby.latestCheckpoint = sanitized;

      if (lobby.pendingHandoverTargetId && lobby.peers.has(lobby.pendingHandoverTargetId)) {
        const nextHostId = lobby.pendingHandoverTargetId;
        this._switchLobbyHost(lobby, nextHostId, 'latency');
        return;
      }

      this._broadcastToLobby(
        lobby,
        {
          t: MSG.P2P_CHECKPOINT,
          hostId: peerId,
          checkpoint: sanitized,
        },
        peerId
      );
    }
  }

  handleDisconnect(peerId) {
    if (!peerId || !this.peers.has(peerId)) return;
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);

    const lobby = this.lobbies.get(peer.lobbyId);
    if (!lobby) return;
    lobby.peers.delete(peerId);
    lobby.challengerHostId = null;
    lobby.challengerStreak = 0;
    for (const p of lobby.peers.values()) {
      if (p.peerRtts) delete p.peerRtts[peerId];
    }

    if (lobby.pendingHandoverTargetId === peerId || lobby.hostId === peerId) {
      if (lobby.handoverTimer) {
        clearTimeout(lobby.handoverTimer);
        lobby.handoverTimer = null;
      }
      lobby.pendingHandoverTargetId = null;
    }

    if (lobby.latestCheckpoint && Array.isArray(lobby.latestCheckpoint.players)) {
      lobby.latestCheckpoint = {
        ...lobby.latestCheckpoint,
        players: lobby.latestCheckpoint.players.filter((pl) => pl.id !== peerId),
      };
    }

    if (lobby.peers.size === 0) {
      this.lobbies.delete(lobby.id);
      if (this.peers.size === 0) {
        this.nextPeerNum = 1;
        this.nextLobbyNum = 1;
      }
      return;
    }

    if (peerId === lobby.managerId) {
      let newManager = null;
      for (const candidate of lobby.peers.values()) {
        if (!newManager || candidate.joinedAt < newManager.joinedAt) {
          newManager = candidate;
        }
      }
      lobby.managerId = newManager.id;
    }

    if (peerId === lobby.hostId) {
      const newHost = this._pickBestHostCandidate(lobby);
      lobby.hostId = newHost.id;
      lobby.hostToken = generateToken();
      lobby.lastHostSwitchAt = Date.now();

      if (lobby.latestCheckpoint && typeof lobby.latestCheckpoint === 'object') {
        lobby.latestCheckpoint = {
          ...lobby.latestCheckpoint,
          hostId: newHost.id,
          managerId: lobby.managerId,
        };
      }

      const migratePayload = {
        t: MSG.P2P_HOST_MIGRATE,
        reason: 'disconnect',
        lobbyId: lobby.id,
        newHostId: newHost.id,
        prevHostId: peerId,
        managerId: lobby.managerId,
        hostName: newHost.name,
        peers: this.getPeerList(lobby),
        checkpoint: lobby.latestCheckpoint,
      };

      // Deliver private hostToken only to the newly elected host
      this._send(newHost.ws, {
        ...migratePayload,
        hostToken: lobby.hostToken,
      });
      this._broadcastToLobby(lobby, migratePayload, newHost.id);
    } else {
      this._broadcastToLobby(lobby, {
        t: MSG.P2P_PEER_LEFT,
        lobbyId: lobby.id,
        peerId,
        managerId: lobby.managerId,
      });
    }
  }
}
