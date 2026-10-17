// 패스키 등록 · 목록 · 로그아웃 경로. (로그인은 카드 3에서 추가)
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
// 서버가 낸 등록용 질문을 확인할 때까지 보관하는 곳. 한 번 꺼내 쓰면 바로 지운다(재사용 불가).
const pendingChallenges = new Map(); // cookie id -> { challenge, name, setupOk, expires }

// 초대 코드 무차별 대입 방지: 한 주소에서 5번 틀리면 10분 동안 막는다.
const setupFails = new Map(); // ip -> { count, until }

function codeMatches(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(SETUP_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicView(c) {
  return {
    id: c.id,
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

// 화면이 어떤 모습을 보여 줄지 정하는 값. 공개 정보(등록 여부·로그인 여부)만 알려 준다.
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ registered: store.load().credentials.length > 0, loggedIn: !!currentUser(req) });
});

// 1) 등록용 질문(challenge) 만들기
router.post('/register/options', async (req, res) => {
  const data = store.load();
  const first = data.credentials.length === 0;
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name-required', message: '패스키 이름은 1~40자로 적어 주세요.' });

  if (first) {
    const f = setupFails.get(req.ip);
    if (f && f.until > Date.now()) return res.status(429).json({ error: 'too-many-attempts', message: '초대 코드를 너무 많이 틀렸습니다. 잠시 뒤에 다시 시도하세요.' });
    if (!codeMatches(req.body?.setupCode)) {
      const n = (f?.count || 0) + 1;
      setupFails.set(req.ip, { count: n, until: n >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
      logEvent('register-rejected', { reason: 'bad-setup-code' });
      return res.status(403).json({ error: 'bad-setup-code', message: '초대 코드가 맞지 않습니다.' });
    }
    setupFails.delete(req.ip);
  } else if (!currentUser(req)) {
    // 이미 주인의 패스키가 있으면, 로그인한 사람만 새 패스키를 더할 수 있다.
    return res.status(401).json({ error: 'unauthorized', message: '패스키를 더하려면 먼저 로그인해야 합니다.' });
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: 'owner',
    userDisplayName: '소개 페이지 주인',
    userID: Buffer.from(data.owner.userID, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })), // 같은 기기로 두 번 등록 방지
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  const cid = crypto.randomBytes(16).toString('hex');
  const old = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
  if (old) pendingChallenges.delete(old);
  pendingChallenges.set(cid, { challenge: options.challenge, name, setupOk: first, expires: Date.now() + CHALLENGE_TTL_MS });
  setChallengeCookie(res, cid);
  logEvent('challenge-issued', { challenge: options.challenge, name });
  res.json(options);
});

// 2) 기기가 돌려준 공개키와 서명을 확인하고 저장
router.post('/register/verify', async (req, res) => {
  const entry = takeChallenge(req);
  logEvent('register-request-body', { body: req.body }); // 증거용: 서버가 실제로 받은 본문
  if (!entry) return res.status(400).json({ error: 'challenge-expired-or-used', message: '질문이 만료됐거나 이미 사용됐습니다. 처음부터 다시 시도하세요.' });

  const data = store.load();
  const first = data.credentials.length === 0;
  if (first ? !entry.setupOk : !currentUser(req)) return res.status(401).json({ error: 'unauthorized' });

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

  const saved = {
    id: credential.id,
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

  if (!currentUser(req)) startSession(res, 'owner'); // 처음 등록한 사람은 바로 들어간다
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

// 2) 기기가 서명한 답을 저장해 둔 공개키로 확인. 확인에 성공한 요청에게만 세션을 준다.
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

  saved.counter = result.authenticationInfo.newCounter;
  store.save(data);
  startSession(res, 'owner'); // 서명이 맞았을 때만 여기까지 온다
  logEvent('login-success', { credentialId: saved.id, name: saved.name });
  res.json({ verified: true, name: saved.name });
});

// 등록된 패스키 목록(로그인한 사람만)
router.get('/passkeys', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ passkeys: store.load().credentials.map(publicView), rpID: RP_ID });
});

// 패스키 지우기(로그인한 사람만). 지우면 그 패스키로는 더 이상 로그인할 수 없다.
// 마지막 하나는 지울 수 없다: 지우면 아무도 들어올 수 없게 되기 때문이다.
// (모든 기기를 잃은 경우의 복구는 서버 주인이 data/store.json 을 지워 초대 코드 등록을 다시 여는 것 — README 참고)
router.delete('/passkeys/:id', requireLogin, (req, res) => {
  const data = store.load();
  const i = data.credentials.findIndex((c) => c.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not-found', message: '그런 패스키가 없습니다.' });
  if (data.credentials.length <= 1) {
    logEvent('passkey-delete-refused', { reason: 'last-passkey', id: req.params.id });
    return res.status(409).json({ error: 'last-passkey', message: '마지막 패스키는 지울 수 없습니다. 지우면 아무도 들어올 수 없게 됩니다. 먼저 다른 패스키를 추가하세요.' });
  }
  const [removed] = data.credentials.splice(i, 1);
  store.save(data);
  logEvent('passkey-deleted', { id: removed.id, name: removed.name, remaining: data.credentials.length });
  res.json({ deleted: true, name: removed.name, remaining: data.credentials.length });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

module.exports = router;
