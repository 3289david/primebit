import crypto from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits,
  MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { config, COINS, CHAINS, COLOR, explorerUrl } from '../config.js';
import { db, getSetting, numSetting, now } from '../db.js';
import { ensureUser, assertNotBanned, assertOpen } from '../services/points.js';
import { createCharge, cancelCharge } from '../services/charges.js';
import { makeQuote, placeOrder, precheckBuy } from '../services/orders.js';
import { enabledCoins } from '../services/wallet.js';
import { UserError, bus, krw, pts, fmtTime, fmtCoin, parseInt0, maskName } from '../util.js';
import {
  mainPanelPayload, refreshStatusMessage, setupStatusChannel, setupVoiceBoard, refreshVoiceBoard, checkStockAlerts,
} from './status.js';

const EPH = MessageFlags.Ephemeral;
const quotes = new Map(); // token -> { userId, coin, address, quote, exp }

export const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('PrimeBIT 설정 (관리자)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('panel').setDescription('현재 채널에 메인 패널 설치'))
    .addSubcommand((s) => s.setName('status').setDescription('현재 채널에 실시간 현황 메시지 설치'))
    .addSubcommand((s) => s.setName('voice').setDescription('음성채널 시세판(환율/김프/재고) 생성'))
    .toJSON(),
];

// ───────────────────────── 헬퍼 ─────────────────────────
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const input = (id, label, placeholder, style = TextInputStyle.Short, max = 100) =>
  row(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(true).setMaxLength(max));
/** keys: 선택지에 넣을 코인 키 목록 (구매/계산기 = 판매 중인 코인, 매입 신청 = 전체) */
const coinSelect = (id, keys) => {
  if (!keys.length) throw new UserError('현재 판매 중인 코인이 없습니다. 재고 현황을 확인해주세요.');
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder('코인을 선택하세요')
      .addOptions(keys.slice(0, 25).map((k) => ({ label: COINS[k].label.slice(0, 100), value: k }))),
  );
};
const lastAddress = (userId, coin) => db.prepare('SELECT address FROM addresses WHERE discord_id=? AND coin=?').get(userId, coin)?.address;
const explorerLine = (o) => (explorerUrl(o.coin, o.txid) ? `[블록 탐색기에서 보기](${explorerUrl(o.coin, o.txid)})` : '');
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator) || (config.adminRoleId && i.member?.roles?.cache?.has(config.adminRoleId));

export async function adminLog(payload, ping = false) {
  if (!config.adminLogChannelId) return;
  const ch = await client.channels.fetch(config.adminLogChannelId).catch(() => null);
  if (!ch) return;
  const content = ping && config.adminRoleId ? `<@&${config.adminRoleId}>` : undefined;
  await ch.send({ content, allowedMentions: { roles: ping && config.adminRoleId ? [config.adminRoleId] : [] }, ...payload }).catch(console.error);
}
async function dm(userId, payload) {
  const u = await client.users.fetch(userId).catch(() => null);
  if (u) await u.send(typeof payload === 'string' ? { content: payload } : payload).catch(() => {});
}
const statusKo = { pending: '⏳ 대기', done: '✅ 완료', expired: '⌛ 만료', cancelled: '❌ 취소', sending: '📤 전송중', confirming: '🔄 블록확인중', error: '⚠️ 확인중', refunded: '↩️ 환불' };

