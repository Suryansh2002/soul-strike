import { GameRoom } from '../server/GameRoom.js';
import { MSG } from '../shared/protocol.js';

const postToMain = self.postMessage.bind(self);
const setIntervalFn = self.setInterval.bind(self);
const clearIntervalFn = self.clearInterval.bind(self);

for (const target of [Map.prototype, Set.prototype, Array.prototype, JSON, Math]) {
  try {
    Object.freeze(target);
  } catch {}
}

let room = null;
let checkpointTimer = null;
let initialized = false;
let sessionKey = null;
const endpoints = new Map();

function getOrCreateVirtualWs(peerId) {
  let ws = endpoints.get(peerId);
  if (ws) return ws;
  ws = {
    readyState: 1,
    send(raw) {
      postToMain({ evt: 'packet', toId: peerId, fast: false, raw });
    },
    sendFast(raw) {
      postToMain({ evt: 'packet', toId: peerId, fast: true, raw });
    },
  };
  endpoints.set(peerId, ws);
  return ws;
}

function cleanup() {
  if (checkpointTimer) {
    clearIntervalFn(checkpointTimer);
    checkpointTimer = null;
  }
  if (room) {
    room.stop();
    room = null;
  }
  endpoints.clear();
}

function handleMessage(event) {
  const msg = event?.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    if (initialized || room !== null) return;
    initialized = true;
    sessionKey = typeof msg.key === 'string' && msg.key ? msg.key : null;
    cleanup();
    room = new GameRoom();
    if (msg.checkpoint) {
      room.importCheckpoint(msg.checkpoint, (id) => getOrCreateVirtualWs(id));
    } else {
      const botCount = typeof msg.initialBots === 'number' ? msg.initialBots : 0;
      for (let i = 0; i < botCount; i++) {
        room.addBot();
      }
    }
    room.start();
    postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    checkpointTimer = setIntervalFn(() => {
      if (room) {
        postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
      }
    }, 1000);
    return;
  }

  if (!initialized || (sessionKey !== null && msg.key !== sessionKey)) {
    return;
  }

  if (msg.type === 'peer_join') {
    if (!room) return;
    room.attachOrAddHuman(msg.peerId, getOrCreateVirtualWs(msg.peerId), msg.name, msg.team);
    postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    return;
  }

  if (msg.type === 'peer_leave') {
    endpoints.delete(msg.peerId);
    if (room) {
      room.removePlayer(msg.peerId);
      postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
    }
    return;
  }

  if (msg.type === 'client_msg') {
    if (!room) return;
    const player = room.players.get(msg.fromId);
    if (player) {
      room.handleClientMessage(player, msg.data);
      if (msg.data?.t === MSG.BUY || msg.data?.t === MSG.MATCH_CMD) {
        postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint() });
      }
    }
    return;
  }

  if (msg.type === 'export_now') {
    if (room) {
      postToMain({ evt: 'checkpoint', checkpoint: room.exportCheckpoint(), immediate: true });
    }
    return;
  }

  if (msg.type === 'stop') {
    cleanup();
  }
}

const hasAddListener = typeof self.addEventListener === 'function';
if (hasAddListener) {
  self.addEventListener('message', handleMessage);
}
try {
  Object.defineProperty(self, 'onmessage', {
    value: handleMessage,
    writable: false,
    configurable: false,
  });
} catch {
  if (!hasAddListener) {
    self.onmessage = handleMessage;
  }
}
