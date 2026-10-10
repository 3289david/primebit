import crypto from 'node:crypto';
import { db, tx, now, numSetting } from '../db.js';
import { addPoints, assertNotBanned, assertOpen, assertVerified } from './points.js';
import { UserError, bus } from '../util.js';

export function createCharge(userId, depositor, amount) {
  assertOpen();
  assertNotBanned(userId);
  assertVerified(userId);
  const min = numSetting('charge_min');
  const max = numSetting('charge_max');
  depositor = String(depositor).trim().replace(/\s+/g, '');
  if (depositor.length < 2 || depositor.length > 20) throw new UserError('입금자명을 정확히 입력해주세요.');
  if (!Number.isInteger(amount) || amount < min || amount > max)
    throw new UserError(`충전 금액은 ${min.toLocaleString()}원 ~ ${max.toLocaleString()}원 사이여야 합니다.`);
  return tx(() => {
    db.prepare("UPDATE charges SET status='cancelled' WHERE discord_id=? AND status='pending'").run(userId);
    const r = db
      .prepare("INSERT INTO charges(discord_id,depositor,amount,status,created_at) VALUES(?,?,?,'pending',?)")
      .run(userId, depositor, amount, now());
    return db.prepare('SELECT * FROM charges WHERE id=?').get(r.lastInsertRowid);
  });
}

export function cancelCharge(chargeId, userId = null) {
  const r = db
    .prepare("UPDATE charges SET status='cancelled' WHERE id=? AND status='pending' AND (? IS NULL OR discord_id=?)")
    .run(chargeId, userId, userId);
  return r.changes > 0;
}

/** 만료 처리 */
export function expireCharges() {
  const cutoff = now() - numSetting('charge_expire_min') * 60_000;
  const rows = db.prepare("SELECT * FROM charges WHERE status='pending' AND created_at < ?").all(cutoff);
  for (const c of rows) {
    if (db.prepare("UPDATE charges SET status='expired' WHERE id=? AND status='pending'").run(c.id).changes) bus.emit('charge_expired', c);
  }
}

const norm = (s) => String(s).replace(/\s+/g, '');

/** 문자/푸시 본문에서 입금액 추출 ('잔액' 이후 숫자는 무시) */
export function parseAmount(text) {
  const head = text.split(/잔액|잔고/)[0];
  const m = head.match(/([\d]{1,3}(?:,\d{3})+|\d+)\s*원/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** 충전을 완료 처리하고 포인트 지급 (tx 내부 전용) */
function completeChargeTx(charge, depositId) {
  const r = db
    .prepare("UPDATE charges SET status='done', done_at=?, deposit_id=? WHERE id=? AND status IN ('pending','expired')")
    .run(now(), depositId, charge.id);
  if (r.changes === 0) throw new UserError('이미 처리되었거나 취소된 충전 요청입니다.');
  addPoints(charge.discord_id, charge.amount, 'charge', `charge:${charge.id}`);
  db.prepare('UPDATE users SET total_charged = total_charged + ? WHERE discord_id=?').run(charge.amount, charge.discord_id);
  db.prepare("UPDATE deposits SET status='matched', charge_id=? WHERE id=?").run(charge.id, depositId);
}

/** 안드로이드 앱에서 올라온 입금 알림 처리 */
export function processDeposit({ deviceId = 'dev', ts, text }) {
  text = String(text || '').slice(0, 1000);
  const incoming = /입금|보냈어요|이체/.test(text);
  const outgoing = /출금|결제|승인/.test(text) && !/입금/.test(text);
  const hash = crypto.createHash('sha256').update(`${deviceId}|${ts}|${text}`).digest('hex');
  if (!incoming || outgoing) return { status: 'ignored' };

  const amount = parseAmount(text);
  const result = tx(() => {
    let dep;
    try {
      dep = db
        .prepare("INSERT INTO deposits(hash,raw,amount,status,received_at) VALUES(?,?,?,'unmatched',?)")
        .run(hash, text, amount, now());
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return { status: 'duplicate' };
      throw e;
    }
    const depositId = Number(dep.lastInsertRowid);
    if (!amount) return { status: 'unmatched', depositId };

    const cutoff = now() - numSetting('charge_expire_min') * 60_000;
    const pending = db
      .prepare("SELECT * FROM charges WHERE status='pending' AND amount=? AND created_at>=? ORDER BY id")
      .all(amount, cutoff);
    const hit = pending.find((c) => norm(text).includes(norm(c.depositor)));
    if (hit) {
      completeChargeTx(hit, depositId);
      return { status: 'matched', depositId, charge: hit };
    }
    // 같은 입금이 문자+푸시로 두 번 온 경우
    const recent = db
      .prepare("SELECT * FROM charges WHERE status='done' AND amount=? AND done_at>=?")
      .all(amount, now() - 3 * 60_000);
    if (recent.some((c) => norm(text).includes(norm(c.depositor)))) {
      db.prepare("UPDATE deposits SET status='duplicate' WHERE id=?").run(depositId);
      return { status: 'duplicate', depositId };
    }
    return { status: 'unmatched', depositId };
  });

  if (result.status === 'matched') bus.emit('charge_done', result.charge);
  if (result.status === 'unmatched') bus.emit('deposit_unmatched', { id: result.depositId, text, amount });
  return result;
}

/** 관리자 수동 매칭 */
export function manualMatch(depositId, chargeId) {
  const charge = tx(() => {
    const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(depositId);
    const ch = db.prepare('SELECT * FROM charges WHERE id=?').get(chargeId);
    if (!dep || !ch) throw new UserError('존재하지 않는 항목입니다.');
    if (dep.status === 'matched') throw new UserError('이미 매칭된 입금입니다.');
    completeChargeTx(ch, depositId);
    return ch;
  });
  bus.emit('charge_done', charge);
  return charge;
}