// ───────────────────────── 버튼 ─────────────────────────
async function onButton(i) {
  const [kind, arg] = i.customId.split(':');

  if (kind === 'charge') {
    assertOpen();
    assertNotBanned(i.user.id);
    return i.showModal(
      new ModalBuilder().setCustomId('charge').setTitle('충전 신청').addComponents(
        input('name', '입금자명 (실제 입금하실 이름)', '홍길동', TextInputStyle.Short, 20),
        input('amount', '충전 금액(원)', `${numSetting('charge_min').toLocaleString()} 이상`, TextInputStyle.Short, 12),
      ),
    );
  }
  if (kind === 'charge_cancel') {
    const ok = cancelCharge(Number(arg), i.user.id);
    return i.update({ content: ok ? '충전 신청을 취소했습니다.' : '이미 처리된 신청입니다.', embeds: [], components: [] });
  }
  if (kind === 'buy') {
    assertOpen();
    assertNotBanned(i.user.id);
    return i.reply({ flags: EPH, content: '구매할 코인(네트워크)을 선택하세요.', components: [coinSelect('buy_coin', enabledCoins())] });
  }
  if (kind === 'calc') {
    return i.reply({ flags: EPH, content: '계산할 코인을 선택하세요.', components: [coinSelect('calc_coin', enabledCoins())] });
  }
  if (kind === 'sell') {
    assertNotBanned(i.user.id);
    return i.reply({ flags: EPH, content: '매입(판매) 신청할 코인을 선택하세요.', components: [coinSelect('sell_coin', Object.keys(COINS))] });
  }
  if (kind === 'me') return showMe(i);
  if (kind === 'history') return showHistory(i);
  if (kind === 'ticket') return openTicket(i);
  if (kind === 'ticket_close') return closeTicket(i);

  if (kind === 'buyok') {
    const q = quotes.get(arg);
    if (!q || q.userId !== i.user.id) return i.update({ content: '만료된 요청입니다. 다시 시도해주세요.', embeds: [], components: [] });
    if (q.exp < now()) {
      quotes.delete(arg);
      return i.update({ content: '⏱️ 견적이 만료되었습니다. 다시 구매를 눌러주세요.', embeds: [], components: [] });
    }
    quotes.delete(arg); // 1회용 → 중복 클릭 방지
    await i.update({ content: '⏳ 처리 중입니다...', embeds: [], components: [] });
    try {
      const o = await placeOrder(i.user.id, q.coin, q.address, q.quote);
      if (o.status === 'confirming') {
        return i.editReply({
          content: '📤 코인을 전송했습니다. 블록체인 확정 후 DM으로 알려드립니다. (네트워크에 따라 수 초 ~ 수십 분)',
          embeds: [orderEmbed(o, '🔄 전송됨 · 블록 확인 중')],
        });
      }
      return i.editReply({
        content: '⚠️ 전송 처리 중 문제가 발생했습니다. 포인트는 안전하게 보관되며, 관리자가 확인 후 재전송 또는 환불해드립니다.',
        embeds: [orderEmbed(o, '⚠️ 확인 중')],
      });
    } catch (e) {
      return i.editReply({ content: `❌ ${e instanceof UserError ? e.message : '오류가 발생했습니다.'}`, embeds: [] });
    }
  }
  if (kind === 'buycancel') {
    quotes.delete(arg);
    return i.update({ content: '구매를 취소했습니다.', embeds: [], components: [] });
  }
  if (kind === 'stock_role') {
    const m = i.member;
    if (m.roles.cache.has(config.stockRoleId)) {
      await m.roles.remove(config.stockRoleId);
      return i.reply({ flags: EPH, content: '🔕 재입고 알림을 껐습니다.' });
    }
    await m.roles.add(config.stockRoleId);
    return i.reply({ flags: EPH, content: '🔔 재입고 알림을 켰습니다.' });
  }
}

function orderEmbed(o, title) {
  return new EmbedBuilder()
    .setColor(o.status === 'done' ? 0x2ecc71 : 0xf1c40f)
    .setTitle(title)
    .addFields(
      { name: '주문번호', value: `#${o.id}`, inline: true },
      { name: '코인', value: `${fmtCoin(o.coin_amount)} ${COINS[o.coin].symbol}`, inline: true },
      { name: '네트워크', value: CHAINS[COINS[o.coin].chain].name, inline: true },
      { name: '사용 포인트', value: pts(o.points_used), inline: true },
      { name: '수수료', value: pts(o.fee), inline: true },
      { name: '적용 시세', value: krw(o.price), inline: true },
      { name: '받는 주소', value: `\`${o.address}\`` },
      ...(o.txid ? [{ name: 'TXID', value: `\`${o.txid}\`\n${explorerLine(o)}` }] : []),
    );
}

