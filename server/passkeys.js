// 패스키 등록 · 목록 · 로그아웃 경로. (로그인은 카드 3에서 추가)
const crypto = require('crypto');
const express = require('express');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
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

function setChallengeCookie(res, id) {
  res.setHeader('Set-Cookie', `${CHALLENGE_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/api/register; Max-Age=${CHALLENGE_TTL_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function takeChallenge(req) {
  const id = parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
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

// 등록된 패스키 목록(로그인한 사람만)
router.get('/passkeys', requireLogin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ passkeys: store.load().credentials.map(publicView), rpID: RP_ID });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

module.exports = router;
