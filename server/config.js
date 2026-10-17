// 패스키는 "어느 사이트(RP ID)에서 만들었는지"에 묶인다. 배포할 때는 환경변수로 실제 도메인을 넣는다.
const crypto = require('crypto');

const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const RP_ID = process.env.RP_ID || new URL(ORIGIN).hostname;
const RP_NAME = '조경익 소개 페이지';

// 처음 패스키를 만들 때만 필요한 "초대 코드". 로그인 비밀번호가 아니다.
// 공개 사이트에서 아무나 먼저 등록해 주인 행세를 하지 못하게 막는 문지기이고,
// 패스키가 하나라도 등록되면 더 이상 쓰이지 않는다. 값은 저장소에 두지 않는다(환경변수).
const SETUP_CODE = process.env.SETUP_CODE || crypto.randomBytes(4).toString('hex');
const SETUP_CODE_IS_RANDOM = !process.env.SETUP_CODE;

module.exports = { ORIGIN, RP_ID, RP_NAME, SETUP_CODE, SETUP_CODE_IS_RANDOM };