// ───────────────────────── 셀렉트 ─────────────────────────
async function onSelect(i) {
  const coin = i.values[0];
  const c = COINS[coin];
  if (i.customId === 'buy_coin') {
    const chain = CHAINS[c.chain];
    const addrRow = input('address', `${c.symbol} 받을 주소 (${chain.name})`.slice(0, 45), chain.addrHint, TextInputStyle.Short, 100);
    const last = lastAddress(i.user.id, coin);
    if (last) addrRow.components[0].setValue(last); // 지난번 주소 자동 입력
    return i.showModal(
      new ModalBuilder().setCustomId(`buy:${coin}`).setTitle(`${coin} 구매`.slice(0, 45)).addComponents(
        addrRow,
        input('points', '사용할 포인트', `${numSetting('buy_min').toLocaleString()} 이상 (수수료 포함 금액)`, TextInputStyle.Short, 12),
      ),
    );
  }
  if (i.customId === 'calc_coin') {
    return i.showModal(
      new ModalBuilder().setCustomId(`calc:${coin}`).setTitle(`${coin} 계산기`.slice(0, 45)).addComponents(
        input('points', '사용할 포인트(원)', '예: 100000', TextInputStyle.Short, 12),
      ),
    );
  }
  if (i.customId === 'sell_coin') {
    return i.showModal(
      new ModalBuilder().setCustomId(`sell:${coin}`).setTitle(`${coin} 매입 신청`.slice(0, 45)).addComponents(
        input('amount', `판매할 ${c.symbol} 수량`, '예: 100', TextInputStyle.Short, 20),
        input('bank', '입금받을 계좌 (은행 / 계좌번호 / 예금주)', '국민 123456-01-123456 홍길동', TextInputStyle.Paragraph, 200),
      ),
    );
  }
}

