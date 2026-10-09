// 체인 어댑터 오프라인 검증: 주소 파생/검증, BTC 트랜잭션 서명(mock API)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet as EvmWallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Wallet as XrpWallet } from 'xrpl';
import { TronWeb } from 'tronweb';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

const ECPair = ECPairFactory(ecc);
const evm = EvmWallet.createRandom();
const sol = Keypair.generate();
const xrp = XrpWallet.generate();
const tron = await TronWeb.createAccount();
const btcKp = ECPair.makeRandom();

process.env.EVM_PRIVATE_KEY = evm.privateKey;
process.env.SOL_PRIVATE_KEY = bs58.encode(sol.secretKey);
process.env.XRP_SEED = xrp.seed;
process.env.TRON_PRIVATE_KEY = tron.privateKey;
process.env.BTC_WIF = btcKp.toWIF();
process.env.DB_PATH = ':memory:';

const { adapter } = await import('../src/services/wallet.js');
const { COINS, CHAINS } = await import('../src/config.js');

test('체인 12개 / 코인 20개 이상 정의, 모든 코인은 유효한 체인과 소수점 설정', () => {
  assert.ok(Object.keys(CHAINS).length >= 12);
  assert.ok(Object.keys(COINS).length >= 20);
  for (const [k, c] of Object.entries(COINS)) {
    assert.ok(CHAINS[c.chain], `${k}: 체인 없음`);
    assert.ok(c.dp <= c.decimals, `${k}: dp > decimals`);
  }
});

test('핫월렛 주소 파생: 각 체인 키 → 올바른 주소', () => {
  assert.equal(adapter('eth').address(), evm.address);
  assert.equal(adapter('base').address(), evm.address); // EVM 체인은 같은 주소 공유
  assert.equal(adapter('sol').address(), sol.publicKey.toBase58());
  assert.equal(adapter('xrp').address(), xrp.classicAddress);
  assert.equal(adapter('tron').address(), tron.address.base58);
  assert.match(adapter('btc').address(), /^bc1q/);
});

test('주소 검증: 올바른 주소 통과 / 다른 체인 주소·오타 거부', () => {
  assert.ok(adapter('eth').valid(evm.address));
  assert.ok(!adapter('eth').valid(tron.address.base58));
  assert.ok(!adapter('eth').valid(evm.address.slice(0, 40)));
  assert.ok(adapter('tron').valid(tron.address.base58));
  assert.ok(!adapter('tron').valid(evm.address));
  assert.ok(adapter('sol').valid(sol.publicKey.toBase58()));
  assert.ok(!adapter('sol').valid(evm.address));
  assert.ok(adapter('xrp').valid(xrp.classicAddress));
  assert.ok(adapter('xrp').valid(xrp.classicAddress + ':12345'));
  assert.ok(!adapter('xrp').valid(xrp.classicAddress + ':abc'));
  assert.ok(adapter('btc').valid(adapter('btc').address()));
  assert.ok(adapter('btc').valid('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
  assert.ok(!adapter('btc').valid('bc1qinvalid'));
});

test('BTC: UTXO 선택·수수료·거스름돈 계산 후 서명된 트랜잭션 브로드캐스트', async () => {
  const a = adapter('btc');
  const me = a.address();
  const dest = bitcoin.payments.p2wpkh({ pubkey: ECPair.makeRandom().publicKey, network: bitcoin.networks.bitcoin }).address;
  let broadcast = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const json = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (u.endsWith(`/address/${me}/utxo`)) {
      return json([
        { txid: 'aa'.repeat(32), vout: 0, value: 30000, status: { confirmed: true } },
        { txid: 'bb'.repeat(32), vout: 1, value: 200000, status: { confirmed: true } },
        { txid: 'cc'.repeat(32), vout: 0, value: 999999, status: { confirmed: false } }, // 미확정 외부 입금은 사용 금지
      ]);
    }
    if (u.endsWith('/v1/fees/recommended')) return json({ halfHourFee: 10 });
    if (u.endsWith('/tx') && opts?.method === 'POST') {
      broadcast = opts.body;
      return new Response('f'.repeat(64), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const txid = await a.send(COINS.BTC, dest, 0.0005); // 50,000 sat
    assert.equal(txid, 'f'.repeat(64));
  } finally {
    globalThis.fetch = realFetch;
  }
  const tx = bitcoin.Transaction.fromHex(broadcast);
  assert.equal(tx.ins.length, 1); // 200,000 sat UTXO 하나면 충분
  const pay = tx.outs.find((o) => Buffer.from(o.script).equals(Buffer.from(bitcoin.address.toOutputScript(dest))));
  assert.equal(Number(pay.value), 50000);
  const change = tx.outs.find((o) => o !== pay);
  const fee = 200000 - 50000 - Number(change.value);
  assert.equal(fee, Math.ceil((11 + 68 + 62) * 10)); // 141 vB × 10 sat/vB
  assert.ok(tx.ins[0].witness.length === 2); // 서명 + 공개키
});
