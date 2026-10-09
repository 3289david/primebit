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
  publicUrl: (e.PUBLIC_URL || 'https://primebit.krl.kr').replace(/\/$/, ''),
  clientId: e.DISCORD_CLIENT_ID,
  clientSecret: e.DISCORD_CLIENT_SECRET,
  adminIds: (e.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionSecret: e.SESSION_SECRET,
  deviceSecret: e.DEVICE_SECRET,
};

export { COINS, CHAINS, FEATURED, explorerUrl } from './chains/config.js';

export const BRAND = 'PrimeBIT';
export const COLOR = 0x2b6df6;
