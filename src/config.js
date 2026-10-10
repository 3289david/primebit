const e = process.env;

export const config = {
  token: e.DISCORD_TOKEN,
  guildId: e.GUILD_ID,
  adminRoleId: e.ADMIN_ROLE_ID || null,
  adminLogChannelId: e.ADMIN_LOG_CHANNEL_ID || null,
  alertChannelId: e.ALERT_CHANNEL_ID || null,
  tradeLogChannelId: e.TRADE_LOG_CHANNEL_ID || null,
  ticketCategoryId: e.TICKET_CATEGORY_ID || null,
  stockRoleId: e.STOCK_ROLE_ID || null,
  port: Number(e.PORT || 3000),
  publicUrl: (e.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  clientId: e.DISCORD_CLIENT_ID,
  clientSecret: e.DISCORD_CLIENT_SECRET,
  adminIds: (e.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionSecret: e.SESSION_SECRET,
  deviceSecret: e.DEVICE_SECRET,
  octomoApiKey: e.OCTOMO_API_KEY || null,
  // 자동 설정(/최초 1회) 대상 채널 — 지정하지 않으면 해당 단계는 건너뜀
  panelChannelId: e.PANEL_CHANNEL_ID || null,
  statusChannelId: e.STATUS_CHANNEL_ID || null,
};

export { COINS, CHAINS, FEATURED, explorerUrl } from './chains/config.js';

// 운영사(샵) 이름/브랜드 컬러 — .env 의 SHOP_NAME, BRAND_COLOR 로 변경하세요
export const BRAND = e.SHOP_NAME || 'MyCoinExchange';
export const COLOR = e.BRAND_COLOR ? Number(`0x${e.BRAND_COLOR.replace(/^#/, '')}`) : 0x2b6df6;
