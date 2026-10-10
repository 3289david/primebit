import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { UserError, bus } from '../util.js';
import { config } from '../config.js';

const OCTOMO_URL = 'https://api.octoverse.kr/octomo/v1/public/message/exists';
const OCTOMO_TARGET = '1666-3538';

const pending = new Map(); // discord_id -> { mobileNum, code, exp }

export function startPhoneVerify(discordId, mobileNum) {
  mobileNum = String(mobileNum).replace(/[^0-9]/g, '');
  if (!/^010\d{8}$/.test(mobileNum)) throw new UserError('휴대폰 번호는 010으로 시작하는 11자리 숫자여야 합니다.');
  const code = String(crypto.randomInt(100000, 999999));
  const exp = now() + 5 * 60_000;
  pending.set(discordId, { mobileNum, code, exp });
  setTimeout(() => {
    const p = pending.get(discordId);
    if (p && p.code === code) pending.delete(discordId);
  }, 5 * 60_000 + 2000).unref();
  return { code, mobileNum, target: OCTOMO_TARGET };
}

export async function confirmPhoneVerify(discordId) {
  const p = pending.get(discordId);
  if (!p) throw new UserError('진행 중인 인증 요청이 없습니다. "본인인증" 버튼으로 다시 시작해주세요.');
  if (now() > p.exp) { pending.delete(discordId); throw new UserError('인증 시간이 만료되었습니다(5분). 다시 시도해주세요.'); }
  if (!config.octomoApiKey) throw new UserError('인증 서비스가 아직 설정되지 않았습니다. 관리자에게 문의하세요.');

  let res;
  try {
    res = await fetch(OCTOMO_URL, {
      method: 'POST',
      headers: { Authorization: `Octomo ${config.octomoApiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mobileNum: p.mobileNum, text: p.code, withinMinutes: 5 }),
    });
  } catch {
    throw new UserError('인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new UserError('인증 서비스 설정에 문제가 있습니다. 관리자에게 문의하세요.');
    if (res.status === 429) throw new UserError('요청이 많습니다. 잠시 후 다시 시도해주세요.');
    throw new UserError(e.message || '인증 확인 중 오류가 발생했습니다.');
  }
  const { exists } = await res.json();
  if (!exists) throw new UserError('아직 문자를 받지 못했습니다. 문자 전송 후 몇 초 뒤 다시 눌러주세요.');
  pending.delete(discordId);
  db.prepare('UPDATE users SET phone_verified=1, phone_number=? WHERE discord_id=?').run(p.mobileNum, discordId);
  return p.mobileNum;
}

export function submitKyc(discordId, { name, dob }, channelId) {
  name = String(name).trim();
  dob = String(dob).trim();
  if (name.length < 2 || name.length > 30) throw new UserError('실명을 정확히 입력해주세요.');
  if (!/^\d{6,8}$/.test(dob)) throw new UserError('생년월일은 숫자만 6~8자리로 입력해주세요 (예: 19900101).');
  db.prepare("UPDATE users SET kyc_status='pending', kyc_name=?, kyc_dob=?, kyc_memo=NULL, kyc_channel_id=?, kyc_submitted_at=? WHERE discord_id=?")
    .run(name, dob, channelId, now(), discordId);
}

export function reviewKyc(discordId, approve, memo, reviewerName) {
  const u = db.prepare('SELECT * FROM users WHERE discord_id=?').get(discordId);
  if (!u || u.kyc_status !== 'pending') throw new UserError('심사 대기 중인 KYC 신청이 아닙니다.');
  db.prepare('UPDATE users SET kyc_status=?, kyc_memo=?, kyc_reviewed_at=?, kyc_reviewer=? WHERE discord_id=?')
    .run(approve ? 'approved' : 'rejected', memo || null, now(), reviewerName, discordId);
  bus.emit('notify_user', {
    userId: discordId,
    content: approve
      ? '✅ KYC 인증이 승인되었습니다. 이제 충전/코인 구매를 이용하실 수 있습니다.'
      : `❌ KYC 인증이 반려되었습니다.${memo ? `\n사유: ${memo}` : ''}\n메인 패널의 "본인인증" 버튼으로 다시 제출해주세요.`,
  });
  bus.emit('kyc_reviewed', { discordId, approve, memo, reviewerName, name: u.kyc_name, channelId: u.kyc_channel_id });
  return u;
}
