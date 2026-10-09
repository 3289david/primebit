import { EventEmitter } from 'node:events';

/** 사용자에게 그대로 보여줄 수 있는 오류 */
export class UserError extends Error {}

export const bus = new EventEmitter();
export const now = () => Date.now();
export const krw = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
export const pts = (n) => `${Math.round(n).toLocaleString('ko-KR')}P`;
export const fmtTime = (ms) =>
  new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
export const fmtCoin = (n, d = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
/** 소수 수량 → 온체인 최소단위 정수(BigInt). dp 자리까지만 사용 */
export const toUnits = (amount, dp, decimals) =>
  BigInt(Math.round(Number(amount.toFixed(dp)) * 10 ** dp)) * 10n ** BigInt(decimals - dp);
export const maskName = (s) => {
  s = String(s);
  return s.length <= 2 ? s[0] + '*' : s[0] + '*'.repeat(Math.min(s.length - 2, 4)) + s.at(-1);
};
export const parseInt0 = (s) => Number(String(s).replace(/[,\s원P]/gi, ''));
