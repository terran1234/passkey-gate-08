// 패스키 등록 · 로그인 · 목록 · 지우기 · 로그아웃 경로.
// 계정이 여러 개이고, 패스키마다 어느 계정 것인지 적혀 있다. 세션에는 "어느 계정으로 들어왔는지"가 들어간다.
const crypto = require('crypto');
const express = require('express');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { ORIGIN, RP_ID, RP_NAME, SETUP_CODE } = require('./config');
const store = require('./store');
const { logEvent } = require('./events');
const { authenticatorName } = require('./aaguids');
const { parseCookies, startSession, endSession, currentUser, requireLogin } = require('./session');

const router = express.Router();

// 받아들일 서명 알고리즘: ES256(-7), RS256(-257). Windows Hello·휴대폰·보안 키가 모두 지원한다.
// 라이브러리 기본값에는 아주 큰 키를 쓰는 최신 알고리즘이 섞여 있어서 고정해 둔다. (만들 때와 확인할 때 같은 값)
const ALGORITHMS = [-7, -257];

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_COOKIE = 'chal';
// 서버가 낸 질문을 확인할 때까지 보관하는 곳. 한 번 꺼내 쓰면 바로 지운다(재사용 불가).
const pendingChallenges = new Map(); // cookie id -> { challenge, name, newAccount, accountId, addCode, expires }

// 초대 코드 무차별 대입 방지: 한 주소에서 5번 틀리면 10분 동안 막는다.
const setupFails = new Map(); // ip -> { count, until }

function sameSecret(input, secret) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const codeMatches = (input) => sameSecret(input, SETUP_CODE);

// 새 기기 추가용 일회용 코드: 로그인한 계정만 만들 수 있고, 5분 동안 한 번만 쓸 수 있다. 한 번에 하나만 유효.
// 코드를 만든 계정에만 패스키를 더할 수 있다. 비밀번호가 아니다.
const ADD_CODE_TTL_MS = 5 * 60 * 1000;
const ADD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I 처럼 헷갈리는 글자는 뺀다
let addCode = null; // { code, expires, accountId }

function mintAddCode(accountId) {
  let code = '';
  for (let i = 0; i < 8; i++) code += ADD_CODE_ALPHABET[crypto.randomInt(ADD_CODE_ALPHABET.length)];
  addCode = { code, expires: Date.now() + ADD_CODE_TTL_MS, accountId };
  return code;
}
const normalizeCode = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');
function addCodeValid(input) {
  return !!addCode && addCode.expires > Date.now() && sameSecret(normalizeCode(input), addCode.code);
}

