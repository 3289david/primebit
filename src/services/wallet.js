import { COINS, CHAINS, explorerUrl } from '../config.js';
import { getSetting, numSetting } from '../db.js';
import { priceOf } from './rates.js';
import { tronAdapter } from '../chains/tron.js';
import { evmAdapter } from '../chains/evm.js';
import { solanaAdapter } from '../chains/solana.js';
import { xrpAdapter } from '../chains/xrp.js';
import { btcAdapter } from '../chains/btc.js';

export { explorerUrl };

const FACTORIES = { tron: tronAdapter, evm: evmAdapter, sol: solanaAdapter, xrp: xrpAdapter, btc: btcAdapter };
const adapters = {};

/** 체인 어댑터 (지연 생성). 테스트에서만 setAdapter 로 교체 */
export function adapter(chainId) {
  return (adapters[chainId] ??= FACTORIES[CHAINS[chainId].family](CHAINS[chainId]));
}
export const setAdapter = (chainId, a) => { adapters[chainId] = a; };

const disabledSet = () => new Set((getSetting('disabled_coins') || '').split(',').map((s) => s.trim()).filter(Boolean));
/** 핫월렛 키가 설정된 체인의 코인 (재고 조회/송금 가능) */
export const configuredCoins = () => Object.keys(COINS).filter((k) => adapter(COINS[k].chain).configured);
/** 사용자에게 판매 중인 코인 = 키 설정됨 + 관리자가 끄지 않음 */
export const enabledCoins = () => configuredCoins().filter((k) => !disabledSet().has(k));
export const isEnabled = (k) => enabledCoins().includes(k);

export function isValidAddress(coinKey, addr) {
  const c = COINS[coinKey];
  return !!c && adapter(c.chain).valid(addr);
}
export function isOwnAddress(coinKey, addr) {
  const mine = hotAddress(COINS[coinKey].chain);
  return !!mine && String(addr).trim().split(':')[0].toLowerCase() === mine.toLowerCase();
}
export function hotAddress(chainId) {
  try {
    return adapter(chainId).address();
  } catch (e) {
    console.error(`[wallet] ${chainId} 주소 계산 실패 (키 형식 확인):`, e.message);
    return null;
  }
}

// ── 재고(핫월렛 실제 보유량) ──
let stockCache = { at: 0, data: {}, errors: {} };
export async function getStock(force = false) {
  if (!force && Date.now() - stockCache.at < 20_000) return stockCache.data;
  const keys = configuredCoins();
  const results = await Promise.allSettled(keys.map((k) => adapter(COINS[k].chain).balance(COINS[k])));
  const data = { ...stockCache.data };
  const errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else errors[keys[i]] = String(r.reason?.message || r.reason).slice(0, 120);
  });
  stockCache = { at: Date.now(), data, errors };
  return data;
}
export const stockErrors = () => stockCache.errors;

// ── 송금: 체인별로 한 번에 한 건씩 (논스/UTXO 충돌 방지) ──
const queues = {};
export function sendCoin(coinKey, to, amount) {
  const c = COINS[coinKey];
  const a = adapter(c.chain);
  if (!a.configured) return Promise.reject(new Error(`${CHAINS[c.chain].name} 핫월렛 키(${CHAINS[c.chain].keyEnv})가 설정되지 않았습니다.`));
  const prev = queues[c.chain] ?? Promise.resolve();
  const p = prev.then(() => a.send(c, String(to).trim(), amount));
  queues[c.chain] = p.catch(() => {});
  return p.finally(() => { stockCache.at = 0; });
}

/** 블록 확정 조회 → { state: 'pending'|'confirmed'|'failed', detail } */
export const checkTx = (coinKey, txid, ageMs) => adapter(COINS[coinKey].chain).check(txid, ageMs);

// ── 관리자 패널용: 재고 충전 주소/가스/보충 필요량 ──
let gasCache = {};
async function gasOf(chainId) {
  const g = gasCache[chainId];
  if (g && Date.now() - g.at < 60_000) return g.value;
  let value = null;
  try {
    value = await adapter(chainId).gasBalance();
  } catch (e) {
    value = { error: String(e.message).slice(0, 100) };
  }
  gasCache[chainId] = { at: Date.now(), value };
  return value;
}
export const gasLow = (chainId, bal) => typeof bal === 'number' && bal < CHAINS[chainId].gasWarn;

export async function walletReport() {
  const stock = await getStock();
  const errs = stockErrors();
  const target = numSetting('stock_target_krw');
  const alertKrw = numSetting('stock_alert_krw');
  const disabled = disabledSet();
  const out = [];
  for (const [id, ch] of Object.entries(CHAINS)) {
    const a = adapter(id);
    const gas = a.configured ? await gasOf(id) : null;
    const coins = Object.entries(COINS)
      .filter(([, c]) => c.chain === id)
      .map(([key, c]) => {
        const price = priceOf(key);
        const amt = stock[key] ?? null;
        const value = amt != null && price ? amt * price : null;
        const state = !a.configured ? 'nokey' : errs[key] ? 'error' : value == null ? 'unknown' : value <= 0 ? 'soldout' : value < alertKrw ? 'low' : 'ok';
        const needKrw = value == null || !price ? null : Math.max(0, target - value);
        return {
          key, label: c.label, symbol: c.symbol, contract: c.contract || null, enabled: !disabled.has(key),
          stock: amt, price, valueKrw: value, state, error: errs[key] || null,
          needCoin: needKrw == null ? null : needKrw / price, needKrw,
        };
      });
    out.push({
      chain: id, name: ch.name, native: ch.native, address: a.configured ? hotAddress(id) : null, configured: a.configured,
      keyEnv: ch.keyEnv, gas, gasWarn: ch.gasWarn, gasLow: gasLow(id, gas), confirmations: ch.confirmations, addrHint: ch.addrHint, coins,
    });
  }
  return out;
}
