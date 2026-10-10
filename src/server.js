import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, BRAND } from './config.js';
import { makeToken, readToken, getCookie, authorizeUrl, fetchDiscordUser, isAdminUser, SESSION_TTL } from './auth.js';
import { db, tx, now, DEFAULT_SETTINGS, getSetting, setSetting } from './db.js';
import { processDeposit, manualMatch, cancelCharge } from './services/charges.js';
import { executeOrder, refundOrder } from './services/orders.js';
import { addPoints } from './services/points.js';
import { getStock, walletReport, explorerUrl, enabledCoins } from './services/wallet.js';
import { rates, priceOf } from './services/rates.js';
import { reviewKyc } from './services/verify.js';
import { COINS } from './config.js';
import { UserError, bus } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function startServer() {
  for (const k of ['sessionSecret', 'deviceSecret']) {
    if (!config[k]) throw new Error(`.env 의 ${k} 값이 비어 있습니다. (.env.example 참고)`);
  }
  // OAuth 설정이 없으면 관리자 로그인을 열지 않음(잠금 상태 유지) — 서버는 계속 실행
  const oauthReady = !!(config.clientId && config.clientSecret && (config.adminIds.length || config.adminRoleId));
  if (!oauthReady) console.warn('⚠️  관리자 로그인 비활성: DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / ADMIN_DISCORD_IDS 를 설정하세요.');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Caddy/Nginx/Cloudflare 뒤에서 실제 IP 사용
  app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => (req.rawBody = buf) }));

  // ── 안드로이드 입금 알림 수신 ──
  // 헤더: X-Timestamp, X-Signature = HMAC_SHA256(DEVICE_SECRET, `${timestamp}.${rawBody}`)
  app.post('/api/deposit', (req, res) => {
    const ts = Number(req.get('X-Timestamp'));
    const sig = req.get('X-Signature') || '';
    if (!ts || Math.abs(Date.now() - ts) > 5 * 60_000) return res.status(401).json({ ok: false, error: 'stale' });
    const expect = hmac(config.deviceSecret, `${ts}.${req.rawBody?.toString('utf8')}`);
    if (!safeEq(sig, expect)) return res.status(401).json({ ok: false, error: 'bad signature' });
    try {
      const { text, ts: evTs, device } = req.body || {};
      const r = processDeposit({ deviceId: device || 'dev', ts: evTs, text });
      res.json({ ok: true, status: r.status });
    } catch (e) {
      console.error('[deposit]', e);
      res.status(500).json({ ok: false });
    }
  });

  // ── 관리자 인증: 디스코드 OAuth2 (비밀번호 로그인 없음) ──
  const secure = config.publicUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'lax', path: '/' }; // OAuth 리다이렉트 복귀를 위해 lax
  const loginFail = (res, msg) => res.redirect(`/admin?error=${encodeURIComponent(msg)}`);

  app.get('/admin/login/discord', (_req, res) => {
    if (!oauthReady) return loginFail(res, '디스코드 OAuth 가 설정되지 않았습니다. .env 를 확인하세요.');
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', makeToken({ nonce }, 10 * 60_000), { ...cookieOpts, maxAge: 10 * 60_000 });
    res.redirect(authorizeUrl(nonce));
  });

  const attempts = new Map(); // 로그인 시도 제한 (IP당 15분 10회)
  app.get('/admin/callback', async (req, res) => {
    res.clearCookie('oauth_state', cookieOpts);
    const a = attempts.get(req.ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60_000) { a.n = 0; a.t = Date.now(); }
    attempts.set(req.ip, a);
    if (++a.n > 10) return loginFail(res, '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.');
    try {
      const st = readToken(getCookie(req, 'oauth_state'));
      if (!st || !req.query.state || !safeEq(st.nonce, req.query.state)) return loginFail(res, '인증 상태가 올바르지 않습니다. 다시 로그인하세요.');
      if (!req.query.code) return loginFail(res, '로그인이 취소되었습니다.');
      const user = await fetchDiscordUser(String(req.query.code));
      if (!(await isAdminUser(user.id))) {
        console.warn(`[admin] 접근 거부: ${user.username} (${user.id})`);
        bus.emit('admin_login_denied', { id: user.id, name: user.username, ip: req.ip });
        return loginFail(res, '관리자 권한이 없는 계정입니다.');
      }
      db.prepare('INSERT INTO audit(admin_id,admin_name,action,detail,created_at) VALUES(?,?,?,?,?)').run(user.id, user.username, 'login', req.ip, Date.now());
      bus.emit('admin_login', { id: user.id, name: user.username, ip: req.ip });
      res.cookie('adm', makeToken({ id: user.id, name: user.username }, SESSION_TTL), { ...cookieOpts, maxAge: SESSION_TTL });
      res.redirect('/admin');
    } catch (e) {
      console.error('[oauth]', e.message);
      loginFail(res, '디스코드 로그인 처리 중 오류가 발생했습니다.');
    }
  });
  app.post('/admin/logout', (_req, res) => { res.clearCookie('adm', cookieOpts); res.json({ ok: true }); });
  const adminHtmlPath = path.join(here, '..', 'admin', 'index.html');
  app.get('/admin', (_req, res) => res.type('html').send(fs.readFileSync(adminHtmlPath, 'utf8').replaceAll('{{BRAND}}', BRAND)));

  const auth = (req, res, next) => {
    const s = readToken(getCookie(req, 'adm'));
    if (!s) return res.status(401).json({ error: 'unauthorized' });
    // 상태 변경 요청은 같은 출처에서만 (CSRF 방어)
    if (req.method !== 'GET' && req.get('origin') && req.get('origin') !== config.publicUrl && !/^https?:\/\/localhost(:\d+)?$/.test(req.get('origin')))
      return res.status(403).json({ error: 'bad origin' });
    req.admin = s;
    if (req.method !== 'GET') {
      const body = JSON.stringify(req.body ?? {}).slice(0, 300);
      db.prepare('INSERT INTO audit(admin_id,admin_name,action,detail,created_at) VALUES(?,?,?,?,?)').run(s.id, s.name, `${req.method} ${req.originalUrl}`, body, Date.now());
    }
    next();
  };

  const api = express.Router();
  api.use(auth);
  api.get('/me', (req, res) => res.json({ id: req.admin.id, name: req.admin.name }));
  const wrap = (fn) => async (req, res) => {
    try { res.json((await fn(req)) ?? { ok: true }); }
    catch (e) {
      if (!(e instanceof UserError)) console.error('[admin]', e);
      res.status(e instanceof UserError ? 400 : 500).json({ error: e instanceof UserError ? e.message : '서버 오류' });
    }
  };

  const kstDayStart = () => Math.floor((Date.now() + 9 * 3600_000) / 86_400_000) * 86_400_000 - 9 * 3600_000;
  api.get('/dashboard', wrap(async () => {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const stock = await getStock();
    const stockValue = Object.entries(stock).reduce((s, [k, v]) => s + (priceOf(k) ? v * priceOf(k) : 0), 0);
    const day = kstDayStart();
    const week = db.prepare(
      `SELECT date((created_at+32400000)/1000,'unixepoch') d, COUNT(*) n, COALESCE(SUM(points_used),0) vol, COALESCE(SUM(fee),0) fee
       FROM orders WHERE status IN ('done','confirming') AND created_at >= ? GROUP BY d ORDER BY d`).all(day - 6 * 86_400_000);
    return {
      stockValue,
      sellingCoins: enabledCoins().length,
      rates: { usdkrw: rates.usdkrw, kimp: rates.kimp },
      users: one('SELECT COUNT(*) n, COALESCE(SUM(points),0) pts FROM users'),
      chargedToday: one("SELECT COALESCE(SUM(amount),0) s FROM charges WHERE status='done' AND done_at >= ?", day).s,
      feeToday: one("SELECT COALESCE(SUM(fee),0) s FROM orders WHERE status IN ('done','confirming') AND created_at >= ?", day).s,
      feeTotal: one("SELECT COALESCE(SUM(fee),0) s FROM orders WHERE status IN ('done','confirming')").s,
      unmatched: one("SELECT COUNT(*) n FROM deposits WHERE status='unmatched'").n,
      errorOrders: one("SELECT COUNT(*) n FROM orders WHERE status='error'").n,
      confirming: one("SELECT COUNT(*) n FROM orders WHERE status='confirming'").n,
      openSells: one("SELECT COUNT(*) n FROM sell_requests WHERE status='open'").n,
      maintenance: getSetting('maintenance') === '1',
      week,
    };
  }));

  // 재고 충전 주소 / 재고 / 가스 / 보충 필요 수량
  api.get('/wallets', wrap(() => walletReport()));
  api.post('/coins/:key/enabled', wrap((req) => {
    if (!COINS[req.params.key]) throw new UserError('알 수 없는 코인');
    const set = new Set((getSetting('disabled_coins') || '').split(',').filter(Boolean));
    if (req.body.enabled) set.delete(req.params.key); else set.add(req.params.key);
    setSetting('disabled_coins', [...set].join(','));
  }));
  api.post('/maintenance', wrap((req) => { setSetting('maintenance', req.body.on ? '1' : '0'); }));
  api.post('/notice', wrap((req) => {
    const text = String(req.body.text || '').trim().slice(0, 1500);
    if (!text) throw new UserError('내용을 입력하세요.');
    bus.emit('notice', { text });
  }));

  // CSV 내보내기 (엑셀 한글 깨짐 방지용 BOM)
  api.get('/export/:t.csv', (req, res) => {
    const sql = { charges: 'SELECT * FROM charges ORDER BY id', orders: 'SELECT * FROM orders ORDER BY id', point_log: 'SELECT * FROM point_log ORDER BY id' }[req.params.t];
    if (!sql) return res.status(404).end();
    const rows = db.prepare(sql).all();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${req.params.t}.csv"`)
      .send('﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n'));
  });

  const LISTS = {
    users: 'SELECT * FROM users ORDER BY created_at DESC LIMIT 300',
    charges: 'SELECT * FROM charges WHERE (?1=\'\' OR status=?1) ORDER BY id DESC LIMIT 300',
    deposits: 'SELECT * FROM deposits WHERE (?1=\'\' OR status=?1) ORDER BY id DESC LIMIT 300',
    orders: 'SELECT * FROM orders WHERE (?1=\'\' OR status=?1) ORDER BY id DESC LIMIT 300',
    sells: 'SELECT * FROM sell_requests WHERE (?1=\'\' OR status=?1) ORDER BY id DESC LIMIT 300',
    log: 'SELECT * FROM point_log ORDER BY id DESC LIMIT 300',
    audit: 'SELECT * FROM audit ORDER BY id DESC LIMIT 300',
    kyc: `SELECT discord_id, phone_verified, phone_number, kyc_status, kyc_name, kyc_dob, kyc_memo, kyc_channel_id,
            kyc_submitted_at, kyc_reviewed_at, kyc_reviewer FROM users
          WHERE kyc_status!='none' AND (?1='' OR kyc_status=?1) ORDER BY kyc_submitted_at DESC LIMIT 300`,
  };
  api.get('/list/:t', wrap((req) => {
    const sql = LISTS[req.params.t];
    if (!sql) throw new UserError('unknown');
    const rows = ['users', 'log', 'audit'].includes(req.params.t) ? db.prepare(sql).all() : db.prepare(sql).all(String(req.query.status || ''));
    if (req.params.t === 'orders') for (const r of rows) r.explorer = explorerUrl(r.coin, r.txid);
    return rows;
  }));

  api.post('/users/:id/points', wrap((req) => {
    const delta = Math.trunc(Number(req.body.delta));
    if (!delta) throw new UserError('변경할 포인트를 입력하세요.');
    tx(() => addPoints(req.params.id, delta, `admin:${String(req.body.memo || '').slice(0, 60)}`));
    bus.emit('notify_user', { userId: req.params.id, content: `관리자에 의해 포인트가 ${delta > 0 ? '+' : ''}${delta.toLocaleString()}P 조정되었습니다.` });
  }));
  api.post('/users/:id/ban', wrap((req) => {
    db.prepare('UPDATE users SET banned=? WHERE discord_id=?').run(req.body.banned ? 1 : 0, req.params.id);
    bus.emit('notify_user', { userId: req.params.id, content: req.body.banned ? '🚫 계정 이용이 제한되었습니다. 문의가 필요하면 티켓을 열어주세요.' : '✅ 계정 이용 제한이 해제되었습니다.' });
  }));
  api.post('/deposits/:id/match', wrap((req) => { manualMatch(Number(req.params.id), Number(req.body.chargeId)); }));
  api.post('/deposits/:id/ignore', wrap((req) => {
    db.prepare("UPDATE deposits SET status='ignored' WHERE id=? AND status='unmatched'").run(Number(req.params.id));
  }));
  api.post('/charges/:id/cancel', wrap((req) => { if (!cancelCharge(Number(req.params.id))) throw new UserError('대기 상태가 아닙니다.'); }));
  api.post('/orders/:id/retry', wrap(async (req) => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(Number(req.params.id));
    if (o?.status !== 'error') throw new UserError('error 상태 주문만 재전송할 수 있습니다. (온체인 전송 여부를 먼저 확인하세요)');
    return executeOrder(Number(req.params.id));
  }));
  api.post('/orders/:id/refund', wrap((req) => { refundOrder(Number(req.params.id)); }));
  api.post('/sells/:id', wrap((req) => {
    const st = req.body.status;
    if (!['open', 'done', 'rejected'].includes(st)) throw new UserError('잘못된 상태');
    db.prepare('UPDATE sell_requests SET status=?, memo=? WHERE id=?').run(st, req.body.memo || null, Number(req.params.id));
    const s = db.prepare('SELECT * FROM sell_requests WHERE id=?').get(Number(req.params.id));
    if (s && st !== 'open')
      bus.emit('notify_user', { userId: s.discord_id, content: `매입 신청 #${s.id} 이(가) ${st === 'done' ? '완료' : '거절'}되었습니다.${req.body.memo ? `\n사유/메모: ${req.body.memo}` : ''}` });
  }));
  api.post('/kyc/:id/approve', wrap((req) => { reviewKyc(req.params.id, true, null, req.admin.name); }));
  api.post('/kyc/:id/reject', wrap((req) => {
    if (!String(req.body.memo || '').trim()) throw new UserError('반려 사유를 입력하세요.');
    reviewKyc(req.params.id, false, req.body.memo, req.admin.name);
  }));
  api.get('/settings', wrap(() => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, getSetting(k)]))));
  api.put('/settings', wrap((req) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in req.body) setSetting(k, req.body[k]);
  }));

  app.use('/admin/api', api);
  return app.listen(config.port, () => console.log(`[server] ${config.publicUrl}/admin  (내부 포트 ${config.port}, 입금 수신: POST /api/deposit)`));
}
