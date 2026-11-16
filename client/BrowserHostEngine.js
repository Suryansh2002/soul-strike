import { GameRoom } from '../server/GameRoom.js';
import { MSG } from '../shared/protocol.js';

/**
 * Wraps the authoritative GameRoom host simulation inside an ES-module Web Worker
 * when running in the browser, with a clean in-process fallback for headless tests
 * or environments without Worker support.
 */
export class BrowserHostEngine {
  constructor(opts = {}) {
    this.forceInProcess = Boolean(opts.forceInProcess);
    this.worker = null;
    this.room = null;
    this.checkpointTimer = null;
    this.endpoints = new Map();
    this.lastCheckpoint = null;
    this._pendingCheckpointCbs = [];

    this.onSendPacket = null;
    this.onCheckpoint = null;
  }

  _getOrCreateVirtualWs(peerId) {
    let ws = this.endpoints.get(peerId);
    if (ws) return ws;
    ws = {
      readyState: 1,
      send: (raw) => {
        if (this.onSendPacket) this.onSendPacket(peerId, raw, false);
      },
      sendFast: (raw) => {
        if (this.onSendPacket) this.onSendPacket(peerId, raw, true);
      },
    };
    this.endpoints.set(peerId, ws);
    return ws;
  }

  _startInProcess({ checkpoint = null, initialBots = 0 } = {}) {
    this.stop();
    this.room = new GameRoom();
    if (checkpoint) {
      this.room.importCheckpoint(checkpoint, (id) => this._getOrCreateVirtualWs(id));
    } else {
      const botCount = typeof initialBots === 'number' ? initialBots : 0;
      for (let i = 0; i < botCount; i++) {
        this.room.addBot();
      }
    }
    this.room.start();
    this.lastCheckpoint = this.room.exportCheckpoint();
    if (this.onCheckpoint) this.onCheckpoint(this.lastCheckpoint);

    this.checkpointTimer = setInterval(() => {
      if (this.room) {
        this.lastCheckpoint = this.room.exportCheckpoint();
        if (this.onCheckpoint) this.onCheckpoint(this.lastCheckpoint);
      }
    }, 1000);
  }

  start({ checkpoint = null, initialBots = 0 } = {}) {
    this.stop();

    if (!this.forceInProcess && typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(new URL('./hostWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (event) => {
          const msg = event.data;
          if (!msg || typeof msg !== 'object') return;
          if (msg.evt === 'packet') {
            if (this.onSendPacket) this.onSendPacket(msg.toId, msg.raw, Boolean(msg.fast));
          } else if (msg.evt === 'checkpoint') {
            this.lastCheckpoint = msg.checkpoint;
            if (msg.immediate && this._pendingCheckpointCbs.length > 0) {
              const cbs = this._pendingCheckpointCbs.splice(0);
              for (const fn of cbs) fn(msg.checkpoint);
            } else if (this.onCheckpoint) {
              this.onCheckpoint(msg.checkpoint);
            }
          }
        };
        this.worker = worker;
        this.worker.postMessage({ type: 'init', checkpoint, initialBots });
        return;
      } catch {
        this.worker = null;
      }
    }

    this._startInProcess({ checkpoint, initialBots });
  }

  addOrAttachPeer(peerId, name, team) {
    if (this.worker) {
      this.worker.postMessage({ type: 'peer_join', peerId, name, team });
      return;
    }
    if (!this.room) return;
    this.room.attachOrAddHuman(peerId, this._getOrCreateVirtualWs(peerId), name, team);
    this.lastCheckpoint = this.room.exportCheckpoint();
    if (this.onCheckpoint) this.onCheckpoint(this.lastCheckpoint);
  }

  removePeer(peerId) {
    if (this.worker) {
      this.worker.postMessage({ type: 'peer_leave', peerId });
      return;
    }
    this.endpoints.delete(peerId);
    if (!this.room) return;
    this.room.removePlayer(peerId);
    this.lastCheckpoint = this.room.exportCheckpoint();
    if (this.onCheckpoint) this.onCheckpoint(this.lastCheckpoint);
  }

  handleClientMessage(fromId, msgObj) {
    if (this.worker) {
      this.worker.postMessage({ type: 'client_msg', fromId, data: msgObj });
      return;
    }
    if (!this.room) return;
    const player = this.room.players.get(fromId);
    if (player) {
      this.room.handleClientMessage(player, msgObj);
      if (msgObj?.t === MSG.BUY || msgObj?.t === MSG.MATCH_CMD) {
        this.lastCheckpoint = this.room.exportCheckpoint();
        if (this.onCheckpoint) this.onCheckpoint(this.lastCheckpoint);
      }
    }
  }

  exportCheckpointNow() {
    if (this.room) {
      this.lastCheckpoint = this.room.exportCheckpoint();
    }
    return this.lastCheckpoint;
  }

  requestImmediateCheckpoint(cb) {
    if (typeof cb !== 'function') return;
    if (this.worker) {
      this._pendingCheckpointCbs.push(cb);
      this.worker.postMessage({ type: 'export_now' });
      return;
    }
    cb(this.exportCheckpointNow());
  }

  stop() {
    this._pendingCheckpointCbs = [];
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'stop' });
      } catch {}
      try {
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.room) {
      this.room.stop();
      this.room = null;
    }
    this.endpoints.clear();
  }
}
