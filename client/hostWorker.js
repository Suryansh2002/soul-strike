import { GameRoom } from '../server/GameRoom.js';
import { MSG } from '../shared/protocol.js';

let room = null;
let checkpointTimer = null;
const endpoints = new Map();

function getOrCreateVirtualWs(peerId) {
  let ws = endpoints.get(peerId);
  if (ws) return ws;
  ws = {
    readyState: 1,
    send(raw) {
      self.postMessage({ evt: 'packet', toId: peerId, fast: false, raw });
    },
    sendFast(raw) {
      self.postMessage({ evt: 'packet', toId: peerId, fast: true, raw });
    },
  };
  endpoints.set(peerId, ws);
  return ws;
}

function cleanup() {
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  if (room) {
    room.stop();
    room = null;
  }
  endpoints.clear();
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    cleanup();
    room = new GameRoom();
    if (msg.checkpoint) {
      room.importCheckpoint(msg.checkpoint, (id) => getOrCreateVirtualWs(id));
    } else {
      const botCount = typeof msg.initialBots === 'number' ? msg.initialBots : 2;
      for (let i = 0; i < botCount; i++) {
        room.addBot();
      }
    }
    room.start();
    self.postMessage({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    checkpointTimer = setInterval(() => {
      if (room) {
        self.postMessage({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
      }
    }, 1000);
    return;
  }

  if (msg.type === 'peer_join') {
    if (!room) return;
    room.attachOrAddHuman(msg.peerId, getOrCreateVirtualWs(msg.peerId), msg.name, msg.team);
    self.postMessage({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    return;
  }

  if (msg.type === 'peer_leave') {
    endpoints.delete(msg.peerId);
    if (room) {
      room.removePlayer(msg.peerId);
      self.postMessage({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    }
    return;
  }

  if (msg.type === 'client_msg') {
    if (!room) return;
    const player = room.players.get(msg.fromId);
    if (player) {
      room.handleClientMessage(player, msg.data);
      if (msg.data?.t === MSG.BUY || msg.data?.t === MSG.MATCH_CMD) {
        self.postMessage({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
      }
    }
    return;
  }

  if (msg.type === 'stop') {
    cleanup();
  }
};
