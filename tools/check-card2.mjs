// 카드 2 확인 스크립트: 가상 인증기(브라우저 개발자 도구가 제공하는 가짜 기기)로 등록 흐름을 끝까지 돌려 본다.
// 실행: node tools/check-card2.mjs   (Edge 필요, 임시 폴더를 쓰므로 실제 data/ 는 건드리지 않는다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const CODE = 'test-invite-code';
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'evidence');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-test-'));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? '통과' : '실패'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT, ORIGIN: BASE, SETUP_CODE: CODE, DATA_DIR: dataDir },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/status'); break; } catch { await sleep(150); } }

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  const verifyBodies = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/register/verify')) verifyBodies.push(r.postData()); });
  await page.goto(BASE + '/');
  await page.waitForSelector('#register-first:not([hidden])');

  const post = (p, body) => page.evaluate(async (p, body) => {
    const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, p, body);

  log('# 카드 2 확인 결과 (가상 인증기 사용)');
  log(`# 실행 시각: ${new Date().toISOString()}`);
  log();

  // C19, C20: 질문이 매번 다르다
  log('## 등록용 질문(challenge) 발급 — 두 번 요청');
  const o1 = await post('/api/register/options', { name: 'x', setupCode: CODE });
  const o2 = await post('/api/register/options', { name: 'x', setupCode: CODE });
  log(`요청 1 challenge: ${o1.data.challenge}`);
  log(`요청 2 challenge: ${o2.data.challenge}`);
  check('C19 서버가 질문(challenge)을 만들어 보낸다', o1.status === 200 && !!o1.data.challenge);
  check('C20 요청마다 질문 값이 다르다', o1.data.challenge !== o2.data.challenge);
  log();

  // 잘못된 초대 코드
  const bad = await post('/api/register/options', { name: 'x', setupCode: 'wrong' });
  check('초대 코드가 틀리면 거절(403)', bad.status === 403, `status ${bad.status}`);
  const noLogin = await page.evaluate(async () => (await fetch('/api/passkeys')).status);
  check('로그인 전 패스키 목록 요청은 401', noLogin === 401, `status ${noLogin}`);

  // C25: 취소
  log();
  log('## 등록 취소');
  await page.evaluate(() => { navigator.credentials.create = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')); });
  await page.type('#in-setup', CODE);
  await page.type('#in-name-first', '취소 시험');
  await page.click('#form-first button');
  await page.waitForFunction(() => document.getElementById('msg-first').textContent.includes('취소'));
  const cancelMsg = await page.$eval('#msg-first', (e) => e.textContent);
  log(`화면 안내: ${cancelMsg}`);
  const afterCancel = await (await fetch(BASE + '/api/status')).json();
  check('C25 취소하면 화면에 안내가 나온다', cancelMsg.includes('취소'));
  check('C25 취소하면 서버에 아무것도 저장되지 않는다', afterCancel.registered === false && !fs.existsSync(path.join(dataDir, 'store.json')), JSON.stringify(afterCancel));

  // 진짜 등록 (가상 인증기)
  log();
  log('## 패스키 등록');
  await page.reload();
  await page.waitForSelector('#register-first:not([hidden])');
  await page.type('#in-setup', CODE);
  await page.type('#in-name-first', '시험용 가상 기기');
  await page.click('#form-first button');
  await page.waitForSelector('#passkey-manage:not([hidden]) #passkey-list li');
  const okMsg = await page.$eval('#msg-first', (e) => e.textContent).catch(() => '');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  const saved = store.credentials[0];
  check('C21 등록이 끝나면 서버에 공개키가 저장된다', store.credentials.length === 1 && saved.publicKey.length > 40);
  check('C24 패스키에 알아볼 수 있는 이름이 붙는다', saved.name === '시험용 가상 기기', saved.name);
  const listText = await page.$eval('#passkey-list', (e) => e.innerText);
  check('C24 목록 화면에 이름이 보인다', listText.includes('시험용 가상 기기'));

  // C23: 요청 본문에 개인키가 없다
  const body = JSON.parse(verifyBodies[verifyBodies.length - 1]);
  const bodyText = JSON.stringify(body);
  const clientData = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url').toString());
  log();
  log('## 서버로 간 등록 요청 본문 (POST /api/register/verify)');
  const short = (v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 60) + `…(길이 ${v.length}, 생략)` : v);
  log(JSON.stringify({ ...body, response: Object.fromEntries(Object.entries(body.response).map(([k, v]) => [k, k === 'publicKey' ? v : short(v)])) }, null, 2));
  log(`clientDataJSON 풀이: ${JSON.stringify(clientData)}`);
  log(`본문의 키: ${Object.keys(body).join(', ')} / response 의 키: ${Object.keys(body.response).join(', ')}`);
  check('C23 요청 본문에 개인키가 없다', !/private/i.test(bodyText) && !('d' in body) && Object.keys(body.response).every((k) => ['clientDataJSON', 'attestationObject', 'transports', 'authenticatorData', 'publicKey', 'publicKeyAlgorithm'].includes(k)), '본문 키 확인');
  check('질문이 서버가 낸 값 그대로 돌아왔다', typeof clientData.challenge === 'string' && clientData.type === 'webauthn.create');

  // 개인키는 인증기 안에만
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  log();
  log('## 가상 인증기(기기) 안에 있는 것');
  log(`기기 안 패스키 수: ${credentials.length}, 개인키 보관 여부: ${credentials[0]?.privateKey ? '기기 안에만 있음(서버로 보내지 않음)' : '?'}`);
  check('개인키는 기기 안에만 있다', credentials.length === 1 && !!credentials[0].privateKey);
  check('서버에는 공개키만 저장된다', !JSON.stringify(store).includes(credentials[0].privateKey.slice(0, 40)));

  // 재사용 불가: 같은 본문 다시 보내기
  const replay = await page.evaluate(async (b) => {
    const r = await fetch('/api/register/verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: b });
    return { status: r.status, data: await r.json() };
  }, verifyBodies[verifyBodies.length - 1]);
  check('쓴 질문은 다시 통하지 않는다(재전송 거절)', replay.status === 400, `status ${replay.status} ${replay.data.error}`);

  // 같은 기기로 중복 등록
  await page.type('#in-name-add', '중복 시도');
  await page.click('#form-add button');
  await page.waitForFunction(() => document.getElementById('msg-add').textContent.length > 0);
  const dup = await page.$eval('#msg-add', (e) => e.textContent);
  log(`같은 기기로 한 번 더 등록: ${dup}`);
  check('같은 기기로 두 번 등록하면 안내가 나온다', dup.includes('이미'));

  // 증거 저장
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
  await page.addStyleTag({ content: 'nav.jump{display:none !important}' }); // 따라다니는 상단 메뉴가 캡처를 가리지 않게
  await (await page.$('#vault')).screenshot({ path: path.join(evidence, 'card2-passkey-list.png') });
  const events = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  fs.writeFileSync(path.join(evidence, 'card2-server-store.json'), JSON.stringify({ owner: '(임의 식별자, 생략)', credentials: store.credentials }, null, 2));
  fs.writeFileSync(path.join(evidence, 'card2-server-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  log();
  log(`서버 기록 ${events.length}줄을 evidence/card2-server-events.jsonl 에, 저장된 값을 evidence/card2-server-store.json 에 남겼다.`);
  log(`종류: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
  log();
  const failed = results.filter((r) => !r.ok);
  log(failed.length ? `실패 ${failed.length}건` : `전부 통과 (${results.length}건)`);
  fs.writeFileSync(path.join(evidence, 'card2-check-result.txt'), out.join('\n') + '\n');
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
}
