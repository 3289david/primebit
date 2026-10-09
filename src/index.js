import './db.js';
import { startRates } from './services/rates.js';
import { expireCharges } from './services/charges.js';
import { recoverStuckOrders, startConfirmLoop } from './services/orders.js';
import { configuredCoins, hotAddress } from './services/wallet.js';
import { CHAINS } from './config.js';
import { startServer } from './server.js';
import { startBot } from './bot/index.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const botEnabled = !!(process.env.DISCORD_TOKEN && process.env.GUILD_ID);
if (!botEnabled) {
  console.warn('⚠️  DISCORD_TOKEN / GUILD_ID 가 없어 디스코드 봇은 시작하지 않습니다. (웹 서버만 실행 — .env.example 참고)');
}

// 핫월렛이 설정된 체인 출력 (키가 없는 체인의 코인은 판매 목록에 나오지 않음)
const ready = Object.entries(CHAINS).filter(([id]) => configuredCoins().some((k) => k && hotAddress(id)));
console.log(`[wallet] 설정된 체인 ${ready.length}/${Object.keys(CHAINS).length}: ${ready.map(([id, c]) => `${c.name}(${hotAddress(id)})`).join(', ') || '없음 — .env 에 개인키를 설정하세요'}`);

recoverStuckOrders();
startRates();
startConfirmLoop();
setInterval(expireCharges, 60_000);
startServer();
if (botEnabled) await startBot();
