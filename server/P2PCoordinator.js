import { randomBytes } from 'node:crypto';
import { ARENA_HALF_SIZE } from '../shared/arena.js';
import { GAME_MODES, MAX_LOBBY_PLAYERS } from '../shared/constants.js';
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
]);

function generateToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Lightweight WebRTC signaling, fallback relay, and authorization coordinator.
 * Runs zero game physics on the server; enforces 8-player fill-first lobbies,
 * server-issued host/auth tokens, relay message whitelisting, and checkpoint bounds.
 */
export class P2PCoordinator {
  constructor(opts = {}) {
    this.maxPlayersPerLobby = Math.max(1, Number(opts.maxPlayersPerLobby) || MAX_LOBBY_PLAYERS);
    this.lobbies = new Map();
    this.peers = new Map();
    this.nextLobbyNum = 1;
    this.nextPeerNum = 1;
    this.iceServers = opts.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
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
      hostToken: generateToken(),
      latestCheckpoint: null,
      createdAt: Date.now(),
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

  sanitizeCheckpoint(cp, lobby) {
    if (!cp || typeof cp !== 'object') return null;

    const clean = {
      ...cp,
      hostId: lobby.hostId,
      mode: cp.mode === GAME_MODES.TDM ? GAME_MODES.TDM : GAME_MODES.FFA,
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
    };

    this.peers.set(peerId, peer);
    lobby.peers.set(peerId, peer);

    if (!lobby.hostId || !lobby.peers.has(lobby.hostId)) {
      lobby.hostId = peerId;
      lobby.hostToken = generateToken();
    }

    const isHost = peerId === lobby.hostId;

    this._send(ws, {
      t: MSG.P2P_ROLE,
      peerId,
      lobbyId: lobby.id,
      maxPlayers: this.maxPlayersPerLobby,
      hostId: lobby.hostId,
      isHost,
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

    if (msg.t === MSG.P2P_SIGNAL) {
      const target = lobby.peers.get(msg.toId);
      // Star-topology enforcement: only signals between lobby host and guests in the same lobby
      if (target && (peerId === lobby.hostId || msg.toId === lobby.hostId)) {
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

    if (peerId === lobby.hostId) {
      let newHost = null;
      for (const candidate of lobby.peers.values()) {
        if (!newHost || candidate.joinedAt < newHost.joinedAt) {
          newHost = candidate;
        }
      }
      lobby.hostId = newHost.id;
      lobby.hostToken = generateToken();

      const migratePayload = {
        t: MSG.P2P_HOST_MIGRATE,
        lobbyId: lobby.id,
        newHostId: newHost.id,
        prevHostId: peerId,
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
      });
    }
  }
}
