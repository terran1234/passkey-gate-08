const path = require('path');
const fs = require('fs');
const express = require('express');
const { requireLogin } = require('./session');

const app = express();
app.use(express.json());

// 공개 영역: public/ 안의 파일은 누구나 받는다. 비공개 내용은 이 폴더에 두지 않는다.
app.use(express.static(path.join(__dirname, '..', 'public')));

// 비공개 영역: 내용은 data/ 에만 있고, 로그인 뒤에만 응답으로 내려 간다.
app.get('/api/vault', requireLogin, (req, res) => {
  const vault = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'vault.json'), 'utf8'));
  res.set('Cache-Control', 'no-store');
  res.json(vault);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