// ───────────────────────── 모달 ─────────────────────────
async function onModal(i) {
  const [kind, arg] = i.customId.split(':');

  if (kind === 'charge') {
    const amount = parseInt0(i.fields.getTextInputValue('amount'));
    const c = createCharge(i.user.id, i.fields.getTextInputValue('name'), amount);
    const exp = numSetting('charge_expire_min');
    const bank = getSetting('bank_name') ? `${getSetting('bank_name')} ${getSetting('bank_account')}\n예금주 ${getSetting('bank_holder')}` : '(관리자가 계좌를 아직 설정하지 않았습니다)';
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('💳 충전 신청 완료')
      .setDescription(`아래 계좌로 **${exp}분 이내** 정확히 입금해주세요.\n입금이 확인되면 자동으로 포인트가 지급됩니다.`)
      .addFields(
        { name: '입금 계좌', value: `\`\`\`${bank}\`\`\`` },
        { name: '입금자명', value: `**${c.depositor}**`, inline: true },
        { name: '입금 금액', value: `**${krw(c.amount)}**`, inline: true },
      )
      .setFooter({ text: '입금자명·금액이 다르면 자동 지급되지 않습니다. 이 경우 문의 티켓을 열어주세요.' });
    return i.reply({
      flags: EPH,
      embeds: [embed],
      components: [row(new ButtonBuilder().setCustomId(`charge_cancel:${c.id}`).setLabel('신청 취소').setStyle(ButtonStyle.Danger))],
    });
  }

  if (kind === 'buy') {
    const points = parseInt0(i.fields.getTextInputValue('points'));
    const user = ensureUser(i.user.id);
    if (user.points < points) throw new UserError(`포인트가 부족합니다. (보유 ${pts(user.points)})`);
    const { quote, address } = await precheckBuy(i.user.id, arg, i.fields.getTextInputValue('address'), points);
    const token = crypto.randomBytes(8).toString('hex');
    quotes.set(token, { userId: i.user.id, coin: arg, address, quote, exp: now() + 60_000 });
    setTimeout(() => quotes.delete(token), 61_000).unref();
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('🧾 구매 견적 확인')
      .addFields(
        { name: '사용 포인트', value: pts(quote.points), inline: true },
        { name: `수수료 (${(quote.feeRate * 100).toFixed(1)}%)`, value: `- ${pts(quote.fee)}`, inline: true },
        { name: '구매 금액', value: krw(quote.net), inline: true },
        { name: '적용 시세', value: krw(quote.price), inline: true },
        { name: '받을 수량', value: `**${fmtCoin(quote.coinAmount)} ${COINS[arg].symbol}**`, inline: true },
        { name: '네트워크', value: `**${CHAINS[COINS[arg].chain].name}**`, inline: true },
        { name: '받는 주소', value: `\`${address}\`` },
      )
      .setFooter({ text: '60초 이내 확인해주세요. 블록체인 전송은 취소할 수 없으니 주소와 네트워크를 꼭 다시 확인하세요.' });
    return i.reply({
      flags: EPH,
      embeds: [embed],
      components: [
        row(
          new ButtonBuilder().setCustomId(`buyok:${token}`).setLabel('구매 확정').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`buycancel:${token}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  if (kind === 'calc') {
    const q = makeQuote(arg, parseInt0(i.fields.getTextInputValue('points')));
    return i.reply({
      flags: EPH,
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`🧮 ${arg} 계산 결과`).addFields(
        { name: '사용 포인트', value: pts(q.points), inline: true },
        { name: `수수료 ${(q.feeRate * 100).toFixed(1)}%`, value: `- ${pts(q.fee)}`, inline: true },
        { name: '받을 수량', value: `**${fmtCoin(q.coinAmount)} ${COINS[arg].symbol}**`, inline: true },
        { name: '적용 시세', value: krw(q.price), inline: true },
      ).setFooter({ text: '참고용 계산입니다. 실제 구매 시점의 시세로 확정됩니다.' })],
    });
  }

  if (kind === 'sell') {
    assertNotBanned(i.user.id);
    const amount = Number(i.fields.getTextInputValue('amount').replace(/,/g, ''));
    if (!(amount > 0)) throw new UserError('수량을 올바르게 입력해주세요.');
    const bankInfo = i.fields.getTextInputValue('bank').trim();
    const r = db
      .prepare("INSERT INTO sell_requests(discord_id,coin,amount,bank_info,status,created_at) VALUES(?,?,?,?,'open',?)")
      .run(i.user.id, arg, amount, bankInfo, now());
    bus.emit('sell_new', { id: Number(r.lastInsertRowid), userId: i.user.id, coin: arg, amount, bankInfo });
    return i.reply({
      flags: EPH,
      content: `📥 매입 신청 **#${r.lastInsertRowid}** 이(가) 접수되었습니다. 관리자가 확인 후 DM/티켓으로 안내드립니다.\n(안내 전에는 코인을 먼저 보내지 마세요.)`,
    });
  }
}

// ───────────────────────── 내 정보 / 내역 ─────────────────────────
async function showMe(i) {
  const u = ensureUser(i.user.id);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`👤 ${i.user.username} 님의 정보`)
    .addFields(
      { name: '보유 포인트', value: `**${pts(u.points)}**`, inline: true },
      { name: '누적 충전', value: krw(u.total_charged), inline: true },
      { name: '누적 사용', value: krw(u.total_spent), inline: true },
      { name: '가입일', value: fmtTime(u.created_at) },
    );
  return i.reply({ flags: EPH, embeds: [embed] });
}

async function showHistory(i) {
  ensureUser(i.user.id);
  const charges = db.prepare('SELECT * FROM charges WHERE discord_id=? ORDER BY id DESC LIMIT 8').all(i.user.id);
  const orders = db.prepare('SELECT * FROM orders WHERE discord_id=? ORDER BY id DESC LIMIT 8').all(i.user.id);
  const cl = charges.map((c) => `${statusKo[c.status]} #${c.id} · ${krw(c.amount)} · ${fmtTime(c.created_at)}`).join('\n') || '내역 없음';
  const ol = orders.map((o) => `${statusKo[o.status]} #${o.id} · ${fmtCoin(o.coin_amount)} ${o.coin} · ${fmtTime(o.created_at)}`).join('\n') || '내역 없음';
  return i.reply({
    flags: EPH,
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🧾 최근 내역').addFields({ name: '충전', value: cl }, { name: '코인 구매', value: ol })],
  });
}

// ───────────────────────── 티켓 ─────────────────────────
async function openTicket(i) {
  const existing = db.prepare("SELECT * FROM tickets WHERE discord_id=? AND status='open'").get(i.user.id);
  if (existing && i.guild.channels.cache.has(existing.channel_id))
    return i.reply({ flags: EPH, content: `이미 열린 티켓이 있습니다: <#${existing.channel_id}>` });
  const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
  const overwrites = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow },
    { id: client.user.id, allow },
  ];
  if (config.adminRoleId) overwrites.push({ id: config.adminRoleId, allow });
  const count = db.prepare('SELECT COUNT(*) n FROM tickets').get().n + 1;
  const ch = await i.guild.channels.create({
    name: `ticket-${String(count).padStart(4, '0')}`,
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId || undefined,
    permissionOverwrites: overwrites,
  });
  db.prepare("INSERT INTO tickets(discord_id,channel_id,status,created_at) VALUES(?,?,'open',?)").run(i.user.id, ch.id, now());
  await ch.send({
    content: `<@${i.user.id}>${config.adminRoleId ? ` <@&${config.adminRoleId}>` : ''}`,
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🎫 문의 티켓').setDescription('문의 내용을 남겨주세요. 관리자가 곧 답변드립니다.\n(충전 문의 시 입금자명·금액·입금시간을 함께 적어주세요.)')],
    components: [row(new ButtonBuilder().setCustomId('ticket_close').setLabel('티켓 닫기').setEmoji('🔒').setStyle(ButtonStyle.Danger))],
  });
  return i.reply({ flags: EPH, content: `티켓이 생성되었습니다: <#${ch.id}>` });
}

