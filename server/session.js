// 세션: 패스키 로그인에 성공한 브라우저에만 발급되는 무작위 토큰.
// 카드 2에서 로그인 성공 시 startSession()을 호출한다. 지금은 아무도 호출하지 않으므로 모두 비로그인 상태다.
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

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return token ? sessions.get(token) || null : null;
}

// 비공개 경로의 문지기: 로그인하지 않았으면 401로 거절한다.
function requireLogin(req, res, next) {
  if (!currentUser(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

module.exports = { parseCookies, startSession, endSession, currentUser, requireLogin };
