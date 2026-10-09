// 디스코드 OAuth 로그인 / 세션 / CSRF 검증 (실제 서버를 띄우고 HTTP 로 호출)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DB_PATH: ':memory:', PORT: '3556', PUBLIC_URL: 'https://primebit.krl.kr', SESSION_SECRET: 'unit-test-session-secret',
  DEVICE_SECRET: 'dev', DISCORD_CLIENT_ID: '12345', DISCORD_CLIENT_SECRET: 'sec', ADMIN_DISCORD_IDS: '111, 222', GUILD_ID: '999',
});
delete process.env.ADMIN_ROLE_ID;

const { makeToken, readToken, isAdminUser, fetchDiscordUser } = await import('../src/auth.js');
const { startServer } = await import('../src/server.js');
const server = startServer();
after(() => server?.close?.());
const base = 'http://localhost:3556';
const cookie = (name, v) => ({ Cookie: `${name}=${v}` });

test('토큰: 서명 검증, 변조·만료 거부', () => {
  const t = makeToken({ id: '111' }, 60_000);
  assert.equal(readToken(t).id, '111');
  assert.equal(readToken(t.slice(0, -2) + 'xx'), null);
  assert.equal(readToken(makeToken({ id: '111' }, -1)), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ id: '999', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(readToken(`${forged}.${sig}`), null);
  assert.equal(readToken(undefined), null);
});

test('관리자 허용: 지정한 디스코드 ID만', async () => {
  assert.equal(await isAdminUser('111'), true);
  assert.equal(await isAdminUser('222'), true);
  assert.equal(await isAdminUser('333'), false); // ADMIN_ROLE_ID 미설정 → 목록 외 거부
});

test('역할 기반 허용: 서버 멤버의 관리자 역할 확인', async () => {
  const cfg = (await import('../src/config.js')).config;
  cfg.adminRoleId = 'ROLE1';
  cfg.token = 'bot-token';
  const mk = (roles, ok = true) => async (url, o) => {
    assert.match(String(url), /\/guilds\/999\/members\/444$/);
    assert.equal(o.headers.Authorization, 'Bot bot-token');
    return { ok, json: async () => ({ roles }) };
  };
  assert.equal(await isAdminUser('444', mk(['ROLE1'])), true);
  assert.equal(await isAdminUser('444', mk(['OTHER'])), false);
  assert.equal(await isAdminUser('444', mk([], false)), false); // 서버 멤버 아님
  cfg.adminRoleId = null;
});

test('OAuth 코드 교환: 토큰 → 유저 조회', async () => {
  const calls = [];
  const f = async (url, o) => {
    calls.push(String(url));
    if (String(url).endsWith('/oauth2/token')) {
      assert.match(String(o.body), /redirect_uri=https%3A%2F%2Fprimebit.krl.kr%2Fadmin%2Fcallback/);
      return { ok: true, json: async () => ({ access_token: 'AT' }) };
    }
    assert.equal(o.headers.Authorization, 'Bearer AT');
    return { ok: true, json: async () => ({ id: '111', username: 'dan', global_name: '단' }) };
  };
  assert.deepEqual(await fetchDiscordUser('CODE', f), { id: '111', username: '단' });
  assert.equal(calls.length, 2);
});

test('로그인 시작: 디스코드 인가 페이지로 리다이렉트 + state 쿠키', async () => {
  const r = await fetch(`${base}/admin/login/discord`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(loc.searchParams.get('client_id'), '12345');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://primebit.krl.kr/admin/callback');
  assert.equal(loc.searchParams.get('scope'), 'identify');
  assert.ok(loc.searchParams.get('state'));
  assert.match(r.headers.get('set-cookie'), /oauth_state=.*HttpOnly.*Secure/i);
});

test('콜백: state 없음/불일치는 로그인 거부', async () => {
  const r1 = await fetch(`${base}/admin/callback?code=x&state=abc`, { redirect: 'manual' });
  assert.match(r1.headers.get('location'), /^\/admin\?error=/);
  const st = makeToken({ nonce: 'right' }, 60_000);
  const r2 = await fetch(`${base}/admin/callback?code=x&state=wrong`, { redirect: 'manual', headers: cookie('oauth_state', st) });
  assert.match(r2.headers.get('location'), /error=/);
  assert.ok(!(r2.headers.get('set-cookie') || '').includes('adm='));
});

test('API: 로그인 없이/위조 쿠키는 401, 유효 세션은 200, 비밀번호 로그인은 없음', async () => {
  assert.equal((await fetch(`${base}/admin/api/dashboard`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/me`, { headers: cookie('adm', 'aaa.bbb') })).status, 401);
  const good = makeToken({ id: '111', name: 'dan' }, 60_000);
  const me = await fetch(`${base}/admin/api/me`, { headers: cookie('adm', good) });
  assert.deepEqual(await me.json(), { id: '111', name: 'dan' });
  assert.equal((await fetch(`${base}/admin/login`, { method: 'POST' })).status, 404);
});

test('CSRF: 다른 출처의 상태 변경 요청 차단 + 감사 로그 기록', async () => {
  const good = makeToken({ id: '111', name: 'dan' }, 60_000);
  const h = { 'Content-Type': 'application/json', ...cookie('adm', good) };
  const evil = await fetch(`${base}/admin/api/maintenance`, { method: 'POST', headers: { ...h, Origin: 'https://evil.example' }, body: '{"on":true}' });
  assert.equal(evil.status, 403);
  const ok = await fetch(`${base}/admin/api/maintenance`, { method: 'POST', headers: { ...h, Origin: 'https://primebit.krl.kr' }, body: '{"on":false}' });
  assert.equal(ok.status, 200);
  const audit = await (await fetch(`${base}/admin/api/list/audit`, { headers: cookie('adm', good) })).json();
  assert.ok(audit.some((a) => a.admin_id === '111' && a.action.includes('/maintenance')));
  assert.ok(!audit.some((a) => a.detail === '{"on":true}')); // 차단된 요청은 기록/실행되지 않음
});