async function closeTicket(i) {
  const t = db.prepare("SELECT * FROM tickets WHERE channel_id=? AND status='open'").get(i.channel.id);
  if (!t) return i.reply({ flags: EPH, content: '열린 티켓이 아닙니다.' });
  if (t.discord_id !== i.user.id && !isAdmin(i)) return i.reply({ flags: EPH, content: '권한이 없습니다.' });
  db.prepare("UPDATE tickets SET status='closed' WHERE id=?").run(t.id);
  await i.reply('🔒 5초 후 티켓 채널이 삭제됩니다.');
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}

// ───────────────────────── 슬래시 명령 ─────────────────────────
async function onCommand(i) {
  if (i.commandName !== 'setup') return;
  if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) return i.reply({ flags: EPH, content: '관리자만 사용할 수 있습니다.' });
  const sub = i.options.getSubcommand();
  await i.deferReply({ flags: EPH });
  if (sub === 'panel') {
    await i.channel.send(mainPanelPayload());
    return i.editReply('메인 패널을 설치했습니다.');
  }
  if (sub === 'status') {
    await setupStatusChannel(client, i.channel);
    return i.editReply('실시간 현황 메시지를 설치했습니다. (30초마다 자동 갱신)');
  }
  if (sub === 'voice') {
    await setupVoiceBoard(client, i.guild);
    return i.editReply('음성채널 시세판을 만들었습니다. (6분마다 자동 갱신)');
  }
}

// ───────────────────────── 이벤트 연결 ─────────────────────────
client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton()) return await onButton(i);
    if (i.isStringSelectMenu()) return await onSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (e) {
    const msg = e instanceof UserError ? `❌ ${e.message}` : '❌ 처리 중 오류가 발생했습니다.';
    if (!(e instanceof UserError)) console.error('[interaction]', e);
    try {
      if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] });
      else await i.reply({ flags: EPH, content: msg });
    } catch {}
  }
});

