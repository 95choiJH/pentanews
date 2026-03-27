require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ftp = require('basic-ftp');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

// ─── FTP Bridge (WebSocket) ───────────────────────────────
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
let bridgeSocket = null;
const pendingRequests = new Map();

function sendToBridge(action, data, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!bridgeSocket || bridgeSocket.readyState !== 1) {
      reject(new Error('FTP 브릿지가 연결되지 않았습니다.'));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('FTP 브릿지 응답 타임아웃'));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    bridgeSocket.send(JSON.stringify({ id, action, data }));
  });
}

function isBridgeConnected() {
  return bridgeSocket && bridgeSocket.readyState === 1;
}

// ─── Local FTP (fallback) ─────────────────────────────────
function getFtpConfig() {
  const host = process.env.FTP_HOST;
  const port = parseInt(process.env.FTP_PORT || '21', 10);
  const user = process.env.FTP_USER;
  const password = process.env.FTP_PASS;
  if (!host || !user || !password) {
    throw new Error('FTP 접속 정보가 .env에 설정되지 않았습니다.');
  }
  return { host, port, user, password };
}

async function connectFtp(client) {
  const config = getFtpConfig();
  try {
    await client.access({ ...config, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
  } catch (_) {
    try {
      await client.access({ ...config, secure: true, secureOptions: { rejectUnauthorized: false } });
    } catch (__) {
      await client.access({ ...config, secure: false });
    }
  }
}

// ─── API Routes (URL 변경 없음) ──────────────────────────

// FTP 브릿지 상태 확인
app.get('/api/ftp/bridge-status', (req, res) => {
  res.json({ connected: isBridgeConnected() });
});

// FTP 연결 테스트
app.get('/api/ftp/status', async (req, res) => {
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('status');
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      res.json({ ok: true, message: 'FTP 연결 성공' });
    } finally {
      client.close();
    }
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 이미지 업로드
app.post('/api/ftp/upload', async (req, res) => {
  const { remotePath, files } = req.body;
  if (!remotePath || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, message: '업로드할 파일이 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('upload', { remotePath, files });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.ensureDir(remotePath);
      const results = [];
      for (const file of files) {
        const base64 = file.dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        const stream = Readable.from(buffer);
        const remoteFile = remotePath.replace(/\/$/, '') + '/' + file.name;
        await client.uploadFrom(stream, remoteFile);
        results.push(remoteFile);
      }
      res.json({ ok: true, uploaded: results.length, files: results });
    } finally {
      client.close();
    }
  } catch (e) {
    console.error('FTP 업로드 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// HTML 파일 업로드
app.post('/api/ftp/upload-html', async (req, res) => {
  const { remotePath, fileName, html } = req.body;
  if (!remotePath || !fileName || !html) {
    return res.status(400).json({ ok: false, message: 'HTML 데이터가 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('upload-html', { remotePath, fileName, html });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.ensureDir(remotePath);
      const buffer = Buffer.from(html, 'utf-8');
      const stream = Readable.from(buffer);
      const remoteFile = remotePath.replace(/\/$/, '') + '/' + fileName;
      await client.uploadFrom(stream, remoteFile);
      res.json({ ok: true, file: remoteFile });
    } finally {
      client.close();
    }
  } catch (e) {
    console.error('FTP HTML 업로드 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// FTP 폴더 존재 확인
app.post('/api/ftp/exists', async (req, res) => {
  const { remotePath } = req.body;
  if (!remotePath) return res.status(400).json({ ok: false, message: '경로가 없습니다.' });
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('exists', { remotePath });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      try {
        await client.size(remotePath);
        return res.json({ ok: true, exists: true });
      } catch (_) { /* not a file */ }
      await client.cd(remotePath);
      res.json({ ok: true, exists: true });
    } catch (e) {
      res.json({ ok: true, exists: false });
    } finally {
      client.close();
    }
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// FTP 폴더 생성
app.post('/api/ftp/mkdir', async (req, res) => {
  const { remotePath } = req.body;
  if (!remotePath) {
    return res.status(400).json({ ok: false, message: '생성할 폴더 경로가 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('mkdir', { remotePath });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.ensureDir(remotePath);
      res.json({ ok: true, created: remotePath });
    } finally {
      client.close();
    }
  } catch (e) {
    console.error('FTP 폴더 생성 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// FTP 폴더 삭제
app.post('/api/ftp/delete-dir', async (req, res) => {
  const { remotePath } = req.body;
  if (!remotePath) {
    return res.status(400).json({ ok: false, message: '삭제할 폴더 경로가 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('delete-dir', { remotePath });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.removeDir(remotePath);
      res.json({ ok: true, deleted: remotePath });
    } finally {
      client.close();
    }
  } catch (e) {
    console.error('FTP 폴더 삭제 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// FTP 파일 삭제
app.post('/api/ftp/delete', async (req, res) => {
  const { remotePath } = req.body;
  if (!remotePath) {
    return res.status(400).json({ ok: false, message: '삭제할 파일 경로가 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      const result = await sendToBridge('delete', { remotePath });
      return res.json(result);
    }
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.remove(remotePath);
      res.json({ ok: true, deleted: remotePath });
    } finally {
      client.close();
    }
  } catch (e) {
    console.error('FTP 삭제 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ─── Server + WebSocket ───────────────────────────────────
const PORT = process.env.PORT || 3900;
const server = app.listen(PORT, () => {
  console.log(`\n  pentanews 서버 실행 중: http://localhost:${PORT}`);
  console.log(`  FTP 브릿지 WebSocket: ws://localhost:${PORT}/ftp-bridge\n`);
});

const wss = new WebSocketServer({ server, path: '/ftp-bridge' });

wss.on('connection', (ws, req) => {
  // 인증 확인
  if (BRIDGE_SECRET) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const secret = url.searchParams.get('secret');
    if (secret !== BRIDGE_SECRET) {
      console.log('[ws] 브릿지 인증 실패 — 연결 거부');
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  console.log('[ws] FTP 브릿지 연결됨');
  bridgeSocket = ws;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, result, error } = msg;
    const pending = pendingRequests.get(id);
    if (!pending) return;

    pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  });

  ws.on('close', () => {
    console.log('[ws] FTP 브릿지 연결 해제');
    if (bridgeSocket === ws) bridgeSocket = null;
  });
});
