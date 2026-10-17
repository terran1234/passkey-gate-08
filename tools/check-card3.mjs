// 카드 3 확인 스크립트: 가상 인증기로 로그인 성공 · 실패 · 질문 재사용 · 로그아웃 뒤 재요청을 돌려 본다.
// 실행: node tools/check-card3.mjs   (Edge 필요, 임시 폴더를 쓰므로 실제 data/ 는 건드리지 않는다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const CODE = 'test-invite-code';
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'evidence');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-test3-'));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? '통과' : '실패'}  ${name}${detail ? ' — ' + detail : ''}`); };
const short = (v) => (typeof v === 'string' && v.length > 48 ? v.slice(0, 40) + `…(길이 ${v.length}, 생략)` : v);
const brief = (o) => JSON.stringify(o, (k, v) => short(v));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT, ORIGIN: BASE, SETUP_CODE: CODE, DATA_DIR: dataDir },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/status'); break; } catch { await sleep(150); } }

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(BASE + '/');
  await page.waitForSelector('#register-first:not([hidden])');

  // 요청을 보내고 (요청 요약, 응답)을 기록한다. 세션·토큰 값은 브라우저가 쿠키로만 들고 있어 여기에 나오지 않는다.
  const call = (method, p, body) => page.evaluate(async (method, p, body) => {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, method, p, body);
  const show = (label, method, p, body, res) => {
    log(`### ${label}`);
    log(`요청: ${method} ${p}${body !== undefined ? '  본문 ' + brief(body) : ''}  (세션 쿠키 값은 기록에서 가림)`);
    log(`응답: ${res.status} ${brief(res.data)}`);
    log();
  };
  const getAssertion = (optionsJSON) => page.evaluate((o) => window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o }), optionsJSON);

  log('# 카드 3 확인 결과 (가상 인증기 사용)');
  log(`# 실행 시각: ${new Date().toISOString()}`);
  log();

  // 준비: 패스키 등록(화면) 후 로그아웃
  await page.type('#in-setup', CODE);
  await page.type('#in-name-first', '시험용 가상 기기');
  await page.click('#form-first button');
  await page.waitForSelector('#passkey-manage:not([hidden]) #passkey-list li');
  await call('POST', '/api/logout', {});
  const st0 = await call('GET', '/api/status');
  check('준비: 패스키 등록 후 로그아웃 상태', st0.data.registered === true && st0.data.loggedIn === false);
  log();

  // C27, C28: 로그인 질문이 매번 다르다
  log('## 1. 로그인용 질문 — 두 번 요청');
  const o1 = await call('POST', '/api/login/options', {});
  const o2 = await call('POST', '/api/login/options', {});
  show('요청 1', 'POST', '/api/login/options', {}, o1);
  show('요청 2', 'POST', '/api/login/options', {}, o2);
  log(`요청 1 challenge: ${o1.data.challenge}`);
  log(`요청 2 challenge: ${o2.data.challenge}`);
  check('C27 로그인할 때도 서버가 새 질문을 만들어 보낸다', o1.status === 200 && !!o1.data.challenge);
  check('C28 로그인 요청마다 질문 값이 다르다', o1.data.challenge !== o2.data.challenge);
  log();

  // C30(실패): 서명을 일부러 바꿔 보낸다
  log('## 2. 실패하는 요청 — 기기가 서명한 답에서 서명 한 글자를 바꿔 보냄');
  const o3 = await call('POST', '/api/login/options', {});
  const good3 = await getAssertion(o3.data);
  const sig = Buffer.from(good3.response.signature, 'base64url');
  sig[sig.length - 3] ^= 0x01; // 서명 한 바이트만 변조
  const forged = { ...good3, response: { ...good3.response, signature: sig.toString('base64url') } };
  const failRes = await call('POST', '/api/login/verify', forged);
  show('변조한 서명으로 로그인 시도', 'POST', '/api/login/verify', forged, failRes);
  const vaultAfterFail = await call('GET', '/api/vault');
  log(`그 직후 비공개 자료 요청: ${vaultAfterFail.status}`);
  check('C29 서명이 틀리면 거절한다(401)', failRes.status === 401 && failRes.data.error === 'verify-failed', `status ${failRes.status}`);
  check('실패한 로그인 뒤에도 비공개 자료는 열리지 않는다', vaultAfterFail.status === 401);
  log();

  // C30(성공)
  log('## 3. 성공하는 요청 — 같은 방식으로 새 질문, 변조 없는 서명');
  const o4 = await call('POST', '/api/login/options', {});
  const good4 = await getAssertion(o4.data);
  const okRes = await call('POST', '/api/login/verify', good4);
  show('정상 서명으로 로그인', 'POST', '/api/login/verify', good4, okRes);
  const vaultAfterOk = await call('GET', '/api/vault');
  log(`그 직후 비공개 자료 요청: ${vaultAfterOk.status} (항목 ${vaultAfterOk.data.items?.length ?? 0}개)`);
  check('C29 서명이 맞을 때만 통과한다(200)', okRes.status === 200 && okRes.data.verified === true);
  check('C30 성공(200)과 실패(401) 요청이 나란히 기록됐다', okRes.status === 200 && failRes.status === 401);
  check('로그인 뒤 비공개 자료가 열린다', vaultAfterOk.status === 200 && vaultAfterOk.data.items?.length >= 3);
  log();

  // 세션 값 확보(가려서 기록), 로그아웃
  const cookies = await page.cookies();
  const sid = cookies.find((c) => c.name === 'sid');
  check('C32 로그인 뒤 사람을 알아보는 것은 세션 쿠키(sid, HttpOnly)', !!sid && sid.httpOnly === true && sid.sameSite === 'Strict', `HttpOnly=${sid?.httpOnly} SameSite=${sid?.sameSite} 값=****`);
  const jsCanRead = await page.evaluate(() => document.cookie.includes('sid='));
  check('화면 스크립트는 세션 쿠키를 읽을 수 없다', jsCanRead === false);
  log();

  log('## 4. 로그아웃');
  const lo = await call('POST', '/api/logout', {});
  show('로그아웃', 'POST', '/api/logout', {}, lo);
  const reuseSid = await fetch(BASE + '/api/vault', { headers: { Cookie: `sid=${sid.value}` } });
  log('### 로그아웃 전에 쓰던 세션 값으로 다시 요청');
  log(`요청: GET /api/vault  (쿠키: sid=**** 가려짐, 로그아웃 전과 같은 값)`);
  log(`응답: ${reuseSid.status} ${brief(await reuseSid.json())}`);
  log();
  check('C33 로그아웃한 뒤 같은 세션 값으로 요청하면 거절(401)', reuseSid.status === 401, `status ${reuseSid.status}`);

  // C31: 이미 쓴 질문 재사용
  log('## 5. 이미 쓴 질문으로 다시 로그인 시도 (3번의 정상 요청 본문을 그대로 재전송)');
  const replay = await call('POST', '/api/login/verify', good4);
  show('같은 답을 다시 보냄', 'POST', '/api/login/verify', good4, replay);
  const vaultAfterReplay = await call('GET', '/api/vault');
  log(`그 직후 비공개 자료 요청: ${vaultAfterReplay.status}`);
  check('C31 이미 쓴 질문으로 다시 로그인하면 거절한다', replay.status === 400 && replay.data.error === 'challenge-expired-or-used', `status ${replay.status} ${replay.data.error}`);
  check('재전송 뒤에도 비공개 자료는 열리지 않는다', vaultAfterReplay.status === 401);
  // 쿠키 없는 곳(다른 브라우저)에서 재전송
  const replayElsewhere = await fetch(BASE + '/api/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good4) });
  check('쿠키 없이(다른 곳에서) 재전송해도 거절한다', replayElsewhere.status === 400, `status ${replayElsewhere.status}`);
  log();

  // C35: 비밀번호 입력 칸 없음
  log('## 6. 비밀번호 입력 칸 검사');
  const html = await (await fetch(BASE + '/')).text();
  const js = await (await fetch(BASE + '/app.js')).text();
  const hasPwInput = /type\s*=\s*["']?password/i.test(html + js) || /autocomplete\s*=\s*["']?(current|new)-password/i.test(html + js);
  const inputs = await page.$$eval('input', (els) => els.map((e) => `${e.id}:${e.type}`));
  log(`화면의 입력 칸: ${inputs.join(', ')}`);
  check('C35 비밀번호를 입력하는 칸이 없다', hasPwInput === false);
  log();

  // C34: 기록에 세션·토큰 값이 없다
  const eventsRaw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
  check('C34 서버 기록(events)에 세션 값이 없다', !eventsRaw.includes(sid.value));
  check('C34 이 결과 파일에도 세션 값이 없다', !out.join('\n').includes(sid.value));

  const events = eventsRaw.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type.startsWith('login'));
  fs.writeFileSync(path.join(evidence, 'card3-server-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  log();
  log(`서버 기록 중 로그인 관련 ${events.length}줄을 evidence/card3-server-events.jsonl 에 남겼다.`);
  log(`종류: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
  const failed = results.filter((r) => !r.ok);
  log();
  log(failed.length ? `실패 ${failed.length}건` : `전부 통과 (${results.length}건)`);
  fs.writeFileSync(path.join(evidence, 'card3-check-result.txt'), out.join('\n') + '\n');
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
}
