const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1024 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const textHistory = [];
const eventLog = [];
const devices = new Map();
const trustFile = path.join(__dirname, 'azudrop-trust.json');
const trustDb = loadTrustDb();
const MAX_TEXT_HISTORY = 500;
const MAX_EVENTS = 200;

function safeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'file';
}

function safeDeviceId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function loadTrustDb() {
  try {
    return JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  } catch {
    return { devices: {} };
  }
}

function saveTrustDb() {
  try { fs.writeFileSync(trustFile, JSON.stringify(trustDb, null, 2)); } catch {}
}

function upsertTrustRecord(device) {
  const key = safeDeviceId(device.deviceKey || device.id);
  if (!key) return null;
  const prev = trustDb.devices[key] || {};
  const now = Date.now();
  const record = {
    id: key,
    name: device.name || prev.name || device.type || 'Device',
    type: device.type || prev.type || 'Device',
    ip: device.ip || prev.ip || '',
    trusted: Boolean(prev.trusted),
    blocked: Boolean(prev.blocked),
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
    trustedAt: prev.trustedAt || null,
    blockedAt: prev.blockedAt || null
  };
  trustDb.devices[key] = record;
  saveTrustDb();
  return record;
}

function getTrustRecord(deviceKey) {
  return trustDb.devices[safeDeviceId(deviceKey)] || null;
}

function publicTrustList() {
  const onlineKeys = new Set([...devices.values()].map((d) => d.deviceKey));
  return Object.values(trustDb.devices)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .map((d) => ({ ...d, online: onlineKeys.has(d.id) }));
}

function logEvent(type, message, meta = {}) {
  const item = { id: safeId(), type, message, meta, at: Date.now() };
  eventLog.unshift(item);
  if (eventLog.length > MAX_EVENTS) eventLog.length = MAX_EVENTS;
  io.emit('event:new', item);
  return item;
}

function pushText(text, from, fromId, toId = 'all') {
  const item = {
    id: safeId(),
    text,
    from: from || 'Unknown',
    fromId: fromId || null,
    toId: toId || 'all',
    toName: toId && toId !== 'all' ? (devices.get(toId)?.name || 'Selected device') : 'All devices',
    at: Date.now()
  };
  textHistory.unshift(item);
  if (textHistory.length > MAX_TEXT_HISTORY) textHistory.length = MAX_TEXT_HISTORY;
  return item;
}

function getLocalIps() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      addresses.push({ name, address: net.address, url: `http://${net.address}:${PORT}` });
    }
  }
  return addresses;
}

function isVirtualAdapterName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('virtual') || n.includes('vmware') || n.includes('virtualbox') || n.includes('hyper-v') || n.includes('wsl') || n.includes('loopback');
}

function scoreAddress(item) {
  const ip = item.address;
  const virtual = isVirtualAdapterName(item.name);
  if (ip.startsWith('192.168.') && !virtual) return 100;
  if (ip.startsWith('10.') && !virtual) return 90;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) && !virtual) return 80;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return 70;
  if (ip.startsWith('169.254.')) return 10;
  return 50;
}

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : (forwarded || socket.handshake.address || '');
  return String(raw).replace('::ffff:', '');
}

function guessDeviceType(ua) {
  const s = String(ua || '').toLowerCase();
  if (s.includes('iphone')) return 'iPhone';
  if (s.includes('android')) return 'Android';
  if (s.includes('ipad') || s.includes('tablet')) return 'Tablet';
  if (s.includes('windows')) return 'Windows PC';
  if (s.includes('macintosh') || s.includes('mac os')) return 'Mac';
  if (s.includes('linux')) return 'Linux PC';
  return 'Device';
}

function publicDeviceList() {
  return [...devices.values()]
    .sort((a, b) => a.connectedAt - b.connectedAt)
    .map(({ id, deviceKey, name, type, ip, connectedAt, lastSeen, trusted, blocked }) => ({ id, deviceKey, name, type, ip, connectedAt, lastSeen, trusted, blocked }));
}

function emitDevices() {
  io.emit('devices:list', publicDeviceList());
  io.emit('trust:list', publicTrustList());
  io.emit('clients', devices.size);
}

