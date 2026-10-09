import { Client, Wallet, isValidClassicAddress, xrpToDrops } from 'xrpl';

/** 주소 입력 형식: r주소  또는  r주소:데스티네이션태그 */
export function parseXrpDest(input) {
  const [addr, tag] = String(input).trim().split(':');
  return { addr, tag: tag === undefined ? undefined : Number(tag) };
}

export function xrpAdapter(cfg) {
  const seed = process.env[cfg.keyEnv];
  const url = () => process.env[cfg.rpcEnv] || cfg.rpc;
  const wallet = () => Wallet.fromSeed(seed.trim());
  const address = () => (seed ? wallet().classicAddress : null);

  // 호출마다 연결/해제 (장시간 연결 유지 문제 방지)
  async function withClient(fn) {
    const client = new Client(url());
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  return {
    configured: !!seed,
    address,
    valid(input) {
      const { addr, tag } = parseXrpDest(input);
      if (!isValidClassicAddress(addr)) return false;
      return tag === undefined || (Number.isInteger(tag) && tag >= 0 && tag <= 4294967295);
    },
    /** 사용 가능 XRP = 잔액 - 기본 예치금(1 XRP) */
    async gasBalance() {
      return withClient(async (c) => Math.max(0, Number(await c.getXrpBalance(address())) - 1));
    },
    async balance() {
      return this.gasBalance();
    },
    async send(coin, to, amount) {
      const { addr, tag } = parseXrpDest(to);
      return withClient(async (c) => {
        const w = wallet();
        const payment = {
          TransactionType: 'Payment',
          Account: w.classicAddress,
          Destination: addr,
          Amount: xrpToDrops(amount.toFixed(coin.dp)),
          ...(tag !== undefined ? { DestinationTag: tag } : {}),
        };
        const signed = w.sign(await c.autofill(payment));
        const res = await c.submit(signed.tx_blob);
        const code = res.result.engine_result;
        if (!/^(tesSUCCESS|terQUEUED)$/.test(code)) throw new Error(`XRP 제출 거부: ${code} ${res.result.engine_result_message || ''}`);
        return signed.hash;
      });
    },
    async check(txid, ageMs = 0) {
      return withClient(async (c) => {
        try {
          const r = await c.request({ command: 'tx', transaction: txid });
          if (!r.result.validated) return { state: 'pending', detail: '검증 대기' };
          const code = r.result.meta?.TransactionResult;
          return code === 'tesSUCCESS' ? { state: 'confirmed' } : { state: 'failed', detail: code };
        } catch (e) {
          if (/txnNotFound/i.test(e.message || e.data?.error || '')) {
            return ageMs > 5 * 60_000 ? { state: 'failed', detail: '원장에 포함되지 않음(만료)' } : { state: 'pending', detail: '원장 대기' };
          }
          throw e;
        }
      });
    },
  };
}
