// 세션: 서버가 기억하는 "로그인한 브라우저" 목록. 사람을 알아보는 방법은 이 세션이다.
// - 패스키 서명 확인(또는 첫 등록)에 성공했을 때만 startSession()이 무작위 토큰을 만들어 쿠키(sid)로 준다.
// - 토큰은 서버 메모리의 Map에 있고, 쿠키는 HttpOnly(화면 스크립트가 못 읽음) + SameSite=Strict 이다.
// - 로그아웃하면 Map에서 지워져서, 같은 쿠키 값을 다시 보내도 401이다.
const crypto = require('crypto');

const sessions = new Map(); // token -> { userId, createdAt }
const COOKIE = 'sid';

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8시간 뒤에는 다시 패스키로 들어와야 한다

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const s = token ? sessions.get(token) : null;
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return s;
}

// 비공개 경로의 문지기: 로그인하지 않았으면 401로 거절한다.
function requireLogin(req, res, next) {
  if (!currentUser(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

module.exports = { parseCookies, startSession, endSession, currentUser, requireLogin };