function fileType(name) {
  const ext = path.extname(name).toLowerCase().replace('.', '');
  if (['jpg','jpeg','png','gif','webp','svg','bmp','avif'].includes(ext)) return 'image';
  if (['mp4','webm','mov','mkv','avi'].includes(ext)) return 'video';
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'audio';
  if (['txt','md','json','csv','log','js','html','css','xml','yml','yaml'].includes(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return 'archive';
  if (['doc','docx','xls','xlsx','ppt','pptx'].includes(ext)) return 'office';
  return ext || 'file';
}

function getFiles() {
  return fs.readdirSync(uploadsDir)
    .filter((name) => fs.statSync(path.join(uploadsDir, name)).isFile())
    .map((name) => {
      const stat = fs.statSync(path.join(uploadsDir, name));
      const original = name.replace(/^\d+-\d+-/, '');
      return {
        name,
        originalName: original,
        size: stat.size,
        type: fileType(original),
        uploadedAt: stat.mtimeMs,
        url: `/uploads/${encodeURIComponent(name)}`
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${safeName(file.originalname)}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024, files: 50 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir, { fallthrough: false }));

app.get('/api/info', async (_req, res) => {
  const addresses = getLocalIps().sort((a, b) => scoreAddress(b) - scoreAddress(a));
  const url = addresses[0]?.url || `http://localhost:${PORT}`;
  const qr = await QRCode.toDataURL(url);
  const files = getFiles();
  res.json({
    url,
    qr,
    addresses,
    port: PORT,
    stats: {
      texts: textHistory.length,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      devices: devices.size,
      trustedDevices: Object.values(trustDb.devices).filter((d) => d.trusted).length,
      blockedDevices: Object.values(trustDb.devices).filter((d) => d.blocked).length,
      events: eventLog.length
    }
  });
});

app.get('/api/texts', (_req, res) => res.json(textHistory));
app.get('/api/events', (_req, res) => res.json(eventLog));
app.get('/api/trust', (_req, res) => res.json(publicTrustList()));

app.post('/api/trust/:id/:action', (req, res) => {
  const id = safeDeviceId(req.params.id);
  const action = String(req.params.action || '');
  const record = trustDb.devices[id];
  if (!id || !record) return res.status(404).json({ error: 'Device not found.' });

  if (action === 'trust') {
    record.trusted = true;
    record.blocked = false;
    record.trustedAt = Date.now();
    record.blockedAt = null;
  } else if (action === 'untrust') {
    record.trusted = false;
    record.trustedAt = null;
  } else if (action === 'block') {
    record.blocked = true;
    record.trusted = false;
    record.blockedAt = Date.now();
    record.trustedAt = null;
  } else if (action === 'unblock') {
    record.blocked = false;
    record.blockedAt = null;
  } else if (action === 'forget') {
    delete trustDb.devices[id];
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }

  saveTrustDb();
  for (const device of devices.values()) {
    if (device.deviceKey === id) {
      const fresh = getTrustRecord(id);
      device.trusted = Boolean(fresh?.trusted);
      device.blocked = Boolean(fresh?.blocked);
    }
  }
  emitDevices();
  logEvent('trust', `Device trust updated: ${action}.`, { id });
  res.json({ ok: true });
});

app.delete('/api/texts', (_req, res) => {
  textHistory.length = 0;
  io.emit('texts:cleared');
  logEvent('texts', 'Text history cleared.');
  res.json({ ok: true });
});

app.delete('/api/texts/:id', (req, res) => {
  const id = String(req.params.id || '');
  const index = textHistory.findIndex((x) => x.id === id);
  if (index >= 0) textHistory.splice(index, 1);
  io.emit('text:deleted', id);
  logEvent('texts', 'A text item was deleted.');
  res.json({ ok: true });
});

app.post('/api/events/clear', (_req, res) => {
  eventLog.length = 0;
  io.emit('events:cleared');
  res.json({ ok: true });
});

app.get('/api/texts/export', (_req, res) => {
  const content = textHistory.slice().reverse().map((t) => {
    return `[${new Date(t.at).toLocaleString()}] ${t.from} -> ${t.toName || 'All devices'}\n${t.text}\n`;
  }).join('\n---\n\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="azudrop-texts.txt"');
  res.send(content || 'No texts yet.');
});

app.get('/api/files', (_req, res) => res.json(getFiles()));

app.post('/api/upload', upload.array('files', 50), (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: 'No file uploaded.' });
  const deviceId = safeDeviceId(req.body.deviceId);
  const trust = getTrustRecord(deviceId);
  if (trust?.blocked) return res.status(403).json({ error: 'This device is blocked.' });
  const uploader = String(req.body.deviceName || trust?.name || 'Unknown').slice(0, 60);
  const files = uploaded.map((file) => ({
    name: file.filename,
    originalName: file.originalname,
    size: file.size,
    type: fileType(file.originalname),
    url: `/uploads/${encodeURIComponent(file.filename)}`,
    uploadedAt: Date.now(),
    from: uploader
  }));
  io.emit('file:new', files);
  logEvent('file', `${files.length} file(s) uploaded by ${uploader}.`, { count: files.length });
  res.json(files);
});

app.patch('/api/files/:name', (req, res) => {
  const oldName = path.basename(req.params.name);
  const oldPath = path.join(uploadsDir, oldName);
  if (!oldPath.startsWith(uploadsDir) || !fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found.' });
  const clean = safeName(req.body?.newName || 'file');
  const newName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${clean}`;
  const newPath = path.join(uploadsDir, newName);
  fs.renameSync(oldPath, newPath);
  io.emit('file:renamed', { oldName, newName });
  logEvent('file', `File renamed to ${clean}.`);
  res.json({ ok: true, name: newName, originalName: clean, url: `/uploads/${encodeURIComponent(newName)}` });
});

app.delete('/api/files/:name', (req, res) => {
  const filePath = path.join(uploadsDir, path.basename(req.params.name));
  if (!filePath.startsWith(uploadsDir)) return res.status(400).json({ error: 'Invalid file.' });
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  io.emit('file:deleted', req.params.name);
  logEvent('file', 'A file was deleted.');
  res.json({ ok: true });
});

app.post('/api/files/delete', (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  let count = 0;
  for (const item of names) {
    const filePath = path.join(uploadsDir, path.basename(item));
    if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      count++;
    }
  }
  io.emit('files:batchDeleted', names);
  logEvent('file', `${count} file(s) deleted.`);
  res.json({ ok: true, count });
});

app.delete('/api/files', (_req, res) => {
  let count = 0;
  for (const name of fs.readdirSync(uploadsDir)) {
    const filePath = path.join(uploadsDir, name);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
      count++;
    }
  }
  io.emit('files:cleared');
  logEvent('file', `${count} file(s) cleared.`);
  res.json({ ok: true, count });
});

io.on('connection', (socket) => {
  const ua = socket.handshake.headers['user-agent'] || '';
  const base = {
    id: socket.id,
    name: guessDeviceType(ua),
    type: guessDeviceType(ua),
    ip: clientIp(socket),
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    deviceKey: socket.id,
    trusted: false,
    blocked: false
  };
  devices.set(socket.id, base);
  logEvent('device', `${base.name} connected.`, { id: socket.id });
  emitDevices();

  socket.on('device:hello', (payload) => {
    const item = devices.get(socket.id) || base;
    const name = String(payload?.name || item.name || item.type).trim().slice(0, 60);
    const deviceKey = safeDeviceId(payload?.deviceId) || item.deviceKey || socket.id;
    item.deviceKey = deviceKey;
    item.name = name || item.type;
    item.lastSeen = Date.now();
    const record = upsertTrustRecord(item);
    item.trusted = Boolean(record?.trusted);
    item.blocked = Boolean(record?.blocked);
    devices.set(socket.id, item);
    if (item.blocked) socket.emit('device:blocked', { message: 'This device is blocked on this AzuDrop server.' });
    emitDevices();
  });

  socket.on('device:ping', () => {
    const item = devices.get(socket.id);
    if (item) {
      item.lastSeen = Date.now();
      upsertTrustRecord(item);
      devices.set(socket.id, item);
      emitDevices();
    }
  });

  socket.on('text:send', (payload) => {
    const text = String(payload?.text || '').trim();
    if (!text) return;
    const item = devices.get(socket.id);
    if (item) {
      item.lastSeen = Date.now();
      if (item.blocked) { socket.emit('blocked:action', { message: 'Blocked devices cannot send text.' }); return; }
    }
    const from = String(payload?.from || item?.name || 'Unknown').slice(0, 60);
    const toId = String(payload?.toId || 'all');
    const message = pushText(text, from, socket.id, toId);
    if (toId && toId !== 'all' && devices.has(toId)) {
      io.to(toId).emit('text:new', message);
      socket.emit('text:new', message);
      logEvent('text', `${from} sent a private text.`, { toId });
    } else {
      io.emit('text:new', message);
      logEvent('text', `${from} sent a text to everyone.`);
    }
  });

  socket.on('buzz', (payload) => {
    const sender = devices.get(socket.id);
    if (sender?.blocked) { socket.emit('blocked:action', { message: 'Blocked devices cannot ping.' }); return; }
    const from = String(payload?.from || sender?.name || 'Unknown').slice(0, 60);
    const toId = String(payload?.toId || 'all');
    const data = { from, at: Date.now(), toId };
    if (toId !== 'all' && devices.has(toId)) io.to(toId).emit('buzz', data);
    else socket.broadcast.emit('buzz', data);
    logEvent('device', `${from} sent a ping.`);
  });

  socket.on('disconnect', () => {
    const item = devices.get(socket.id);
    devices.delete(socket.id);
    if (item) logEvent('device', `${item.name} disconnected.`);
    emitDevices();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = getLocalIps().sort((a, b) => scoreAddress(b) - scoreAddress(a));
  console.log('\nAzuDrop is running!');
  console.log(`Computer: http://localhost:${PORT}`);
  if (addresses.length) {
    console.log('Phone links to try:');
    for (const item of addresses) console.log(`- ${item.url}  (${item.name})`);
  } else {
    console.log('No network IP found. Connect both devices to the same Wi-Fi or hotspot.');
  }
  console.log('Keep this window open while using AzuDrop.\n');
});
