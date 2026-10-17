// AAGUID = "어떤 종류의 인증기가 만든 패스키인지" 알려 주는 값. 화면에 저장 위치를 보여 줄 때만 쓴다.
// 브라우저가 값을 가려서 0000...으로 올 수도 있고, 그러면 '알 수 없음'으로 표시한다.
const KNOWN = {
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 비밀번호 관리자',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome (Mac 기기)',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 키체인',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 키체인',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey 5 (보안 키)',
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5 (보안 키)',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5 (보안 키)',
};

function authenticatorName(aaguid) {
  return KNOWN[aaguid] || '알 수 없음';
}

module.exports = { authenticatorName };
