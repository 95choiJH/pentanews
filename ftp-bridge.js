/**
 * ftp-bridge.js — 로컬에서 실행
 * 외부 서버에 WebSocket으로 연결하여 FTP 작업을 대행한다.
 *
 * 사용법:
 *   WS_SERVER_URL=wss://your-server.com node ftp-bridge.js
 *
 * 환경변수:
 *   WS_SERVER_URL  — 외부 서버의 WebSocket URL (필수)
 *   FTP_HOST, FTP_PORT, FTP_USER, FTP_PASS — FTP 접속 정보
 *   BRIDGE_SECRET  — 외부 서버와 공유하는 인증 토큰
 */
require('dotenv').config();
const WebSocket = require('ws');
const ftp = require('basic-ftp');
const { Readable } = require('stream');

const WS_SERVER_URL = process.env.WS_SERVER_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

if (!WS_SERVER_URL) {
  console.error('WS_SERVER_URL 환경변수가 필요합니다.');
  process.exit(1);
}

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

// FTP 작업 핸들러
const handlers = {
  async status() {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      return { ok: true, message: 'FTP 연결 성공' };
    } finally {
      client.close();
    }
  },

  async upload({ remotePath, files }) {
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
      return { ok: true, uploaded: results.length, files: results };
    } finally {
      client.close();
    }
  },

  async 'upload-html'({ remotePath, fileName, html }) {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.ensureDir(remotePath);
      const buffer = Buffer.from(html, 'utf-8');
      const stream = Readable.from(buffer);
      const remoteFile = remotePath.replace(/\/$/, '') + '/' + fileName;
      await client.uploadFrom(stream, remoteFile);
      return { ok: true, file: remoteFile };
    } finally {
      client.close();
    }
  },

  async exists({ remotePath }) {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      try {
        await client.size(remotePath);
        return { ok: true, exists: true };
      } catch (_) { /* not a file */ }
      await client.cd(remotePath);
      return { ok: true, exists: true };
    } catch (e) {
      return { ok: true, exists: false };
    } finally {
      client.close();
    }
  },

  async mkdir({ remotePath }) {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.ensureDir(remotePath);
      return { ok: true, created: remotePath };
    } finally {
      client.close();
    }
  },

  async 'delete-dir'({ remotePath }) {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.removeDir(remotePath);
      return { ok: true, deleted: remotePath };
    } finally {
      client.close();
    }
  },

  async delete({ remotePath }) {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await connectFtp(client);
      await client.remove(remotePath);
      return { ok: true, deleted: remotePath };
    } finally {
      client.close();
    }
  }
};

// WebSocket 연결 및 재연결
function connect() {
  const url = BRIDGE_SECRET
    ? `${WS_SERVER_URL}?secret=${encodeURIComponent(BRIDGE_SECRET)}`
    : WS_SERVER_URL;

  console.log(`[bridge] ${WS_SERVER_URL} 에 연결 중...`);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[bridge] 외부 서버에 연결됨. FTP 요청 대기 중...');
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { id, action, data } = msg;
    const handler = handlers[action];

    if (!handler) {
      ws.send(JSON.stringify({ id, error: `알 수 없는 action: ${action}` }));
      return;
    }

    try {
      console.log(`[bridge] FTP 작업: ${action}`);
      const result = await handler(data || {});
      ws.send(JSON.stringify({ id, result }));
    } catch (e) {
      console.error(`[bridge] ${action} 실패:`, e.message);
      ws.send(JSON.stringify({ id, error: e.message }));
    }
  });

  ws.on('close', () => {
    console.log('[bridge] 연결 끊김. 5초 후 재연결...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('[bridge] WebSocket 에러:', err.message);
    ws.close();
  });
}

connect();
