import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
} from 'discord.js';
import { config, COINS, CHAINS, FEATURED, BRAND, COLOR } from '../config.js';
import { getSetting, setSetting, numSetting } from '../db.js';
import { rates, priceOf } from '../services/rates.js';
import { getStock, enabledCoins, configuredCoins, hotAddress, adapter, gasLow } from '../services/wallet.js';
import { fmtCoin, fmtTime } from '../util.js';

const f0 = (n) => (n == null ? '-' : Math.round(n).toLocaleString('ko-KR'));
const sign = (n) => (n == null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const stockStr = (n) => (n == null ? '-' : n >= 100 ? f0(n) : fmtCoin(n, 4));

export async function buildStatusEmbed() {
  const stock = await getStock();
  const feeRate = numSetting('fee_rate');
  const coins = enabledCoins();
  const lines = coins.map((k) => {
    const s = stock[k];
    const p = priceOf(k);
    const sold = (s ?? 0) <= 0 || (p && s * p < numSetting('buy_min'));
    return `${sold ? '🔴' : '🟢'} **${k}**  ${sold ? '품절' : stockStr(s)}  ·  ${p ? (p >= 100 ? f0(p) : p.toFixed(2)) + '원' : '-'}`;
  });
  const half = Math.ceil(lines.length / 2);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📊 ${BRAND} 서비스 현황`)
    .addFields(
      { name: '💵 USD/KRW 환율', value: `**${f0(rates.usdkrw)}원**`, inline: true },
      { name: '📈 김치프리미엄(BTC)', value: `**${sign(rates.kimp)}**`, inline: true },
      { name: '🪙 USDT 프리미엄', value: `**${sign(rates.usdtPremium)}**`, inline: true },
    );
  if (!lines.length) embed.addFields({ name: '📦 실시간 재고', value: '현재 판매 가능한 코인이 없습니다.' });
  else {
    embed.addFields({ name: '📦 실시간 재고 · 시세', value: lines.slice(0, half).join('\n') });
    if (lines.length > half) embed.addFields({ name: '​', value: lines.slice(half).join('\n') });
  }
  embed.addFields({ name: '💳 수수료', value: `**${(feeRate * 100).toFixed(1)}%** (포인트 사용 시 공제)` });
  if (getSetting('maintenance') === '1') embed.setDescription(`🛠️ **${getSetting('maintenance_msg')}**`);
  return embed.setFooter({ text: `업데이트 ${fmtTime(Date.now())}` });
}

export function mainPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`💱 ${BRAND} 코인 환전소`)
    .setDescription(
      [
        '원화를 충전하고, 원하는 코인을 내 지갑으로 바로 받으세요.',
        '',
        '**이용 흐름**',
        '`1.` **충전하기** → 입금자명·금액 입력',
        '`2.` 안내된 계좌로 **정확한 금액** 입금 → 자동으로 포인트 지급',
        '`3.` **코인 구매** → 코인·지갑주소 입력 → 코인 자동 송금',
        '',
        '※ 이곳은 거래소가 아닌 **환전소**입니다.',
        '※ 반드시 **코인 종류와 네트워크가 일치하는 주소**를 입력하세요. 잘못 보낸 코인은 복구할 수 없습니다.',
      ].join('\n'),
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('charge').setLabel('충전하기').setEmoji('💳').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('buy').setLabel('코인 구매').setEmoji('🪙').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sell').setLabel('코인 매입 신청').setEmoji('📥').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me').setLabel('내 정보').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('history').setLabel('내역').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('calc').setLabel('계산기').setEmoji('🧮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket').setLabel('문의').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

function statusComponents() {
  if (!config.stockRoleId) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stock_role').setLabel('재입고 알림 받기/끄기').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** 현황 임베드 메시지 생성/갱신 */
export async function refreshStatusMessage(client) {
  const chId = getSetting('status_channel');
  if (!chId) return;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  const payload = { embeds: [await buildStatusEmbed()], components: statusComponents() };
  const msgId = getSetting('status_message');
  const msg = msgId ? await ch.messages.fetch(msgId).catch(() => null) : null;
  if (msg) await msg.edit(payload);
  else setSetting('status_message', (await ch.send(payload)).id);
}

export async function setupStatusChannel(client, channel) {
  setSetting('status_channel', channel.id);
  setSetting('status_message', '');
  await refreshStatusMessage(client);
}

// ── 음성채널 시세판 (이름 변경은 10분당 2회 제한 → 6분마다) ──
async function voiceNames() {
  const stock = await getStock();
  const names = { rate: `💵 환율 ${f0(rates.usdkrw)}원`, kimp: `📈 김프 ${sign(rates.kimp)}` };
  FEATURED.forEach((k, i) => {
    names[`f${i}`] = `🪙 ${k} 재고 ${stockStr(stock[k] ?? 0)}`;
  });
  return names;
}

export async function setupVoiceBoard(client, guild) {
  const category = await guild.channels.create({ name: `📊 ${BRAND} 실시간 현황`, type: ChannelType.GuildCategory });
  const names = await voiceNames();
  for (const [k, name] of Object.entries(names)) {
    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [{ id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }],
    });
    setSetting(`voice_${k}`, ch.id);
  }
}

export async function refreshVoiceBoard(client) {
  const names = await voiceNames();
  for (const [k, name] of Object.entries(names)) {
    const id = getSetting(`voice_${k}`);
    if (!id) continue;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch && ch.name !== name) await ch.setName(name).catch((e) => console.error('[voice]', e.message));
  }
}

// ── 재고/가스 알림 ──
export async function checkStockAlerts(client) {
  if (!config.alertChannelId) return;
  const ch = await client.channels.fetch(config.alertChannelId).catch(() => null);
  if (!ch) return;
  const stock = await getStock();
  const alertKrw = numSetting('stock_alert_krw');
  const adminMention = config.adminRoleId ? { content: `<@&${config.adminRoleId}>`, allowedMentions: { roles: [config.adminRoleId] } } : {};

  for (const k of configuredCoins()) {
    const p = priceOf(k);
    if (stock[k] == null || !p) continue;
    const low = stock[k] * p < alertKrw;
    const key = `low_${k}`;
    const prev = getSetting(key) === '1';
    if (low === prev) continue;
    setSetting(key, low ? '1' : '0');
    if (low) {
      await ch.send({
        ...adminMention,
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle(`⚠️ ${k} 재고 부족`)
          .setDescription(`현재 **${fmtCoin(stock[k], 4)} ${COINS[k].symbol}** (≈ ${f0(stock[k] * p)}원)\n\n**충전 주소 (${CHAINS[COINS[k].chain].name})**\n\`${hotAddress(COINS[k].chain)}\``)],
      });
    } else if (config.stockRoleId) {
      await ch.send({
        content: `<@&${config.stockRoleId}>`,
        allowedMentions: { roles: [config.stockRoleId] },
        embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${k} 재입고`).setDescription(`현재 재고 **${fmtCoin(stock[k], 4)} ${COINS[k].symbol}** — 구매 가능합니다.`)],
      });
    }
  }

  // 수수료(가스)용 네이티브 코인 부족
  for (const [id, chain] of Object.entries(CHAINS)) {
    const a = adapter(id);
    if (!a.configured) continue;
    const bal = await a.gasBalance().catch(() => null);
    if (bal == null) continue;
    const low = gasLow(id, bal);
    const key = `gaslow_${id}`;
    if (low === (getSetting(key) === '1')) continue;
    setSetting(key, low ? '1' : '0');
    if (low)
      await ch.send({
        ...adminMention,
        embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`⛽ ${chain.name} 수수료용 ${chain.native} 부족`)
          .setDescription(`현재 ${fmtCoin(bal, 6)} ${chain.native} (권장 최소 ${chain.gasWarn})\n송금 수수료가 부족하면 전송이 실패합니다.\n\`${hotAddress(id)}\``)],
      });
  }
}
