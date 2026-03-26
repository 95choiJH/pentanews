require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ftp = require('basic-ftp');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

// CORS — 로컬 파일(file://) 및 localhost 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 정적 파일 서빙 (index.html)
app.use(express.static(__dirname));

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

// FTP 연결 테스트
app.get('/api/ftp/status', async (req, res) => {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    const config = getFtpConfig();
    await client.access({ ...config, secure: false });
    res.json({ ok: true, message: 'FTP 연결 성공' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  } finally {
    client.close();
  }
});

// 이미지 업로드 (base64 JSON 방식)
app.post('/api/ftp/upload', async (req, res) => {
  const { remotePath, files } = req.body;
  if (!remotePath || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, message: '업로드할 파일이 없습니다.' });
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    const config = getFtpConfig();
    await client.access({ ...config, secure: false });
    await client.ensureDir(remotePath);

    const results = [];
    for (const file of files) {
      const { name, dataUrl } = file;
      // data:image/jpeg;base64,xxxx → Buffer
      const base64 = dataUrl.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');

      const { Readable } = require('stream');
      const stream = Readable.from(buffer);
      const remoteFile = remotePath.replace(/\/$/, '') + '/' + name;
      await client.uploadFrom(stream, remoteFile);
      results.push(remoteFile);
    }

    res.json({ ok: true, uploaded: results.length, files: results });
  } catch (e) {
    console.error('FTP 업로드 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  } finally {
    client.close();
  }
});

// HTML 파일 업로드
app.post('/api/ftp/upload-html', async (req, res) => {
  const { remotePath, fileName, html } = req.body;
  if (!remotePath || !fileName || !html) {
    return res.status(400).json({ ok: false, message: 'HTML 데이터가 없습니다.' });
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    const config = getFtpConfig();
    await client.access({ ...config, secure: false });
    await client.ensureDir(remotePath);

    const { Readable } = require('stream');
    const buffer = Buffer.from(html, 'utf-8');
    const stream = Readable.from(buffer);
    const remoteFile = remotePath.replace(/\/$/, '') + '/' + fileName;
    await client.uploadFrom(stream, remoteFile);

    res.json({ ok: true, file: remoteFile });
  } catch (e) {
    console.error('FTP HTML 업로드 실패:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  } finally {
    client.close();
  }
});

// 이미지 프록시 (외부 URL → base64 변환, CORS 우회)
app.get('/api/proxy-image', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, message: 'url 파라미터가 없습니다.' });
  const lib = url.startsWith('https') ? require('https') : require('http');
  lib.get(url, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      return res.status(500).json({ ok: false, message: 'HTTP ' + proxyRes.statusCode });
    }
    const contentType = proxyRes.headers['content-type'] || 'image/jpeg';
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const base64 = 'data:' + contentType + ';base64,' + buffer.toString('base64');
      res.json({ ok: true, dataUrl: base64 });
    });
  }).on('error', (e) => {
    res.status(500).json({ ok: false, message: e.message });
  });
});

const PORT = 3900;
app.listen(PORT, () => {
  console.log(`\n  pentanews 서버 실행 중: http://localhost:${PORT}\n`);
});
