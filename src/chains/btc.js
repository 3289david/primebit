import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { toUnits } from '../util.js';

const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

const DUST = 294;               // 이보다 작은 거스름돈은 수수료에 합산
const VB = { base: 11, input: 68, output: 31 }; // P2WPKH 가상 바이트 추정

/**
 * 핫월렛은 P2WPKH(bc1q...) 주소 하나. UTXO/수수료/브로드캐스트는 mempool.space 호환 API 사용.
 * 테스트넷: BTC_NETWORK=testnet 과 RPC_BTC=https://mempool.space/testnet4/api
 */
export function btcAdapter(cfg) {
  const wif = process.env[cfg.keyEnv];
  const net = process.env.BTC_NETWORK === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const base = () => (process.env[cfg.rpcEnv] || cfg.rpc).replace(/\/$/, '');
  const own = new Set(); // 내가 보낸 트랜잭션 txid (미확정 거스름돈 재사용용)

  const keypair = () => ECPair.fromWIF(wif.trim(), net);
  const payment = () => bitcoin.payments.p2wpkh({ pubkey: keypair().publicKey, network: net });
  const address = () => (wif ? payment().address : null);

  async function api(path, opts) {
    const r = await fetch(base() + path, { signal: AbortSignal.timeout(15_000), ...opts });
    if (!r.ok) throw new Error(`BTC API ${path} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
    return opts?.method === 'POST' ? r.text() : r.json();
  }
  const spendable = (utxos) => utxos.filter((u) => u.status?.confirmed || own.has(u.txid)).sort((a, b) => b.value - a.value);

  return {
    configured: !!wif,
    address,
    valid(a) {
      try {
        bitcoin.address.toOutputScript(String(a).trim(), net);
        return true;
      } catch {
        return false;
      }
    },
    async gasBalance() {
      const utxos = await api(`/address/${address()}/utxo`);
      return spendable(utxos).reduce((s, u) => s + u.value, 0) / 1e8;
    },
    async balance() {
      return this.gasBalance();
    },
    async send(coin, to, amount) {
      const sats = Number(toUnits(amount, coin.dp, coin.decimals));
      const p = payment();
      const [utxos, fees] = await Promise.all([api(`/address/${p.address}/utxo`), api('/v1/fees/recommended')]);
      const rate = Math.min(Math.max(fees.halfHourFee, 2), Number(process.env.BTC_MAX_FEERATE || 150));

      const sel = [];
      let sum = 0;
      let fee = 0;
      for (const u of spendable(utxos)) {
        sel.push(u);
        sum += u.value;
        fee = Math.ceil((VB.base + VB.input * sel.length + VB.output * 2) * rate);
        if (sum >= sats + fee) break;
      }
      if (sum < sats + fee) throw new Error('BTC 핫월렛의 사용 가능한(확정) 잔액이 부족합니다.');
      let change = sum - sats - fee;
      if (change < DUST) { fee += change; change = 0; }

      const psbt = new bitcoin.Psbt({ network: net });
      for (const u of sel) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: p.output, value: BigInt(u.value) } });
      psbt.addOutput({ address: String(to).trim(), value: BigInt(sats) });
      if (change) psbt.addOutput({ address: p.address, value: BigInt(change) });
      psbt.signAllInputs(keypair());
      psbt.finalizeAllInputs();
      const hex = psbt.extractTransaction().toHex();

      const txid = (await api('/tx', { method: 'POST', body: hex })).trim();
      own.add(txid);
      return txid;
    },
    async check(txid) {
      const st = await api(`/tx/${txid}/status`).catch((e) => (/404/.test(e.message) ? null : Promise.reject(e)));
      if (!st || !st.confirmed) return { state: 'pending', detail: st ? '블록 대기' : '멤풀/전파 대기' };
      const tip = Number(await fetch(base() + '/blocks/tip/height').then((r) => r.text()));
      const conf = tip - st.block_height + 1;
      return conf >= cfg.confirmations ? { state: 'confirmed' } : { state: 'pending', detail: `${conf}/${cfg.confirmations} 컨펌` };
    },
  };
}