bus.on('charge_done', async (c) => {
  const u = ensureUser(c.discord_id);
  await dm(c.discord_id, {
    embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ 충전 완료').setDescription(`**${pts(c.amount)}** 이(가) 지급되었습니다.\n보유 포인트: **${pts(u.points)}**`)],
  });
  await adminLog({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`💳 충전 #${c.id} · <@${c.discord_id}> · ${c.depositor} · ${krw(c.amount)}`)] });
});
bus.on('order_done', async (o) => {
  const sym = COINS[o.coin].symbol;
  await dm(o.discord_id, {
    embeds: [orderEmbed(o, '✅ 코인 전송 확정 — 지갑에서 확인하세요')],
  });
  await adminLog({ embeds: [new EmbedBuilder().setColor(0x3498db).setDescription(`🪙 주문 #${o.id} 확정 · <@${o.discord_id}> · ${fmtCoin(o.coin_amount)} ${o.coin} · ${explorerLine(o)}`)] });
  // 공개 거래 로그 (이름 마스킹)
  if (config.tradeLogChannelId) {
    const ch = await client.channels.fetch(config.tradeLogChannelId).catch(() => null);
    const u = await client.users.fetch(o.discord_id).catch(() => null);
    await ch?.send({
      embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`✅ **${maskName(u?.username ?? '고객')}** 님 · **${fmtCoin(o.coin_amount)} ${sym}** (${CHAINS[COINS[o.coin].chain].name}) 전송 완료\n${explorerLine(o)}`).setTimestamp()],
    }).catch(() => {});
  }
});
// ── 사용자 자동 DM ──
bus.on('order_sent', (o) =>
  dm(o.discord_id, { embeds: [orderEmbed(o, '📤 코인을 전송했습니다 · 블록 확인 대기')] }));
bus.on('charge_expired', (c) =>
  dm(c.discord_id, `⌛ 충전 신청 #${c.id} (${krw(c.amount)}) 이(가) 시간 초과로 만료되었습니다.\n이미 입금하셨다면 문의 티켓을 열어 입금자명·금액·시간을 알려주세요.`));
bus.on('order_stuck', (o) =>
  adminLog({ embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`⏳ 주문 #${o.id} 확정 지연`).setDescription(`<@${o.discord_id}> · ${fmtCoin(o.coin_amount)} ${o.coin}\n전송 후 90분이 지나도 확정되지 않았습니다. 수수료 부족/네트워크 혼잡 여부를 확인하세요.\n${explorerLine(o)}`)] }, true));
bus.on('notice', async ({ text }) => {
  const id = config.alertChannelId;
  const ch = id ? await client.channels.fetch(id).catch(() => null) : null;
  await ch?.send({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📢 공지').setDescription(text)] }).catch(() => {});
});
bus.on('order_error', (o) => {
  dm(o.discord_id, `⚠️ 주문 #${o.id} 처리 중 문제가 발생해 관리자가 확인 중입니다. 사용하신 포인트는 안전하게 보관되며, 확인 후 재전송 또는 환불해드립니다.`);
  return adminLog({ content: undefined, embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle(`🚨 주문 #${o.id} 전송 실패`).setDescription(`<@${o.discord_id}> · ${fmtCoin(o.coin_amount)} ${o.coin}\n\`${o.error}\`\n온체인 전송 여부를 확인한 뒤 관리자 패널에서 재전송/환불하세요.`)] }, true);
});
bus.on('deposit_unmatched', (d) =>
  adminLog({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('❓ 미매칭 입금').setDescription(`#${d.id} · ${d.amount ? krw(d.amount) : '금액 파싱 실패'}\n\`\`\`${d.text}\`\`\`관리자 패널 > 입금내역에서 수동 매칭하세요.`)] }, true));
bus.on('sell_new', (s) =>
  adminLog({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`📥 매입 신청 #${s.id}`).addFields({ name: '신청자', value: `<@${s.userId}>`, inline: true }, { name: '수량', value: `${s.amount} ${s.coin}`, inline: true }, { name: '입금계좌', value: s.bankInfo })] }, true));
bus.on('notify_user', ({ userId, content }) => dm(userId, content));

// ───────────────────────── 시작 ─────────────────────────
export async function startBot() {
  client.once(Events.ClientReady, async () => {
    console.log(`[bot] 로그인: ${client.user.tag}`);
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
    const loop = (fn, ms) => setInterval(() => fn().catch((e) => console.error('[loop]', e.message)), ms);
    loop(() => refreshStatusMessage(client), 30_000);
    loop(() => refreshVoiceBoard(client), 6 * 60_000);
    loop(() => checkStockAlerts(client), 60_000);
  });
  await client.login(config.token);
}
