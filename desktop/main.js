const { app, BrowserWindow, protocol, net, Menu, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RECORD = process.argv.includes('--record');
const MODELS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, 'models');
const APP_DIR = path.join(__dirname, 'app');
const INDEX_FILE = path.join(MODELS_DIR, 'index.json');
const HOSTS = new Set([
  'huggingface.co',
  'cdn.jsdelivr.net',
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);

if (RECORD) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'printone-record-')));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (e) { index = {}; }

const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function localResponse(entry) {
  const file = path.join(MODELS_DIR, entry.file);
  const body = fs.readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': entry.type || 'application/octet-stream',
      'content-length': String(body.length),
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin'
    }
  });
}

async function handleRemote(request) {
  const url = request.url.split('#')[0];
  const entry = index[url];
  if (entry && fs.existsSync(path.join(MODELS_DIR, entry.file))) return localResponse(entry);

  const res = await net.fetch(request, { bypassCustomProtocolHandlers: true });
  if (RECORD && res.ok && request.method === 'GET') {
    const buf = Buffer.from(await res.arrayBuffer());
    const file = keyOf(url) + '.bin';
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    fs.writeFileSync(path.join(MODELS_DIR, file), buf);
    index[url] = { file, type: res.headers.get('content-type') || 'application/octet-stream', size: buf.length };
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 1));
    console.log('[record]', (buf.length / 1048576).toFixed(1) + ' MB', url);
    return localResponse(index[url]);
  }
  return res;
}

function serveApp(request) {
  const u = new URL(request.url);
  const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
}

// Drives the app through every model once so each file lands in the local store
const RECORD_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const idle = async () => { await sleep(3000); while (SEG.busy) await sleep(2000); };
  for (const id of ['aiMatteToggle', 'aiSamToggle', 'aiEdgeToggle', 'aiSketchToggle']) document.getElementById(id).checked = true;
  const c = document.createElement('canvas'); c.width = 480; c.height = 320;
  const x = c.getContext('2d');
  x.fillStyle = '#8fc5ee'; x.fillRect(0, 0, 480, 170);
  x.fillStyle = '#5a8f3c'; x.fillRect(0, 170, 480, 150);
  x.fillStyle = '#e8b896'; x.beginPath(); x.arc(240, 100, 40, 0, 7); x.fill();
  x.fillStyle = '#234'; x.fillRect(190, 140, 100, 180);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const t = new DataTransfer(); t.items.add(new File([blob], 't.png', { type: 'image/png' }));
  const input = document.getElementById('fileInput'); input.files = t.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  const sel = document.getElementById('segModel');
  for (const opt of Array.from(sel.options)) {
    sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await idle();
  }
  await idle();
  const rm = document.getElementById('aiRmbgToggle'); rm.checked = true; rm.dispatchEvent(new Event('change', { bubbles: true }));
  await idle();
  document.getElementById('upscaleBtn').click();
  await sleep(5000);
  let waited = 0; while (document.getElementById('upscaleBtn').disabled && waited++ < 120) await sleep(2000);
  await idle();
  return JSON.stringify({ seg: SEG.ready, depth: DEPTH.ready, edge: EDGE.ready, sketch: SKETCH.ready, w: previewWidth });
})()`;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'Printone',
    show: !RECORD,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://local/index.html');
  if (RECORD) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 4000));
        console.log('[record] result', await win.webContents.executeJavaScript(RECORD_SCRIPT, true));
        app.exit(0);
      } catch (err) {
        console.error('[record] failed', err);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', serveApp);
  protocol.handle('https', (request) => {
    const host = new URL(request.url).hostname;
    return HOSTS.has(host) ? handleRemote(request) : net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (!RECORD) app.quit(); });
