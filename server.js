require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ftp = require('basic-ftp');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { Readable } = require('stream');
const cookieParser = require('cookie-parser');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// CORS (body 파싱 전에 처리)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: 'JSON 파싱 오류' });
  }
  next(err);
});
app.use(cookieParser());

// ─── Auth ─────────────────────────────────────────────────
const AUTH_ID = process.env.AUTH_ID || 'admin';
const AUTH_PW = process.env.AUTH_PW || 'pentanews';
const sessions = new Map();

function isAuthenticated(req) {
  const checkToken = (t) => {
    if (!t || !sessions.has(t)) return false;
    const s = sessions.get(t);
    if (s.expiresAt && Date.now() >= s.expiresAt) { sessions.delete(t); return false; }
    return true;
  };
  // 쿠키 기반 (로컬 서버)
  if (checkToken(req.cookies?.pentanews_session)) return true;
  // Bearer 토큰 기반 (외부 호스팅)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    if (checkToken(auth.slice(7))) return true;
  }
  return false;
}

// 인증 API (인증 불필요)
app.post('/api/auth/login', (req, res) => {
  const { id, pw } = req.body;
  if (id === AUTH_ID && pw === AUTH_PW) {
    const token = crypto.randomUUID();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - Date.now();
    sessions.set(token, { id, loginAt: Date.now(), expiresAt: midnight.getTime() });
    res.cookie('pentanews_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: msUntilMidnight
    });
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.pentanews_session;
  if (token) sessions.delete(token);
  res.clearCookie('pentanews_session');
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ ok: isAuthenticated(req) });
});

// 인증 미들웨어: 보호 대상 라우트
app.use((req, res, next) => {
  const p = req.path;
  // 인증 없이 접근 허용
  if (p === '/login.html' || p.startsWith('/api/auth/')) return next();
  // 정적 리소스 (CDN 라이브러리 등)
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/i.test(p)) return next();
  // localhost 내부 요청 (start.js 등) 허용
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();

  if (!isAuthenticated(req)) {
    // HTML 페이지 요청 → 로그인 리다이렉트
    if (p === '/' || p === '/index.html' || req.accepts('html')) {
      return res.redirect('/login.html');
    }
    // API 요청 → 401
    return res.status(401).json({ ok: false, message: '인증이 필요합니다.' });
  }
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
  console.log(`[upload] remotePath=${remotePath}, files=${files ? files.length : 0}, bridge=${isBridgeConnected()}`);
  if (files && files.length > 0) {
    console.log(`[upload] file[0]: name=${files[0].name}, dataUrl length=${files[0].dataUrl ? files[0].dataUrl.length : 'N/A'}`);
  }
  if (!remotePath || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, message: '업로드할 파일이 없습니다.' });
  }
  try {
    if (isBridgeConnected()) {
      console.log('[upload] bridge로 전송 중...');
      const result = await sendToBridge('upload', { remotePath, files });
      console.log('[upload] bridge 결과:', JSON.stringify(result).slice(0, 200));
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

// ─── Image Proxy (CORS 우회) ─────────────────────────────
app.get('/api/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, message: 'url 파라미터가 필요합니다.' });

  try {
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? require('https') : require('http');

    const fetchImage = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        return res.status(400).json({ ok: false, message: '리다이렉트 횟수 초과' });
      }
      const p = new URL(targetUrl);
      const mod = p.protocol === 'https:' ? require('https') : require('http');
      mod.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          const next = new URL(response.headers.location, targetUrl).href;
          return fetchImage(next, redirectCount + 1);
        }
        if (response.statusCode !== 200) {
          return res.status(502).json({ ok: false, message: `원본 서버 응답: ${response.statusCode}` });
        }
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const base64 = buffer.toString('base64');
          const dataUrl = `data:${contentType};base64,${base64}`;
          res.json({ ok: true, dataUrl });
        });
        response.on('error', () => {
          res.status(502).json({ ok: false, message: '이미지 다운로드 실패' });
        });
      }).on('error', (e) => {
        res.status(502).json({ ok: false, message: e.message });
      });
    };

    fetchImage(url);
  } catch (e) {
    res.status(400).json({ ok: false, message: '잘못된 URL: ' + e.message });
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
