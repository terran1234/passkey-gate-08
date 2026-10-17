// 증거용 기록: 서버가 발급한 질문, 받은 요청 본문, 저장한 값을 한 줄씩 남긴다. (data/events.jsonl, git 제외)
// 요청 본문에는 공개키와 서명만 있고 개인키·비밀값은 없다. 세션 토큰과 초대 코드는 기록하지 않는다.
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'events.jsonl');

function logEvent(type, detail = {}) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), type, ...detail }) + '\n');
}

module.exports = { logEvent };
