import { db, tx, now, numSetting } from '../db.js';
import { COINS } from '../config.js';
import { addPoints, assertNotBanned, assertOpen, assertVerified } from './points.js';
import { getPrice } from './rates.js';
import { getStock, isValidAddress, isOwnAddress, isEnabled, sendCoin, checkTx } from './wallet.js';
import { UserError, bus } from '../util.js';

const KST = 9 * 3600_000;
const startOfKstDay = () => Math.floor((Date.now() + KST) / 86_400_000) * 86_400_000 - KST;

/** 포인트 전액(100%) 사용 → 수수료 3% 공제 → 나머지 97%로 코인 산정 */
export function makeQuote(coin, points) {
  const c = COINS[coin];
  if (!c) throw new UserError('지원하지 않는 코인입니다.');
  const min = numSetting('buy_min');
  if (!Number.isInteger(points) || points < min) throw new UserError(`최소 구매 포인트는 ${min.toLocaleString()}P 입니다.`);
  const price = getPrice(coin);
  const feeRate = numSetting('fee_rate');
  const fee = Math.floor(points * feeRate);
  const net = points - fee;
  const f = 10 ** c.dp;
  const coinAmount = Math.floor((net / price) * f) / f;
  if (coinAmount < c.minAmount) throw new UserError(`최소 구매 수량은 ${c.minAmount} ${c.symbol} 입니다.`);
  return { coin, points, fee, feeRate, net, price, coinAmount };
}

/** 견적 단계 사전 검증 (확정 전에 걸러서 사용자가 헛수고하지 않도록) */
export async function precheckBuy(userId, coin, address, points) {
  assertOpen();
  assertNotBanned(userId);
  assertVerified(userId);
  if (!isEnabled(coin)) throw new UserError('현재 판매하지 않는 코인입니다.');
  address = String(address).trim();
  if (!isValidAddress(coin, address)) throw new UserError(`올바른 ${COINS[coin].label.split('·').at(-1).trim()} 지갑 주소가 아닙니다. 네트워크를 다시 확인해주세요.`);
  if (isOwnAddress(coin, address)) throw new UserError('사용할 수 없는 주소입니다.');
  const quote = makeQuote(coin, points);
  const stock = await getStock();
  if ((stock[coin] ?? 0) < quote.coinAmount) throw new UserError('현재 재고가 부족합니다. 재고 현황을 확인해주세요.');
  return { quote, address };
}

export async function placeOrder(userId, coin, address, quote) {
  const { address: addr } = await precheckBuy(userId, coin, address, quote.points);
  const limit = numSetting('daily_limit_krw');

  const id = tx(() => {
    if (limit > 0) {
      const used = db
        .prepare("SELECT COALESCE(SUM(points_used),0) s FROM orders WHERE discord_id=? AND status!='refunded' AND created_at>=?")
        .get(userId, startOfKstDay()).s;
      if (used + quote.points > limit)
        throw new UserError(`1일 구매 한도(${limit.toLocaleString()}원)를 초과합니다. (오늘 사용 ${used.toLocaleString()}P)`);
    }
    addPoints(userId, -quote.points, 'order', 'pending');
    db.prepare('UPDATE users SET total_spent = total_spent + ? WHERE discord_id=?').run(quote.points, userId);
    const r = db
      .prepare(
        `INSERT INTO orders(discord_id,coin,address,points_used,fee,price,coin_amount,status,created_at)
         VALUES(?,?,?,?,?,?,?,'sending',?)`,
      )
      .run(userId, coin, addr, quote.points, quote.fee, quote.price, quote.coinAmount, now());
    const oid = Number(r.lastInsertRowid);
    db.prepare("UPDATE point_log SET ref=? WHERE id=(SELECT MAX(id) FROM point_log WHERE discord_id=? AND reason='order')").run(`order:${oid}`, userId);
    db.prepare(
      'INSERT INTO addresses(discord_id,coin,address,last_used) VALUES(?,?,?,?) ON CONFLICT(discord_id,coin) DO UPDATE SET address=excluded.address,last_used=excluded.last_used',
    ).run(userId, coin, addr, now());
    return oid;
  });
  return executeOrder(id);
}