function tooManyFails(ip) {
  const f = setupFails.get(ip);
  return !!f && f.until > Date.now();
}
function noteFail(ip) {
  const n = (setupFails.get(ip)?.count || 0) + 1;
  setupFails.set(ip, { count: n, until: n >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
}

function publicView(c) {
  return {
    id: c.id,
    accountId: c.accountId,
    name: c.name,
    createdAt: c.createdAt,
    publicKey: c.publicKey,
    transports: c.transports || [],
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    aaguid: c.aaguid,
    authenticator: authenticatorName(c.aaguid),
  };
}

function cleanName(raw) {
  const name = String(raw || '').trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
}

function setChallengeCookie(res, id, cookie = CHALLENGE_COOKIE, cookiePath = '/api/register') {
  res.setHeader('Set-Cookie', `${cookie}=${id}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${CHALLENGE_TTL_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function takeChallenge(req, cookie = CHALLENGE_COOKIE) {
  const id = parseCookies(req.headers.cookie)[cookie];
  const entry = id ? pendingChallenges.get(id) : null;
  if (id) pendingChallenges.delete(id); // 성공이든 실패든 한 번 꺼내면 끝
  if (!entry || entry.expires < Date.now()) return null;
  return entry;
}

// 화면이 어떤 모습을 보여 줄지 정하는 값. 공개 정보(계정이 있는지·로그인 여부)와, 로그인했다면 내 계정 이름만 알려 준다.
router.get('/status', (req, res) => {
  const u = currentUser(req);
  const data = store.load();
  const acc = u && data.accounts.find((a) => a.id === u.userId);
  res.set('Cache-Control', 'no-store');
  res.json({ registered: data.accounts.length > 0, loggedIn: !!acc, account: acc ? { id: acc.id, name: acc.name } : null });
});

// 1) 등록용 질문(challenge) 만들기. 세 가지 경우가 있다.
//   (가) 새 계정 만들기: 서버 주인이 정한 초대 코드(SETUP_CODE)가 필요하다. 아무나 계정을 만들지 못하게 하는 문지기다.
//   (나) 로그인한 계정에 패스키 더하기: 세션의 계정에만 더한다.
//   (다) 새 기기에서 일회용 코드로 더하기: 코드를 만든 계정에만 더한다.
router.post('/register/options', async (req, res) => {
  const data = store.load();
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name-required', message: '패스키 이름은 1~40자로 적어 주세요.' });

  const u = currentUser(req);
  const wantsNew = data.accounts.length === 0 || req.body?.setupCode !== undefined;
  let account = null;     // 기존 계정에 더할 때
  let newAccount = null;  // 새 계정을 만들 때 (등록 확인이 끝나야 실제로 저장한다)
  let viaAddCode = false;

  if (wantsNew) {
    if (tooManyFails(req.ip)) return res.status(429).json({ error: 'too-many-attempts', message: '초대 코드를 너무 많이 틀렸습니다. 잠시 뒤에 다시 시도하세요.' });
    if (!codeMatches(req.body?.setupCode)) {
      noteFail(req.ip);
      logEvent('register-rejected', { reason: 'bad-setup-code' });
      return res.status(403).json({ error: 'bad-setup-code', message: '초대 코드가 맞지 않습니다.' });
    }
    setupFails.delete(req.ip);
    const accountName = cleanName(req.body?.accountName);
    if (!accountName) return res.status(400).json({ error: 'account-name-required', message: '계정 이름은 1~40자로 적어 주세요.' });
    if (data.accounts.some((a) => a.name === accountName)) return res.status(409).json({ error: 'account-exists', message: '이미 있는 계정 이름입니다.' });
    newAccount = { name: accountName, userID: crypto.randomBytes(32).toString('base64url') };
  } else if (u) {
    account = data.accounts.find((a) => a.id === u.userId);
    if (!account) return res.status(401).json({ error: 'unauthorized' });
  } else {
    // 로그인하지 않은 새 기기: 로그인한 기기에서 만든 일회용 코드가 있어야 한다.
    if (tooManyFails(req.ip)) return res.status(429).json({ error: 'too-many-attempts', message: '코드를 너무 많이 틀렸습니다. 잠시 뒤에 다시 시도하세요.' });
    if (!addCodeValid(req.body?.addCode)) {
      noteFail(req.ip);
      logEvent('register-rejected', { reason: 'not-logged-in-and-bad-add-code' });
      return res.status(401).json({ error: 'unauthorized', message: '패스키를 더하려면 로그인하거나, 로그인한 기기에서 만든 일회용 코드가 필요합니다.' });
    }
    setupFails.delete(req.ip);
    account = data.accounts.find((a) => a.id === addCode.accountId);
    if (!account) return res.status(401).json({ error: 'unauthorized' });
    viaAddCode = true;
  }

  const target = newAccount || account;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: target.name,
    userDisplayName: target.name,
    userID: Buffer.from(target.userID, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS,
    // 같은 계정에 같은 기기로 두 번 등록 방지. 다른 계정이면 같은 기기에도 만들 수 있다.
    excludeCredentials: account ? data.credentials.filter((c) => c.accountId === account.id).map((c) => ({ id: c.id, transports: c.transports })) : [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  const cid = crypto.randomBytes(16).toString('hex');
  const old = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
  if (old) pendingChallenges.delete(old);
  pendingChallenges.set(cid, {
    challenge: options.challenge,
    name,
    newAccount,
    accountId: account ? account.id : null,
    addCode: viaAddCode ? normalizeCode(req.body.addCode) : null,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });
  setChallengeCookie(res, cid);
  logEvent('challenge-issued', { challenge: options.challenge, name, account: newAccount ? `new:${newAccount.name}` : account.id });
  res.json(options);
});

// 2) 기기가 돌려준 공개키와 서명을 확인하고 저장
router.post('/register/verify', async (req, res) => {
  const entry = takeChallenge(req);
  logEvent('register-request-body', { body: req.body }); // 증거용: 서버가 실제로 받은 본문
  if (!entry) return res.status(400).json({ error: 'challenge-expired-or-used', message: '질문이 만료됐거나 이미 사용됐습니다. 처음부터 다시 시도하세요.' });

  const data = store.load();
  const u = currentUser(req);
  let authorized;
  if (entry.newAccount) authorized = !data.accounts.some((a) => a.name === entry.newAccount.name); // 초대 코드는 질문을 줄 때 확인했다
  else if (entry.addCode) authorized = addCodeValid(entry.addCode) && addCode.accountId === entry.accountId;
  else authorized = !!u && u.userId === entry.accountId;
  if (!authorized) return res.status(401).json({ error: 'unauthorized' });

  let result;
  try {
    result = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: entry.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch (e) {
    logEvent('register-rejected', { reason: 'verify-error', message: e.message });
    return res.status(400).json({ error: 'verify-failed', message: '등록을 확인하지 못했습니다.' });
  }
  if (!result.verified) return res.status(400).json({ error: 'verify-failed', message: '등록을 확인하지 못했습니다.' });

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = result.registrationInfo;
  if (data.credentials.some((c) => c.id === credential.id)) return res.status(409).json({ error: 'already-registered', message: '이미 등록된 패스키입니다.' });

  let accountId = entry.accountId;
  if (entry.newAccount) {
    accountId = store.newAccountId();
    data.accounts.push({
      id: accountId,
      userID: entry.newAccount.userID,
      name: entry.newAccount.name,
      createdAt: new Date().toISOString(),
      vault: store.seedVault(data.accounts.length === 0, entry.newAccount.name),
    });
    logEvent('account-created', { accountId, name: entry.newAccount.name });
  }

  const saved = {
    id: credential.id,
    accountId,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'), // 서버에 남는 것은 공개키뿐
    counter: credential.counter,
    transports: credential.transports || req.body?.response?.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    aaguid,
    name: entry.name,
    createdAt: new Date().toISOString(),
  };
  data.credentials.push(saved);
  store.save(data);
  logEvent('credential-stored', { credential: publicView(saved) });

  if (entry.addCode) addCode = null; // 일회용 코드는 성공하면 바로 폐기
  if (entry.newAccount || entry.addCode) startSession(res, accountId); // 새 계정을 만들었거나 일회용 코드로 추가한 기기는 그 계정으로 바로 들어간다
  res.json({ verified: true, credential: publicView(saved) });
});

// 등록을 중간에 취소: 보관하던 질문만 버린다. 저장되는 것은 없다.
router.post('/register/cancel', (req, res) => {
  const had = !!takeChallenge(req);
  logEvent('register-cancelled', { hadPendingChallenge: had });
  res.json({ cancelled: true });
});

// ---- 로그인 ----
const LOGIN_COOKIE = 'lchal';

// 1) 로그인용 질문 만들기: 요청할 때마다 새 값. 비밀번호 대신 이 질문에 서명해서 답한다.
router.post('/login/options', async (req, res) => {
  if (store.load().credentials.length === 0) return res.status(409).json({ error: 'no-passkey', message: '등록된 패스키가 없습니다.' });

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    // allowCredentials 를 비워 두면 기기가 이 사이트에 저장된 패스키를 스스로 찾는다.
    // (로그인 전에 누구에게나 패스키 ID 목록을 알려 주지 않기 위해)
  });

  const cid = crypto.randomBytes(16).toString('hex');
  const old = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
  if (old) pendingChallenges.delete(old);
  pendingChallenges.set(cid, { challenge: options.challenge, expires: Date.now() + CHALLENGE_TTL_MS });
  setChallengeCookie(res, cid, LOGIN_COOKIE, '/api/login');
  logEvent('login-challenge-issued', { challenge: options.challenge });
  res.json(options);
});

// 2) 기기가 서명한 답을 저장해 둔 공개키로 확인. 확인에 성공한 요청에게만 그 패스키 계정의 세션을 준다.
router.post('/login/verify', async (req, res) => {
  const entry = takeChallenge(req, LOGIN_COOKIE); // 한 번 꺼내면 폐기: 같은 답을 다시 보내도 통하지 않는다
  logEvent('login-request-body', { body: req.body });
  if (!entry) {
    logEvent('login-rejected', { reason: 'challenge-expired-or-used' });
    return res.status(400).json({ error: 'challenge-expired-or-used', message: '질문이 만료됐거나 이미 사용됐습니다. 처음부터 다시 시도하세요.' });
  }

  const data = store.load();
  const saved = data.credentials.find((c) => c.id === req.body?.id);
  if (!saved) {
    logEvent('login-rejected', { reason: 'unknown-credential' });
    return res.status(401).json({ error: 'unknown-credential', message: '이 서버에 등록된 패스키가 아닙니다.' });
  }

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: entry.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: { id: saved.id, publicKey: Buffer.from(saved.publicKey, 'base64url'), counter: saved.counter, transports: saved.transports },
    });
  } catch (e) {
    logEvent('login-rejected', { reason: 'verify-error', message: e.message });
    return res.status(401).json({ error: 'verify-failed', message: '서명을 확인하지 못했습니다.' });
  }
  if (!result.verified) {
    logEvent('login-rejected', { reason: 'not-verified' });
    return res.status(401).json({ error: 'verify-failed', message: '서명을 확인하지 못했습니다.' });
  }

  const account = data.accounts.find((a) => a.id === saved.accountId);
  // 기기가 알려 준 계정 표시(userHandle)가 그 패스키의 계정과 다르면 받지 않는다.
  if (!account || (req.body?.response?.userHandle && req.body.response.userHandle !== account.userID)) {
    logEvent('login-rejected', { reason: 'account-mismatch' });
    return res.status(401).json({ error: 'verify-failed', message: '서명을 확인하지 못했습니다.' });
  }

  saved.counter = result.authenticationInfo.newCounter;
  store.save(data);
  startSession(res, account.id); // 서명이 맞았을 때만 여기까지 온다. 세션에는 그 패스키의 계정이 들어간다.
  logEvent('login-success', { credentialId: saved.id, name: saved.name, accountId: account.id });
  res.json({ verified: true, name: saved.name, account: { id: account.id, name: account.name } });
});

// 등록된 패스키 목록(로그인한 사람만, 내 계정 것만)
router.get('/passkeys', requireLogin, (req, res) => {
  const me = currentUser(req).userId;
  res.set('Cache-Control', 'no-store');
  res.json({ passkeys: store.load().credentials.filter((c) => c.accountId === me).map(publicView), rpID: RP_ID });
});

// 다른 기기 추가용 일회용 코드 만들기(로그인한 사람만). 값은 응답으로만 주고 기록에는 남기지 않는다.
router.post('/passkeys/invite', requireLogin, (req, res) => {
  const code = mintAddCode(currentUser(req).userId);
  logEvent('add-code-issued', { expiresInSeconds: ADD_CODE_TTL_MS / 1000 });
  res.set('Cache-Control', 'no-store');
  res.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInSeconds: ADD_CODE_TTL_MS / 1000 });
});

// 패스키 지우기(로그인한 사람만, 내 계정 것만). 지우면 그 패스키로는 더 이상 로그인할 수 없다.
// 계정마다 마지막 하나는 지울 수 없다: 지우면 그 계정에 아무도 들어올 수 없게 되기 때문이다.
// (모든 기기를 잃은 경우의 복구는 서버 주인이 data/store.json 에서 그 계정을 지우고 초대 코드로 다시 만드는 것 — README 참고)
router.delete('/passkeys/:id', requireLogin, (req, res) => {
  const me = currentUser(req).userId;
  const data = store.load();
  // 내 계정의 패스키만 찾는다. 다른 계정의 패스키 ID를 보내도 "없음"으로 답한다.
  const i = data.credentials.findIndex((c) => c.id === req.params.id && c.accountId === me);
  if (i < 0) {
    logEvent('passkey-delete-refused', { reason: 'not-in-my-account', id: req.params.id, accountId: me });
    return res.status(404).json({ error: 'not-found', message: '내 계정에 그런 패스키가 없습니다.' });
  }
  const mine = data.credentials.filter((c) => c.accountId === me).length;
  if (mine <= 1) {
    logEvent('passkey-delete-refused', { reason: 'last-passkey', id: req.params.id, accountId: me });
    return res.status(409).json({ error: 'last-passkey', message: '마지막 패스키는 지울 수 없습니다. 지우면 아무도 들어올 수 없게 됩니다. 먼저 다른 패스키를 추가하세요.' });
  }
  const [removed] = data.credentials.splice(i, 1);
  store.save(data);
  logEvent('passkey-deleted', { id: removed.id, name: removed.name, accountId: me, remaining: mine - 1 });
  res.json({ deleted: true, name: removed.name, remaining: mine - 1 });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

module.exports = router;
