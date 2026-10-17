// 패스키 저장소: data/store.json (git에는 올리지 않는다).
// 여기에는 "공개키"만 들어간다. 개인키는 기기 안에만 있고 서버는 받은 적이 없다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'); // 시험할 때는 다른 폴더를 쓴다
const FILE = path.join(DIR, 'store.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // 주인은 한 명. userID는 패스키에 들어가는 임의 식별자(이름·이메일이 아님).
    return { owner: { userID: crypto.randomBytes(32).toString('base64url') }, credentials: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save };
