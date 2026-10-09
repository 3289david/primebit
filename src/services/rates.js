import { COINS } from '../config.js';
import { numSetting } from '../db.js';
import { UserError } from '../util.js';

/** 실시간 시세 캐시 */
export const rates = {
  usdkrw: null,        // 1달러 환율
  upbit: {},           // 업비트 KRW 시세 { BTC, USDT, ETH ... }
  usd: {},             // 업비트에 없는 코인의 달러 시세 { BNB }
  btcUsd: null,
  kimp: null,          // 김치 프리미엄 % (BTC 기준)
  usdtPremium: null,   // USDT 프리미엄 % (업비트 USDT / 환율)
  updatedAt: 0,
};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
const coinbaseUsd = async (sym) => Number((await getJson(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`)).data.amount);

let fxAt = 0;
async function refreshFx() {
  if (rates.usdkrw && Date.now() - fxAt < 10 * 60_000) return;
  const d = await getJson('https://open.er-api.com/v6/latest/USD');
  if (d?.rates?.KRW) {
    rates.usdkrw = d.rates.KRW;
    fxAt = Date.now();
  }
}

const upbitSymbols = () => [...new Set(['BTC', ...Object.values(COINS).filter((c) => c.priceMode === 'upbit').map((c) => c.symbol)])];
const usdSymbols = () => [...new Set(Object.values(COINS).filter((c) => c.priceMode === 'usd').map((c) => c.symbol))];

export async function refreshRates() {
  await Promise.allSettled([
    refreshFx(),
    (async () => {
      const ticks = await getJson(`https://api.upbit.com/v1/ticker?markets=${upbitSymbols().map((s) => 'KRW-' + s).join(',')}`);
      for (const t of ticks) rates.upbit[t.market.replace('KRW-', '')] = t.trade_price;
      rates.updatedAt = Date.now();
    })(),
    (async () => {
      rates.btcUsd = await coinbaseUsd('BTC');
    })(),
    ...usdSymbols().map(async (s) => {
      rates.usd[s] = await coinbaseUsd(s);
    }),
  ]);
  const { usdkrw, btcUsd, upbit } = rates;
  if (usdkrw && btcUsd && upbit.BTC) rates.kimp = (upbit.BTC / (btcUsd * usdkrw) - 1) * 100;
  if (usdkrw && upbit.USDT) rates.usdtPremium = (upbit.USDT / usdkrw - 1) * 100;
}

/** 기준 원화 시세 (마진 전). 없으면 null */
export function basePrice(coinKey) {
  const c = COINS[coinKey];
  if (!c) return null;
  if (c.priceMode === 'upbit') return rates.upbit[c.symbol] ?? null;
  const usd = rates.usd[c.symbol];
  const fx = rates.upbit.USDT ?? rates.usdkrw;
  return usd && fx ? usd * fx : null;
}

/** 화면 표시용(예외 없음) */
export const priceOf = (coinKey) => {
  const p = basePrice(coinKey);
  return p == null ? null : p * (1 + numSetting('price_markup'));
};

/** 사용자 구매 단가(원). 시세가 오래됐으면 거래 차단 */
export function getPrice(coinKey) {
  const p = basePrice(coinKey);
  if (!p || Date.now() - rates.updatedAt > 120_000) throw new UserError('시세를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
  const price = p * (1 + numSetting('price_markup'));
  return price >= 100 ? Math.ceil(price) : Math.ceil(price * 100) / 100;
}

export function startRates() {
  const tick = () => refreshRates().catch((e) => console.error('[rates]', e.message));
  tick();
  setInterval(tick, 10_000);
}
