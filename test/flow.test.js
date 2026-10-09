// 실행: npm test   (임시 DB 사용. 체인 어댑터만 테스트용 스텁으로 교체 — 제품 코드에는 가짜 모드가 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `primebit-test-${Date.now()}.db`);

const { db, setSetting } = await import('../src/db.js');
const { createCharge, processDeposit, parseAmount, manualMatch, expireCharges } = await import('../src/services/charges.js');
const { makeQuote, placeOrder, confirmPending, refundOrder } = await import('../src/services/orders.js');
const { rates } = await import('../src/services/rates.js');
const { ensureUser } = await import('../src/services/points.js');
const { setAdapter, enabledCoins, walletReport } = await import('../src/services/wallet.js');
const { bus } = await import('../src/util.js');

// 테스트용 TRON 어댑터 스텁
let txState = { state: 'pending', detail: '블록 대기' };
const sent = [];
setAdapter('tron', {
  configured: true,
  address: () => 'TStubHotWalletAddress00000000000000',
  valid: (a) => /^T[A-Za-z0-9]{33}$/.test(a),
  balance: async () => 5000,
  gasBalance: async () => 500,
  send: async (coin, to, amount) => { sent.push({ coin, to, amount }); return 'txid-' + sent.length; },
  check: async () => txState,
});

rates.upbit.USDT = 1400;
rates.updatedAt = Date.now();
const U = '111';
const ADDR = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

test('금액 파싱: 잔액 숫자는 무시', () => {
  assert.equal(parseAmount('[KB]10/09 12:30 123456**789 홍길동 입금 100,000원 잔액 5,000,000원'), 100000);
  assert.equal(parseAmount('홍길동님이 50,000원을 보냈어요'), 50000);
});

test('충전 → 입금 알림 자동 매칭 → 포인트 지급 + DM 이벤트', () => {
  let done = null;
  bus.once('charge_done', (c) => (done = c));
  const c = createCharge(U, '홍길동', 100000);
  const r = processDeposit({ ts: 1, text: '[KB]10/09 12:30 홍길동 입금 100,000원 잔액 5,000,000원' });
  assert.equal(r.status, 'matched');
  assert.equal(done.id, c.id);
  assert.equal(ensureUser(U).points, 100000);
});

test('같은 알림 재전송 / 문자+푸시 중복은 지급되지 않음', () => {
  assert.equal(processDeposit({ ts: 1, text: '[KB]10/09 12:30 홍길동 입금 100,000원 잔액 5,000,000원' }).status, 'duplicate');
  assert.equal(processDeposit({ ts: 2, text: '홍길동님이 100,000원을 보냈어요' }).status, 'duplicate');
  assert.equal(ensureUser(U).points, 100000);
});

test('출금 알림 무시 / 이름 불일치는 미매칭 → 수동 매칭', () => {
  assert.equal(processDeposit({ ts: 3, text: '김철수 출금 30,000원 잔액 1,000원' }).status, 'ignored');
  createCharge('222', '이영희', 30000);
  const r = processDeposit({ ts: 4, text: '박민수 입금 30,000원 잔액 1,000원' });
  assert.equal(r.status, 'unmatched');
  manualMatch(r.depositId, db.prepare("SELECT id FROM charges WHERE discord_id='222'").get().id);
  assert.equal(ensureUser('222').points, 30000);
});

test('충전 만료 시 DM 이벤트 발생', () => {
  createCharge('333', '최만료', 10000);
  db.prepare("UPDATE charges SET created_at = created_at - 3600000 WHERE discord_id='333'").run();
  let expired = null;
  bus.once('charge_expired', (c) => (expired = c));
  expireCharges();
  assert.equal(expired.discord_id, '333');
});

test('견적: 100% 차감, 수수료 3%, 97%치만 코인 지급', () => {
  const q = makeQuote('USDT-TRC20', 100000);
  assert.equal(q.fee, 3000);
  assert.equal(q.net, 97000);
  assert.equal(q.coinAmount, Math.floor((97000 / 1400) * 1e6) / 1e6);
});

test('판매 중 코인: 키가 설정된 체인만, 관리자가 끄면 제외', () => {
  assert.deepEqual(enabledCoins().sort(), ['TRX', 'USDT-TRC20']);
  setSetting('disabled_coins', 'TRX');
  assert.deepEqual(enabledCoins(), ['USDT-TRC20']);
  setSetting('disabled_coins', '');
});

let orderId;
test('구매 → 포인트 차감 → 전송(confirming) → 블록 확정 후 done', async () => {
  let sentEv = null, doneEv = null;
  bus.once('order_sent', (o) => (sentEv = o));
  bus.once('order_done', (o) => (doneEv = o));
  const o = await placeOrder(U, 'USDT-TRC20', ADDR, makeQuote('USDT-TRC20', 100000));
  orderId = o.id;
  assert.equal(o.status, 'confirming');
  assert.equal(o.txid, 'txid-1');
  assert.equal(sent[0].amount, o.coin_amount);
  assert.ok(sentEv);
  assert.equal(ensureUser(U).points, 0);

  await confirmPending(); // 아직 블록 대기 → 상태 유지
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'confirming');
  assert.equal(doneEv, null);

  txState = { state: 'confirmed' };
  await confirmPending();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'done');
  assert.equal(doneEv.id, orderId);
});

test('포인트 부족 / 잘못된 주소 / 일일 한도 거부', async () => {
  await assert.rejects(() => placeOrder(U, 'USDT-TRC20', ADDR, makeQuote('USDT-TRC20', 50000)), /포인트/);
  await assert.rejects(() => placeOrder('222', 'USDT-TRC20', 'not-an-address', makeQuote('USDT-TRC20', 20000)), /주소/);
  setSetting('daily_limit_krw', '10000');
  await assert.rejects(() => placeOrder('222', 'USDT-TRC20', ADDR, makeQuote('USDT-TRC20', 20000)), /한도/);
  setSetting('daily_limit_krw', '5000000');
  assert.equal(ensureUser('222').points, 30000);
});

test('온체인 실패 → error, 관리자 환불 시 포인트 복구', async () => {
  txState = { state: 'pending' };
  const o = await placeOrder('222', 'USDT-TRC20', ADDR, makeQuote('USDT-TRC20', 20000));
  assert.equal(ensureUser('222').points, 10000);
  txState = { state: 'failed', detail: 'REVERT' };
  await confirmPending();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'error');
  refundOrder(o.id);
  assert.equal(ensureUser('222').points, 30000);
});

test('점검 모드에서는 충전/구매 차단', async () => {
  setSetting('maintenance', '1');
  assert.throws(() => createCharge('444', '정점검', 10000), /점검/);
  await assert.rejects(() => placeOrder(U, 'USDT-TRC20', ADDR, makeQuote('USDT-TRC20', 10000)), /점검/);
  setSetting('maintenance', '0');
});

test('관리자 지갑 리포트: 충전 주소·재고·보충 필요 수량', async () => {
  const rep = await walletReport();
  const tron = rep.find((c) => c.chain === 'tron');
  assert.equal(tron.address, 'TStubHotWalletAddress00000000000000');
  const usdt = tron.coins.find((c) => c.key === 'USDT-TRC20');
  assert.equal(usdt.stock, 5000);
  assert.equal(usdt.state, 'ok');
  assert.ok(usdt.needCoin > 0); // 목표 1천만원 대비 보충 필요
  assert.equal(rep.find((c) => c.chain === 'btc').configured, false);
});
