// 운영 전 점검: 각 체인 RPC 연결, 토큰 컨트랙트(심볼/소수점), 핫월렛 주소·잔액을 읽기 전용으로 확인합니다.
// 사용: npm run check:chains         (.env 에 설정된 체인만 잔액까지 확인)
//       npm run check:chains -- --probe   (키가 없어도 RPC/컨트랙트만 확인)
import { Contract, JsonRpcProvider } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { Client } from 'xrpl';

process.env.DB_PATH ||= ':memory:'; // 점검 스크립트는 DB 파일을 만들지 않음
const { COINS, CHAINS } = await import('../src/config.js');
const { adapter } = await import('../src/services/wallet.js');

const probe = process.argv.includes('--probe');
const ERC20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
let bad = 0;
const ok = (m) => console.log('  ✅', m);
const fail = (m) => { bad++; console.log('  ❌', m); };

for (const [id, ch] of Object.entries(CHAINS)) {
  const a = adapter(id);
  console.log(`\n■ ${ch.name}  ${a.configured ? `(핫월렛 ${a.address()})` : '(키 미설정)'}`);
  const rpc = process.env[ch.rpcEnv] || ch.rpc;
  const coins = Object.entries(COINS).filter(([, c]) => c.chain === id);
  try {
    if (ch.family === 'evm') {
      const p = new JsonRpcProvider(rpc, ch.chainId, { staticNetwork: true });
      const net = await p.getNetwork();
      Number(net.chainId) === ch.chainId ? ok(`RPC 연결 · chainId ${net.chainId} · 블록 ${await p.getBlockNumber()}`) : fail('chainId 불일치');
      for (const [k, c] of coins.filter(([, c]) => c.contract)) {
        const t = new Contract(c.contract, ERC20, p);
        const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
        // 테더는 일부 체인에서 심볼이 USDT0 / USD₮0 로 바뀌었음 (공식 컨트랙트, 같은 토큰)
        const symOk = sym === c.symbol || (c.symbol === 'USDT' && /^USD[T₮]0?$/.test(sym));
        symOk && Number(dec) === c.decimals ? ok(`${k}: ${sym}, decimals ${dec}`) : fail(`${k}: 온체인 ${sym}/${dec} ≠ 설정 ${c.symbol}/${c.decimals}`);
      }
    } else if (ch.family === 'sol') {
      const conn = new Connection(rpc, 'confirmed');
      ok(`RPC 연결 · 슬롯 ${await conn.getSlot()}`);
      for (const [k, c] of coins.filter(([, c]) => c.contract)) {
        const info = await conn.getParsedAccountInfo(new PublicKey(c.contract));
        const dec = info.value?.data?.parsed?.info?.decimals;
        dec === c.decimals ? ok(`${k}: mint decimals ${dec}`) : fail(`${k}: mint 확인 실패 (${dec})`);
      }
    } else if (ch.family === 'xrp') {
      const c = new Client(rpc);
      await c.connect();
      const info = await c.request({ command: 'server_info' });
      ok(`RPC 연결 · ${info.result.info.build_version} · 원장 ${info.result.info.validated_ledger?.seq}`);
      await c.disconnect();
    } else if (ch.family === 'btc') {
      const h = await fetch(rpc.replace(/\/$/, '') + '/blocks/tip/height').then((r) => r.text());
      ok(`API 연결 · 블록 ${h}`);
    } else if (ch.family === 'tron') {
      const r = await fetch((process.env.TRON_FULL_HOST || 'https://api.trongrid.io') + '/wallet/getnowblock', { method: 'POST' }).then((x) => x.json());
      ok(`RPC 연결 · 블록 ${r.block_header.raw_data.number}`);
    }
    if (a.configured) {
      for (const [k, c] of coins) {
        const bal = await a.balance(c).catch((e) => `조회 실패: ${e.message}`);
        console.log(`    · ${k}: ${bal}`);
      }
      console.log(`    · 수수료(가스) 잔액: ${await a.gasBalance().catch((e) => e.message)} ${ch.native} (권장 ${ch.gasWarn}+)`);
    } else if (!probe) {
      console.log(`    · ${ch.keyEnv} 를 설정하면 이 체인의 코인이 판매 목록에 나타납니다.`);
    }
  } catch (e) {
    fail(`연결 실패: ${e.message}`);
  }
}
console.log(bad ? `\n문제 ${bad}건 — 위 ❌ 항목을 확인하세요.` : '\n모든 점검 통과');
process.exit(bad ? 1 : 0);
