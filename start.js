/**
 * start.js — server.js 실행 + SSH 터널 + index.html 자동 업데이트 + FTP 업로드
 *
 * 사용법:
 *   node start.js
 *
 * 동작:
 *   1. server.js 실행 (포트 3900)
 *   2. ssh 터널 시작 (localhost.run)
 *   3. 터널 URL 파싱
 *   4. index.html의 _FTP_API 업데이트
 *   5. 업데이트된 index.html을 FTP에 자동 업로드
 *   6. 터널 끊기면 자동 재연결 + 다시 업데이트/업로드
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.html');
const FTP_REMOTE_PATH = '/edit/';
const FTP_FILE_NAME = 'index.html';
const SERVER_PORT = process.env.PORT || 3900;
const API_BASE = `http://localhost:${SERVER_PORT}`;

// 1) server.js 실행
console.log('[tunnel] server.js 시작 중...');
const serverProc = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

serverProc.on('error', (err) => {
  console.error('[tunnel] server.js 실행 실패:', err.message);
  process.exit(1);
});

// 서버 준비 대기 후 터널 시작
setTimeout(startTunnel, 2000);

function startTunnel() {
  console.log('[tunnel] SSH 터널 시작 중...');

  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-R', `80:localhost:${SERVER_PORT}`,
    'nokey@localhost.run'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let urlFound = false;

  function parseUrl(data) {
    const text = data.toString();
    // localhost.run 출력에서 https URL 추출
    const match = text.match(/(https:\/\/[a-z0-9]+\.lhr\.life)/);
    if (match && !urlFound) {
      urlFound = true;
      const tunnelUrl = match[1];
      console.log(`[tunnel] 터널 URL: ${tunnelUrl}`);
      updateAndUpload(tunnelUrl);
    }
  }

  ssh.stdout.on('data', parseUrl);
  ssh.stderr.on('data', parseUrl);

  ssh.on('close', (code) => {
    console.log(`[tunnel] SSH 터널 종료 (code: ${code}). 5초 후 재연결...`);
    urlFound = false;
    setTimeout(startTunnel, 5000);
  });

  ssh.on('error', (err) => {
    console.error('[tunnel] SSH 실행 실패:', err.message);
    console.error('[tunnel] ssh가 설치되어 있는지 확인하세요.');
  });
}

async function updateAndUpload(tunnelUrl) {
  try {
    // index.html 읽기
    let html = fs.readFileSync(INDEX_PATH, 'utf-8');

    // _FTP_API 값 교체
    const regex = /const _FTP_API = '[^']*'/;
    const replacement = `const _FTP_API = '${tunnelUrl}'`;

    if (!regex.test(html)) {
      console.error('[tunnel] index.html에서 _FTP_API를 찾을 수 없습니다.');
      return;
    }

    const oldMatch = html.match(regex);
    if (oldMatch && oldMatch[0] === replacement) {
      console.log('[tunnel] _FTP_API가 이미 최신 URL입니다. 업로드 스킵.');
      return;
    }

    html = html.replace(regex, replacement);

    // 로컬 index.html 저장
    fs.writeFileSync(INDEX_PATH, html, 'utf-8');
    console.log(`[tunnel] index.html 업데이트 완료: ${tunnelUrl}`);

    // FTP 업로드 (로컬 서버 API 사용)
    console.log('[tunnel] FTP 업로드 중...');
    const res = await fetch(`${API_BASE}/api/ftp/upload-html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remotePath: FTP_REMOTE_PATH,
        fileName: FTP_FILE_NAME,
        html
      })
    });

    const data = await res.json();
    if (data.ok) {
      console.log(`[tunnel] FTP 업로드 성공: ${data.file}`);
      console.log(`[tunnel] 준비 완료! 브라우저에서 index.html 접속 가능`);
    } else {
      console.error('[tunnel] FTP 업로드 실패:', data.message);
    }
  } catch (err) {
    console.error('[tunnel] 업데이트/업로드 실패:', err.message);
    // 서버가 아직 준비 안 됐을 수 있음, 3초 후 재시도
    console.log('[tunnel] 3초 후 재시도...');
    setTimeout(() => updateAndUpload(tunnelUrl), 3000);
  }
}

// 종료 처리
process.on('SIGINT', () => {
  console.log('\n[tunnel] 종료 중...');
  serverProc.kill();
  process.exit(0);
});
