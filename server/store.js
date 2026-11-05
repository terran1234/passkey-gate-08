// 패스키 저장소: data/store.json (git에는 올리지 않는다).
// 계정 여러 개를 담는다. 패스키에는 "공개키"만 들어간다. 개인키는 기기 안에만 있고 서버는 받은 적이 없다.
//   accounts:    [{ id, userID, name, createdAt, vault: [ {kind,title,body} ] }]
//   credentials: [{ id, accountId, publicKey, counter, ... }]   ← 패스키마다 어느 계정 것인지 적혀 있다
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'); // 시험할 때는 다른 폴더를 쓴다
const FILE = path.join(DIR, 'store.json');

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { accounts: [], credentials: [] };
  }
  // 예전 형식(주인 한 명)이면 계정 하나짜리로 바꿔 읽는다.
  if (!data.accounts) {
    const id = newAccountId();
    data = {
      accounts: [{ id, userID: data.owner.userID, name: '주인', createdAt: new Date().toISOString(), vault: seedVault(true) }],
      credentials: (data.credentials || []).map((c) => ({ ...c, accountId: id })),
    };
  }
  return data;
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

const newAccountId = () => 'acc_' + crypto.randomBytes(4).toString('hex');

// 계정을 처음 만들 때 넣어 두는 예시 자료. 첫 계정은 data/vault.json 의 예시 3개, 그 뒤 계정은 계정 이름이 들어간 예시 1개.
// 모두 만들어 넣은 내용이고 실제 개인정보가 아니다.
function seedVault(first, accountName) {
  if (first) return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'vault.json'), 'utf8')).items;
  return [{ kind: '메모', title: `(예시) ${accountName} 계정의 첫 메모`, body: `이 메모는 "${accountName}" 계정에만 있습니다. 만들어 넣은 예시 내용입니다.` }];
}

module.exports = { load, save, newAccountId, seedVault };
