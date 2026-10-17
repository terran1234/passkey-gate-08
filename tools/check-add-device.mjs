// 새 기기 추가(일회용 코드) 확인 스크립트: 로그인한 기기가 코드를 만들고, 패스키가 없는 새 기기가 그 코드로 패스키를 더한다.
// 실행: node tools/check-add-device.mjs   (Edge 필요, 임시 폴더를 쓰므로 실제 data/ 는 건드리지 않는다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = 3103;
const BASE = `http://localhost:${PORT}`;
const SETUP = 'test-invite-code';
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'evidence');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-test-add-'));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? '통과' : '실패'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT, ORIGIN: BASE, SETUP_CODE: SETUP, DATA_DIR: dataDir },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/status'); break; } catch { await sleep(150); } }

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  let current = null;
  async function newDevice() {
    if (current) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: current });
    current = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })).authenticatorId;
  }
  const call = (method, p, body) => page.evaluate(async (method, p, body) => {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, method, p, body);
  const storeFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  const submitAddForm = async (code, name) => {
    await page.evaluate(() => { document.querySelector('details.addhere').open = true; document.getElementById('in-addcode').value = ''; document.getElementById('in-name-addcode').value = ''; document.getElementById('msg-addcode').textContent = ''; });
    await page.type('#in-addcode', code);
    await page.type('#in-name-addcode', name);
    await page.click('#form-addcode button');
    await page.waitForFunction(() => document.getElementById('msg-addcode').textContent.length > 0, { timeout: 8000 });
    return page.$eval('#msg-addcode', (e) => e.textContent);
  };

  log('# 새 기기 추가(일회용 코드) 확인 결과 (가상 인증기 사용)');
  log(`# 실행 시각: ${new Date().toISOString()}`);
  log();

  // 1) 노트북에서 첫 패스키 등록 → 일회용 코드 만들기
  await newDevice();
  await page.goto(BASE + '/');
  await page.waitForSelector('#register-first:not([hidden])');
  await page.type('#in-setup', SETUP);
  await page.type('#in-name-first', '노트북');
  await page.click('#form-first button');
  await page.waitForSelector('#passkey-manage:not([hidden]) #passkey-list li');
  await page.click('#btn-invite');
  await page.waitForSelector('#invite-code:not([hidden])');
  const code = await page.$eval('#invite-code', (e) => e.textContent);
  log(`로그인한 노트북 화면에 일회용 코드가 나온다: ****-****  (실제 값은 가림)`);
  check('로그인한 기기가 일회용 코드를 만든다', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await call('POST', '/api/logout', {});
  const noLoginInvite = await call('POST', '/api/passkeys/invite', {});
  check('로그인하지 않으면 코드를 만들 수 없다(401)', noLoginInvite.status === 401, `status ${noLoginInvite.status}`);
  log();

  // 2) 새 휴대폰(로그아웃 상태, 패스키 없음)
  await newDevice();
  await page.reload();
  await page.waitForSelector('#need-login:not([hidden])');
  log('## 새 휴대폰(로그아웃 상태)에서');
  const noCode = await call('POST', '/api/register/options', { name: '휴대폰' });
  log(`코드 없이 등록 시작: ${noCode.status} ${JSON.stringify(noCode.data)}`);
  check('코드 없이는 새 기기에서 패스키를 더할 수 없다(401)', noCode.status === 401);
  const wrongMsg = await submitAddForm('AAAA-BBBB', '내 휴대폰');
  log(`틀린 코드를 화면에 입력: ${wrongMsg}`);
  check('틀린 코드는 거절되고 화면에 안내가 나온다', wrongMsg.includes('일회용 코드') && storeFile().credentials.length === 1);

  await page.evaluate(() => { document.getElementById('in-addcode').value = ''; document.getElementById('in-name-addcode').value = ''; });
  await page.type('#in-addcode', code.toLowerCase()); // 소문자로 쳐도 된다
  await page.type('#in-name-addcode', '내 휴대폰');
  await page.click('#form-addcode button');
  await page.waitForFunction(() => document.querySelectorAll('#passkey-list li').length === 2, { timeout: 8000 });
  const after = storeFile().credentials;
  log(`맞는 코드로 등록: 서버에 저장된 패스키 ${after.map((c) => c.name).join(', ')}`);
  check('맞는 코드로 새 기기에 패스키가 추가된다(2개)', after.length === 2 && after[1].name === '내 휴대폰');
  const vault = await call('GET', '/api/vault');
  check('추가한 기기는 바로 들어가진다', vault.status === 200);
  log();

  // 3) 코드는 한 번만
  await call('POST', '/api/logout', {});
  await newDevice();
  await page.reload();
  await page.waitForSelector('#need-login:not([hidden])');
  const reuse = await call('POST', '/api/register/options', { name: '또 다른 기기', addCode: code });
  log(`같은 코드를 다시 사용: ${reuse.status} ${JSON.stringify(reuse.data)}`);
  check('한 번 쓴 코드는 다시 통하지 않는다(401)', reuse.status === 401 && storeFile().credentials.length === 2);

  // 4) 틀린 코드를 계속 보내면 잠시 막힌다
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/register/options', { name: 'x', addCode: 'ZZZZ-ZZZZ' });
  check('코드를 계속 틀리면 잠시 막힌다(429)', last.status === 429, `status ${last.status}`);

  const events = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
  check('서버 기록에 코드 값이 남지 않는다', !events.includes(code) && !events.includes(code.replace('-', '')));
  check('이 결과 파일에도 코드 값이 없다', !out.join('\n').includes(code));
  log();
  const failed = results.filter((r) => !r.ok);
  log(failed.length ? `실패 ${failed.length}건` : `전부 통과 (${results.length}건)`);
  fs.writeFileSync(path.join(evidence, 'card4-add-device-result.txt'), out.join('\n') + '\n');
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
}
