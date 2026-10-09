import { TronWeb } from 'tronweb';
import { toUnits } from '../util.js';

export function tronAdapter(cfg) {
  const pk = process.env[cfg.keyEnv];
  let tw = null;
  const contracts = {};
  const client = () =>
    (tw ??= new TronWeb({
      fullHost: process.env.TRON_FULL_HOST || 'https://api.trongrid.io',
      privateKey: pk,
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : undefined,
    }));
  const token = async (addr) => (contracts[addr] ??= await client().contract().at(addr));
  const address = () => (pk ? TronWeb.address.fromPrivateKey(pk) : null);

  return {
    configured: !!pk,
    address,
    valid: (a) => typeof a === 'string' && a.startsWith('T') && a.length === 34 && TronWeb.isAddress(a),

    async gasBalance() {
      return (await client().trx.getBalance(address())) / 1e6;
    },
    async balance(coin) {
      if (!coin.contract) return this.gasBalance();
      const raw = await (await token(coin.contract)).balanceOf(address()).call();
      return Number(raw.toString()) / 10 ** coin.decimals;
    },
    async send(coin, to, amount) {
      const units = toUnits(amount, coin.dp, coin.decimals);
      if (!coin.contract) {
        const r = await client().trx.sendTransaction(to, Number(units));
        if (!r?.result) throw new Error('TRX 전송 실패: ' + JSON.stringify(r));
        return r.txid;
      }
      return (await token(coin.contract)).transfer(to, units.toString()).send({ feeLimit: 150_000_000 });
    },
    /** 솔리디티 노드(확정 블록)에서 조회되면 확정 */
    async check(txid) {
      const t = client();
      const info = await t.trx.getUnconfirmedTransactionInfo(txid).catch(() => null);
      if (!info || !info.id) return { state: 'pending', detail: '블록 대기' };
      const res = info.receipt?.result;
      if (info.result === 'FAILED' || (res && res !== 'SUCCESS')) return { state: 'failed', detail: res || info.result };
      const confirmed = await t.trx.getConfirmedTransaction(txid).catch(() => null);
      return confirmed?.txID ? { state: 'confirmed' } : { state: 'pending', detail: '확정 대기' };
    },
  };
}
