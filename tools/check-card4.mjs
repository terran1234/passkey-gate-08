// 카드 4 확인 스크립트: 가짜 기기 두 대(휴대폰 A, 노트북 B)로 패스키 두 개를 등록하고,
// 하나(A)를 지운 뒤 B로는 들어가지고 A로는 안 들어가지는지, 마지막 하나는 못 지우는지 확인한다.
// 실행: node tools/check-card4.mjs   (Edge 필요, 임시 폴더를 쓰므로 실제 data/ 는 건드리지 않는다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
const CODE = 'test-invite-code';
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'evidence');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-test4-'));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? '통과' : '실패'}  ${name}${detail ? ' — ' + detail : ''}`); };
const short = (v) => (typeof v === 'string' && v.length > 48 ? v.slice(0, 40) + `…(생략)` : v);
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
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', (d) => d.accept()); // "지울까요?" 확인창에서 확인을 누른다
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');

  // 가짜 기기 바꾸기: 그 기기가 가진 패스키만 들어 있는 새 인증기로 교체한다.
  // 기기를 떠나기 직전의 상태(서명 횟수 포함)를 저장해 두었다가, 돌아올 때 그대로 되돌린다. (실제 기기가 횟수를 기억하는 것과 같다)
  let current = null;
  let currentName = null;
  const saved = {};
  const deviceCreds = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId: current })).credentials;
  async function useDevice(name) {
    if (current) {
      saved[currentName] = await deviceCreds();
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: current });
    }
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    for (const credential of saved[name] || []) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    current = authenticatorId;
    currentName = name;
  }

  const call = (method, p, body) => page.evaluate(async (method, p, body) => {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, method, p, body);
  const loginWith = async () => {
    const o = await call('POST', '/api/login/options', {});
    let assertion;
    try {
      assertion = await page.evaluate((opt) => window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opt }), o.data);
    } catch (e) { return { status: 0, data: { error: 'device-refused', message: String(e.message).slice(0, 80) } }; }
    return call('POST', '/api/login/verify', assertion);
  };
  const storeFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  const hideNav = () => page.addStyleTag({ content: 'nav.jump{display:none !important}' });
  const shoot = async (file) => {
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
    await (await page.$('#vault')).screenshot({ path: path.join(evidence, file) });
  };

  log('# 카드 4 확인 결과 (가상 인증기 2대 사용: 휴대폰 A, 노트북 B)');
  log(`# 실행 시각: ${new Date().toISOString()}`);
  log();

  // 1) 휴대폰 A로 첫 패스키 등록
  await useDevice('A');
  await page.goto(BASE + '/');
  await page.waitForSelector('#register-first:not([hidden])');
  await page.type('#in-setup', CODE);
  await page.type('#in-name-first', '휴대폰 A');
  await page.click('#form-first button');
  await page.waitForSelector('#passkey-list li');
  const credsA = await deviceCreds();
  check('휴대폰 A로 첫 패스키 등록', storeFile().credentials.length === 1 && credsA.length === 1);

  // 2) 노트북 B로 두 번째 패스키 추가 (로그인한 상태에서)
  await useDevice('B');
  await page.type('#in-name-add', '노트북 B');
  await page.click('#form-add button');
  await page.waitForFunction(() => document.querySelectorAll('#passkey-list li').length === 2);
  const credsB = await deviceCreds();
  const two = storeFile().credentials;
  log();
  log('## 두 번째 패스키 등록 뒤 서버에 저장된 목록');
  two.forEach((c) => log(`- ${c.name}  (등록 ${c.createdAt})  id=${short(c.id)}`));
  check('C42 한 계정에 패스키가 두 개 등록되어 있다', two.length === 2 && credsB.length === 1 && two[0].id !== two[1].id);
  const listText = await page.$eval('#passkey-list', (e) => e.innerText);
  check('C43 목록 화면에 각각의 이름과 등록 날짜가 보인다', listText.includes('휴대폰 A') && listText.includes('노트북 B') && (listText.match(/2026\. \d+\. \d+\./g) || []).length >= 2);
  const hint2 = await page.$eval('#list-hint', (e) => e.textContent);
  log(`화면 안내: ${hint2}`);
  await hideNav();
  await shoot('card4-two-passkeys.png');
  fs.writeFileSync(path.join(evidence, 'card4-server-store-two.json'), JSON.stringify({ owner: '(임의 식별자, 생략)', credentials: two }, null, 2));

  // 3) 지우기 전에는 둘 다 들어간다
  log();
  log('## 지우기 전: 각 기기로 로그인');
  await call('POST', '/api/logout', {});
  await useDevice('A');
  const preA = await loginWith();
  log(`휴대폰 A 로그인: ${preA.status} ${brief(preA.data)}`);
  await call('POST', '/api/logout', {});
  await useDevice('B');
  const preB = await loginWith();
  log(`노트북 B 로그인: ${preB.status} ${brief(preB.data)}`);
  check('지우기 전에는 A, B 둘 다 로그인된다', preA.status === 200 && preB.status === 200);

  // 4) A를 지운다 (B로 로그인된 상태에서, 화면의 지우기 버튼)
  log();
  log('## 휴대폰 A 패스키 지우기 (화면의 "지우기" 버튼)');
  await page.reload();
  await page.waitForSelector('#passkey-list li'); // 서버가 세션을 기억하고 있으므로 B로 로그인된 상태가 이어진다
  const items = await page.$$('#passkey-list li');
  for (const li of items) {
    if ((await li.$eval('.pk-name', (e) => e.textContent)) === '휴대폰 A') { await (await li.$('button.del')).click(); break; }
  }
  await page.waitForFunction(() => document.querySelectorAll('#passkey-list li').length === 1);
  const delMsg = await page.$eval('#msg-list', (e) => e.textContent);
  const afterDel = storeFile().credentials;
  log(`화면 안내: ${delMsg}`);
  log(`서버에 남은 패스키: ${afterDel.map((c) => c.name).join(', ')}`);
  check('패스키 하나를 지운다 (A 삭제, B 남음)', afterDel.length === 1 && afterDel[0].name === '노트북 B');
  const hint1 = await page.$eval('#list-hint', (e) => e.textContent);
  const delDisabled = await page.$eval('#passkey-list button.del', (e) => e.disabled);
  await shoot('card4-after-delete.png');

  // 5) 남은 B로는 들어간다
  log();
  log('## 지운 뒤 로그인');
  await call('POST', '/api/logout', {});
  const postB = await loginWith();
  log(`남은 노트북 B로 로그인: ${postB.status} ${brief(postB.data)}`);
  const vaultB = await call('GET', '/api/vault');
  log(`그 직후 비공개 자료 요청: ${vaultB.status}`);
  check('C44 지운 뒤 남은 패스키(B)로 들어갈 수 있다', postB.status === 200 && vaultB.status === 200);
  await call('POST', '/api/logout', {});

  // 6) 지운 A로는 안 들어간다
  await useDevice('A');
  const postA = await loginWith();
  log(`지운 휴대폰 A로 로그인: ${postA.status} ${brief(postA.data)}`);
  const vaultA = await call('GET', '/api/vault');
  log(`그 직후 비공개 자료 요청: ${vaultA.status}`);
  check('C45 지운 패스키(A)로는 더 이상 들어갈 수 없다(401)', postA.status === 401 && postA.data.error === 'unknown-credential' && vaultA.status === 401, `status ${postA.status} ${postA.data.error}`);

  // 7) 마지막 하나는 못 지운다
  log();
  log('## 패스키가 하나만 남았을 때 (C46)');
  await useDevice('B');
  const reB = await loginWith();
  check('다시 B로 로그인', reB.status === 200);
  const lastId = storeFile().credentials[0].id;
  const delLast = await call('DELETE', '/api/passkeys/' + encodeURIComponent(lastId));
  log(`마지막 패스키 지우기 요청: DELETE /api/passkeys/${short(lastId)} → ${delLast.status} ${brief(delLast.data)}`);
  check('C46 마지막 패스키는 지워지지 않는다(409)', delLast.status === 409 && delLast.data.error === 'last-passkey' && storeFile().credentials.length === 1);
  log(`화면 안내(1개일 때): ${hint1}`);
  check('C46 화면에도 안내가 있고 지우기 버튼이 막혀 있다', hint1.includes('마지막') && delDisabled === true);
  await call('POST', '/api/logout', {});
  const noLoginDel = await call('DELETE', '/api/passkeys/' + encodeURIComponent(lastId));
  check('로그인하지 않으면 지우기 요청은 401', noLoginDel.status === 401, `status ${noLoginDel.status}`);

  const events = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => /^(passkey-|login-(success|rejected))/.test(e.type));
  fs.writeFileSync(path.join(evidence, 'card4-server-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(evidence, 'card4-server-store-after.json'), JSON.stringify({ owner: '(임의 식별자, 생략)', credentials: storeFile().credentials }, null, 2));
  log();
  log(`삭제·로그인 관련 서버 기록 ${events.length}줄을 evidence/card4-server-events.jsonl 에 남겼다. 종류: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
  const failed = results.filter((r) => !r.ok);
  log();
  log(failed.length ? `실패 ${failed.length}건` : `전부 통과 (${results.length}건)`);
  fs.writeFileSync(path.join(evidence, 'card4-check-result.txt'), out.join('\n') + '\n');
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
}
