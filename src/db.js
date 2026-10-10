import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || 'data/primebit.db';
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  total_charged INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  raw TEXT NOT NULL,
  amount INTEGER,
  status TEXT NOT NULL,            -- matched | unmatched | duplicate | ignored
  charge_id INTEGER,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  depositor TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,            -- pending | done | expired | cancelled
  deposit_id INTEGER,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_charges_pending ON charges(status, amount);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  points_used INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  price REAL NOT NULL,
  coin_amount REAL NOT NULL,
  status TEXT NOT NULL,            -- sending | confirming | done | error | refunded
  txid TEXT,
  error TEXT,
  sent_at INTEGER,                 -- 네트워크에 전송한 시각 (확정 대기 시작)
  note TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE TABLE IF NOT EXISTS addresses (
  discord_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (discord_id, coin)
);
CREATE TABLE IF NOT EXISTS sell_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  amount REAL NOT NULL,
  bank_info TEXT NOT NULL,
  status TEXT NOT NULL,            -- open | done | rejected
  memo TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- open | closed
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS point_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  admin_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const now = () => Date.now();

/** 최상위에서만 호출 (중첩 불가). 에러 시 롤백 */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 이전 버전 DB 호환 (이미 있으면 무시)
for (const sql of [
  'ALTER TABLE orders ADD COLUMN sent_at INTEGER', 'ALTER TABLE orders ADD COLUMN note TEXT',
  // 본인인증(휴대폰) / KYC(신원 증빙, 관리자 수동 승인)
  'ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN phone_number TEXT',
  "ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'none'", // none | pending | approved | rejected
  'ALTER TABLE users ADD COLUMN kyc_name TEXT',
  'ALTER TABLE users ADD COLUMN kyc_dob TEXT',
  'ALTER TABLE users ADD COLUMN kyc_memo TEXT',
  'ALTER TABLE users ADD COLUMN kyc_channel_id TEXT',
  'ALTER TABLE users ADD COLUMN kyc_submitted_at INTEGER',
  'ALTER TABLE users ADD COLUMN kyc_reviewed_at INTEGER',
  'ALTER TABLE users ADD COLUMN kyc_reviewer TEXT',
]) {
  try { db.exec(sql); } catch { /* 이미 존재 */ }
}

export const DEFAULT_SETTINGS = {
  fee_rate: '0.03',          // 수수료 3%
  bank_name: '',
  bank_account: '',
  bank_holder: '',
  charge_min: '10000',
  charge_max: '3000000',
  buy_min: '10000',
  charge_expire_min: '30',
  stock_alert_krw: '300000',    // 코인별 재고 가치가 이 금액 미만이면 재고부족 알림
  stock_target_krw: '10000000', // 보충 권장 목표 재고 가치 (관리자 패널 '보충 필요 수량' 계산용)
  daily_limit_krw: '5000000',   // 1인 1일 구매 한도 (0 = 무제한)
  price_markup: '0',            // 시세 가산율 (0.00 = 업비트 시세 그대로)
  disabled_coins: '',           // 판매 중지 코인 (쉼표 구분) — 관리자 패널 재고/지갑 탭에서 토글
  maintenance: '0',             // 1 = 점검 중 (충전/구매 차단)
  maintenance_msg: '점검 중입니다. 잠시 후 이용해주세요.',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}

export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
export const numSetting = (k) => Number(getSetting(k));
