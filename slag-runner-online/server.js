/* Slag Runner online server. No dependencies: plain Node 18+.
   - serves the game (public/index.html)
   - relays co-op rooms over WebSocket (/ws?room=NAME), up to 4 players per room */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MAX_MSG = 16 * 1024;          // bytes per message
const RATE = 120, BURST = 240;      // messages per second per player (token bucket)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const indexRaw = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const indexGz = zlib.gzipSync(indexRaw, { level: 9 });
const etag = '"' + crypto.createHash('sha1').update(indexRaw).digest('hex').slice(0, 16) + '"';

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', etag, 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
    });
    return res.end(gz ? indexGz : indexRaw);
  }
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});

/* ---------- minimal RFC 6455 WebSocket ---------- */
function frame(op, data) {
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, p]);
}

const rooms = new Map();   // name -> Map(id -> client)
let nextId = 1;

function send(c, obj, droppable) {
  if (c.dead) return;
  if (droppable && c.sock.writableLength > 512 * 1024) return;   // slow client: skip stale presence
  try { c.sock.write(frame(1, JSON.stringify(obj))); } catch (_) { kill(c); }
}
function kill(c, code) {
  if (c.dead) return;
  c.dead = true;
  try { if (code) c.sock.write(frame(8, Buffer.from([code >> 8, code & 255]))); } catch (_) {}
  try { c.sock.destroy(); } catch (_) {}
  const room = rooms.get(c.room);
  if (room && room.get(c.id) === c) {
    room.delete(c.id);
    if (!room.size) rooms.delete(c.room);
    else for (const o of room.values()) send(o, { t: 'l', id: c.id });
  }
}

function onMessage(c, text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { return; }
  if (!m || typeof m !== 'object') return;
  const room = rooms.get(c.room);
  if (!room) return;
  if (m.t === 'p') {
    if (!m.d || typeof m.d !== 'object') return;
    c.presence = m.d;
    for (const o of room.values()) if (o !== c) send(o, { t: 'p', id: c.id, d: m.d }, true);
  } else if (m.t === 'e') {
    if (typeof m.k !== 'string' || !/^[a-z0-9]{1,16}$/i.test(m.k)) return;
    for (const o of room.values()) if (o !== c) send(o, { t: 'e', id: c.id, k: m.k, d: m.d });
  }
}

function onData(c, chunk) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 128), op = b[0] & 15, masked = !!(b[1] & 128);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return kill(c, 1009); len = b.readUInt32BE(6); off = 10; }
    if (!masked || len > MAX_MSG) return kill(c, masked ? 1009 : 1002);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);

    if (op === 8) return kill(c, 1000);
    if (op === 9) { try { c.sock.write(frame(10, data)); } catch (_) {} continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      if (op === 1) c.frag = [];
      if (!c.frag) return kill(c, 1002);
      c.frag.push(data);
      if (c.frag.reduce((a, x) => a + x.length, 0) > MAX_MSG) return kill(c, 1009);
      if (fin) {
        const text = Buffer.concat(c.frag).toString('utf8'); c.frag = null;
        const now = Date.now();
        c.tok = Math.min(BURST, c.tok + (now - c.tokT) / 1000 * RATE); c.tokT = now;
        if (c.tok < 1) { if (++c.drops > 600) return kill(c, 1008); continue; }
        c.tok--;
        onMessage(c, text);
      }
    } else return kill(c, 1003);
  }
}

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  const name = (u.searchParams.get('room') || '').toLowerCase();
  if (u.pathname !== '/ws' || !key || !/^[a-z0-9-]{3,24}$/.test(name)) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, room: name, id: 'p' + (nextId++).toString(36) + crypto.randomBytes(2).toString('hex'), buf: Buffer.alloc(0), frag: null, presence: {}, alive: true, dead: false, tok: BURST, tokT: Date.now(), drops: 0 };
  let room = rooms.get(name);
  if (!room) { room = new Map(); rooms.set(name, room); }
  if (room.size >= MAX_PLAYERS) { send(c, { t: 'err', code: 'room_full' }); setTimeout(() => kill(c, 1008), 50); return; }
  sock.on('data', d => onData(c, d));
  sock.on('close', () => kill(c));
  sock.on('error', () => kill(c));
  const peers = [...room.values()].map(o => ({ id: o.id, p: o.presence }));
  room.set(c.id, c);
  send(c, { t: 'hi', id: c.id, peers });
  for (const o of room.values()) if (o !== c) send(o, { t: 'j', id: c.id });
});

/* drop connections that stop answering pings */
setInterval(() => {
  for (const room of rooms.values()) for (const c of room.values()) {
    if (!c.alive) { kill(c, 1001); continue; }
    c.alive = false;
    try { c.sock.write(frame(9, Buffer.alloc(0))); } catch (_) {}
  }
}, 20000).unref();

server.listen(PORT, () => console.log('Slag Runner on http://localhost:' + PORT));
module.exports = { server, rooms };
