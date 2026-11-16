import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { P2PCoordinator } from './P2PCoordinator.js';
import { MSG } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PORT = Number(process.env.PORT || 3000);
const MAX_CONNS_PER_IP = 12;
const GUEST_BURST = 90;
const GUEST_REFILL_PER_SEC = 65;
const HOST_BURST = 320;
const HOST_REFILL_PER_SEC = 260;

const gzipCache = new Map();
const connsByIp = new Map();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const coordinator = new P2PCoordinator();

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/health') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        ok: true,
        players: coordinator.peers.size,
        hostId: coordinator.hostId,
        mode: coordinator.getMode(),
        lobbies: coordinator.getLobbySummaries(),
      })
    );
    return;
  }

  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(503, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Client bundle not built yet. Run "npm run build" or "npm start".');
    return;
  }

  const targetRel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let filePath = path.resolve(DIST_DIR, targetRel);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const compressible =
    ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.webmanifest' || ext === '.svg';
  const cacheControl =
    ext === '.html' || ext === '.webmanifest' || urlPath === '/sw.js'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';

  const cached = gzipCache.get(filePath);
  if (cached) {
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    };
    if (acceptsGzip && cached.gz) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(cached.gz);
    } else {
      res.writeHead(200, headers);
      res.end(cached.raw);
    }
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }
    const gz = compressible ? zlib.gzipSync(data) : null;
    gzipCache.set(filePath, { raw: data, gz });
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    };
    if (acceptsGzip && gz) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(gz);
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
  });
});

// Disable Nagle's algorithm for minimal WebSocket latency over tunnels
server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024,
});

server.on('upgrade', (request, socket, head) => {
  socket.setNoDelay(true);
  const urlPath = (request.url || '').split('?')[0];
  if (urlPath !== '/ws') {
    socket.destroy();
    return;
  }

  const ip = getClientIp(request);
  if ((connsByIp.get(ip) || 0) >= MAX_CONNS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, ip);
  });
});

wss.on('connection', (ws, request, clientIp) => {
  const ip = clientIp || getClientIp(request);
  connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);

  let peerId = null;
  let released = false;
  let tokens = GUEST_BURST;
  let lastRefill = Date.now();
  let rateViolations = 0;

  ws.on('message', (raw) => {
    const now = Date.now();
    const isHost = Boolean(peerId && coordinator.isHostPeer(peerId));
    const maxTokens = isHost ? HOST_BURST : GUEST_BURST;
    const refillRate = isHost ? HOST_REFILL_PER_SEC : GUEST_REFILL_PER_SEC;
    const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
    lastRefill = now;
    tokens = Math.min(maxTokens, tokens + elapsedSec * refillRate);

    if (tokens < 1) {
      rateViolations++;
      if (rateViolations >= 15) {
        try {
          ws.close(1008, 'Rate limit exceeded');
        } catch {}
      }
      return;
    }
    tokens -= 1;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!peerId) {
      if (msg.t === MSG.P2P_JOIN || msg.t === MSG.JOIN) {
        peerId = coordinator.handleJoin(ws, msg);
        if (coordinator.isHostPeer(peerId)) {
          tokens = HOST_BURST;
        }
      }
      return;
    }

    coordinator.handleMessage(peerId, msg);
  });

  const onDisconnect = () => {
    if (!released) {
      released = true;
      const count = (connsByIp.get(ip) || 1) - 1;
      if (count <= 0) connsByIp.delete(ip);
      else connsByIp.set(ip, count);
    }
    if (peerId) {
      const id = peerId;
      peerId = null;
      coordinator.handleDisconnect(id);
    }
  };

  ws.on('close', onDisconnect);
  ws.on('error', onDisconnect);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SoulStrike Arena server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket endpoint ready at ws://localhost:${PORT}/ws`);
  console.log(`  To share with friends via Cloudflared:`);
  console.log(`    cloudflared tunnel --url http://localhost:${PORT}\n`);
});
