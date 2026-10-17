const path = require('path');
const fs = require('fs');
const express = require('express');
const { requireLogin } = require('./session');
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

// 비공개 영역: 내용은 data/ 에만 있고, 로그인 뒤에만 응답으로 내려 간다.
app.get('/api/vault', requireLogin, (req, res) => {
  const vault = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'vault.json'), 'utf8'));
  res.set('Cache-Control', 'no-store');
  res.json(vault);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server-error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${ORIGIN}  (RP ID: ${RP_ID})`);
  if (store.load().credentials.length === 0) {
    console.log(SETUP_CODE_IS_RANDOM
      ? `처음 등록용 초대 코드(이번 실행에만 유효): ${SETUP_CODE}`
      : '처음 등록용 초대 코드: 환경변수 SETUP_CODE 값');
  }
});