/**
 * 온체인 전송. 성공하면 'confirming'(전송됨, 블록 확정 대기) → confirmLoop 가 'done' 으로 전환.
 * 실패 시 포인트는 건드리지 않고 'error' 로 남겨 관리자가 확인/재시도/환불.
 */
export async function executeOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw new UserError('주문이 없습니다.');
  db.prepare("UPDATE orders SET status='sending', error=NULL, note=NULL WHERE id=?").run(id);
  try {
    const txid = await sendCoin(o.coin, o.address, o.coin_amount);
    db.prepare("UPDATE orders SET status='confirming', txid=?, sent_at=? WHERE id=?").run(String(txid), now(), id);
    const sent = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    bus.emit('order_sent', sent);
    return sent;
  } catch (e) {
    console.error('[order]', id, e);
    db.prepare("UPDATE orders SET status='error', error=? WHERE id=?").run(String(e.message || e).slice(0, 500), id);
    const failed = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    bus.emit('order_error', failed);
    return failed;
  }
}

const STUCK_MS = 90 * 60_000;
let confirming = false;

/** 전송된 주문의 블록 확정 여부 확인 (15초마다) */
export async function confirmPending() {
  if (confirming) return;
  confirming = true;
  try {
    const rows = db.prepare("SELECT * FROM orders WHERE status='confirming' ORDER BY id").all();
    for (const o of rows) {
      try {
        const age = Date.now() - (o.sent_at || o.created_at);
        const r = await checkTx(o.coin, o.txid, age);
        if (r.state === 'confirmed') {
          db.prepare("UPDATE orders SET status='done', done_at=?, note=NULL WHERE id=? AND status='confirming'").run(now(), o.id);
          bus.emit('order_done', db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
        } else if (r.state === 'failed') {
          db.prepare("UPDATE orders SET status='error', error=? WHERE id=? AND status='confirming'")
            .run(`온체인 실패(${r.detail}) — 블록 탐색기에서 미전송 확인 후 재전송/환불`, o.id);
          bus.emit('order_error', db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
        } else {
          db.prepare('UPDATE orders SET note=? WHERE id=?').run(r.detail || null, o.id);
          if (age > STUCK_MS && o.note !== 'stuck-alerted') {
            db.prepare("UPDATE orders SET note='stuck-alerted' WHERE id=?").run(o.id);
            bus.emit('order_stuck', o);
          }
        }
      } catch (e) {
        console.error('[confirm]', o.id, e.message); // 일시적 RPC 오류 → 다음 주기에 재시도
      }
    }
  } finally {
    confirming = false;
  }
}

export const startConfirmLoop = () => setInterval(() => confirmPending().catch(console.error), 15_000);

/** 실패 주문 환불 (온체인 미전송 확인 후) */
export function refundOrder(id) {
  const o = tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!order || order.status !== 'error') throw new UserError('환불 가능한 상태(error)가 아닙니다.');
    db.prepare("UPDATE orders SET status='refunded', done_at=? WHERE id=?").run(now(), id);
    addPoints(order.discord_id, order.points_used, 'refund', `order:${id}`);
    db.prepare('UPDATE users SET total_spent = total_spent - ? WHERE discord_id=?').run(order.points_used, order.discord_id);
    return order;
  });
  bus.emit('notify_user', { userId: o.discord_id, content: `주문 #${id} 이(가) 환불되었습니다. +${o.points_used.toLocaleString()}P` });
}

/** 재시작으로 중단된 'sending' 주문 표시 ('confirming' 은 그대로 이어서 추적) */
export function recoverStuckOrders() {
  db.prepare(
    "UPDATE orders SET status='error', error='서버 재시작으로 중단됨 - 온체인 전송 여부 확인 필요' WHERE status='sending'",
  ).run();
}
