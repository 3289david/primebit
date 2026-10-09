import crypto from 'node:crypto';
import { config } from './config.js';

const DISCORD = 'https://discord.com/api/v10';
export const SESSION_TTL = 12 * 3600_000;

const sign = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

/** 서명된 토큰 (세션/OAuth state 공용). 위조·만료 검증 포함 */
export function makeToken(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = sign(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
export const getCookie = (req, name) =>
  (req.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

export const redirectUri = () => `${config.publicUrl}/admin/callback`;

export function authorizeUrl(state) {
  const q = new URLSearchParams({
    client_id: config.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'identify', state,
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/** 인가 코드 → 디스코드 유저 { id, username } */
export async function fetchDiscordUser(code, fetchFn = fetch) {
  const tokenRes = await fetchFn(`${DISCORD}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error('토큰 교환 실패');
  const { access_token } = await tokenRes.json();
  const me = await fetchFn(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!me.ok) throw new Error('유저 조회 실패');
  const u = await me.json();
  return { id: u.id, username: u.global_name || u.username };
}

/** 관리자 허용 여부: ADMIN_DISCORD_IDS 목록 또는 서버의 관리자 역할 보유자 */
export async function isAdminUser(userId, fetchFn = fetch) {
  if (config.adminIds.includes(userId)) return true;
  if (!config.adminRoleId || !config.guildId) return false;
  const r = await fetchFn(`${DISCORD}/guilds/${config.guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${config.token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return false; // 서버 멤버가 아님
  const m = await r.json();
  return Array.isArray(m.roles) && m.roles.includes(config.adminRoleId);
}
