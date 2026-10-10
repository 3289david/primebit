import { db, now, getSetting } from '../db.js';
import { UserError } from '../util.js';

export function ensureUser(id) {
  db.prepare('INSERT OR IGNORE INTO users(discord_id, created_at) VALUES(?,?)').run(id, now());
  return db.prepare('SELECT * FROM users WHERE discord_id=?').get(id);
}

/** 반드시 tx() 안에서 호출. 잔액이 음수가 되면 INSUFFICIENT */
export function addPoints(id, delta, reason, ref = null) {
  ensureUser(id);
  const r = db.prepare('UPDATE users SET points = points + ? WHERE discord_id=? AND points + ? >= 0').run(delta, id, delta);
  if (r.changes === 0) throw new UserError('포인트가 부족합니다.');
  db.prepare('INSERT INTO point_log(discord_id,delta,reason,ref,created_at) VALUES(?,?,?,?,?)').run(
    id, delta, reason, ref, Date.now(),
  );
}

/** 점검 모드면 충전/구매 차단 */
export function assertOpen() {
  if (getSetting('maintenance') === '1') throw new UserError(`🛠️ ${getSetting('maintenance_msg') || '점검 중입니다.'}`);
}

export function assertNotBanned(id) {
  const u = ensureUser(id);
  if (u.banned) throw new UserError('이용이 제한된 계정입니다. 문의 티켓을 열어주세요.');
  return u;
}

const kycKo = { none: '미제출', pending: '심사중', rejected: '반려' };

/** 휴대폰 본인인증 + KYC(관리자 승인) 완료된 유저만 충전/구매 가능 */
export function assertVerified(id) {
  const u = ensureUser(id);
  if (!u.phone_verified) throw new UserError('먼저 본인인증이 필요합니다. 메인 패널의 "본인인증" 버튼을 눌러주세요.');
  if (u.kyc_status !== 'approved')
    throw new UserError(`KYC 인증이 필요합니다 (현재 상태: ${kycKo[u.kyc_status] || u.kyc_status}). 메인 패널의 "본인인증" 버튼에서 증빙자료를 제출해주세요.`);
  return u;
}
