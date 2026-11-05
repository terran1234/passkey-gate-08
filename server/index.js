const path = require('path');
const express = require('express');
const { requireLogin, currentUser } = require('./session');
const { logEvent } = require('./events');
const passkeys = require('./passkeys');
const store = require('./store');
const { SETUP_CODE, SETUP_CODE_IS_RANDOM, ORIGIN, RP_ID } = require('./config');

const app = express();
app.set('trust proxy', 1); // 배포 환경(프록시 뒤)에서 실제 접속 주소를 보기 위함
app.use(express.json({ limit: '50kb' }));

// 공개 영역: public/ 안의 파일은 누구나 받는다. 비공개 내용은 이 폴더에 두지 않는다.
app.use(express.static(path.join(__dirname, '..', 'public')));
// 브라우저용 패스키 라이브러리(공개 코드). 서버 코드나 데이터가 아니다.
app.get('/vendor/simplewebauthn-browser.js', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js')));

app.use('/api', passkeys);

// 비공개 영역: 내용은 서버의 data/store.json 에만 있고, 로그인 뒤에만 "내 계정 것"이 응답으로 내려 간다.
// 어느 계정 자료를 줄지는 요청에 적힌 값(주소·본문)이 아니라 세션에 들어 있는 계정으로만 정한다.
function myAccount(req) {
  const me = currentUser(req).userId;
  return { me, data: store.load() };
}
function vaultView(acc) {
  return { account: { id: acc.id, name: acc.name }, items: acc.vault };
}

// 내 비공개 자료. 주소에 ?account=다른계정 을 붙여도 무시하고 내 것만 준다.
app.get('/api/vault', requireLogin, (req, res) => {
  const { me, data } = myAccount(req);
  const acc = data.accounts.find((a) => a.id === me);
  if (Object.keys(req.query).length) logEvent('vault-query-ignored', { accountId: me, query: req.query });
  res.set('Cache-Control', 'no-store');
  res.json(vaultView(acc));
});

// 계정을 주소에 적어 비공개 자료를 달라는 요청. 내 계정이 아니면 403으로 거절한다.
app.get('/api/accounts/:accountId/vault', requireLogin, (req, res) => {
  const { me, data } = myAccount(req);
  res.set('Cache-Control', 'no-store');
  if (req.params.accountId !== me) {
    logEvent('vault-forbidden', { accountId: me, requested: req.params.accountId });
    return res.status(403).json({ error: 'forbidden', message: '다른 계정의 비공개 자료는 볼 수 없습니다.' });
  }
  res.json(vaultView(data.accounts.find((a) => a.id === me)));
});

// 내 비공개 자리에 메모 더하기. 본문에 accountId 를 적어 보내도 무시하고 내 계정에만 넣는다.
app.post('/api/vault', requireLogin, (req, res) => {
  const { me, data } = myAccount(req);
  const acc = data.accounts.find((a) => a.id === me);
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title || title.length > 60 || body.length > 300) return res.status(400).json({ error: 'bad-item', message: '제목은 1~60자, 내용은 300자까지 적어 주세요.' });
  if (acc.vault.length >= 20) return res.status(409).json({ error: 'too-many-items', message: '메모는 20개까지 넣을 수 있습니다.' });
  if (req.body?.accountId !== undefined) logEvent('vault-body-account-ignored', { accountId: me, sent: req.body.accountId });
  acc.vault.push({ kind: '메모', title, body });
  store.save(data);
  logEvent('vault-item-added', { accountId: me, count: acc.vault.length });
  res.json(vaultView(acc));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server-error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${ORIGIN}  (RP ID: ${RP_ID})`);
  console.log(SETUP_CODE_IS_RANDOM
    ? `새 계정용 초대 코드(이번 실행에만 유효): ${SETUP_CODE}`
    : '새 계정용 초대 코드: 환경변수 SETUP_CODE 값');
});
