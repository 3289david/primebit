import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { toUnits } from '../util.js';

export function solanaAdapter(cfg) {
  const raw = process.env[cfg.keyEnv];
  let conn = null;
  let kp = null;
  const c = () => (conn ??= new Connection(process.env[cfg.rpcEnv] || cfg.rpc, 'confirmed'));
  const keypair = () =>
    (kp ??= Keypair.fromSecretKey(raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim())));
  const address = () => (raw ? keypair().publicKey.toBase58() : null);

  return {
    configured: !!raw,
    address,
    valid(a) {
      try {
        return typeof a === 'string' && a.length >= 32 && a.length <= 44 && new PublicKey(a).toBytes().length === 32;
      } catch {
        return false;
      }
    },
    async gasBalance() {
      return (await c().getBalance(keypair().publicKey)) / 1e9;
    },
    async balance(coin) {
      if (!coin.contract) return this.gasBalance();
      const ata = getAssociatedTokenAddressSync(new PublicKey(coin.contract), keypair().publicKey);
      try {
        return (await c().getTokenAccountBalance(ata)).value.uiAmount ?? 0;
      } catch {
        return 0; // 토큰 계정 없음 = 재고 0
      }
    },
    async send(coin, to, amount) {
      const units = toUnits(amount, coin.dp, coin.decimals);
      const from = keypair().publicKey;
      const dest = new PublicKey(to);
      const tx = new Transaction();
      if (!coin.contract) {
        tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: units }));
      } else {
        const mint = new PublicKey(coin.contract);
        const src = getAssociatedTokenAddressSync(mint, from);
        const dst = getAssociatedTokenAddressSync(mint, dest, true);
        // 받는 사람의 토큰 계정이 없으면 생성(수수료/렌트는 핫월렛 부담)
        tx.add(createAssociatedTokenAccountIdempotentInstruction(from, dst, dest, mint));
        tx.add(createTransferCheckedInstruction(src, mint, dst, from, units, coin.decimals));
      }
      return c().sendTransaction(tx, [keypair()], { preflightCommitment: 'confirmed' });
    },
    async check(txid, ageMs = 0) {
      const { value } = await c().getSignatureStatuses([txid], { searchTransactionHistory: true });
      const s = value[0];
      if (!s) return ageMs > 3 * 60_000 ? { state: 'failed', detail: '블록에 포함되지 않음(드롭 추정)' } : { state: 'pending', detail: '블록 대기' };
      if (s.err) return { state: 'failed', detail: JSON.stringify(s.err) };
      return s.confirmationStatus === 'finalized' ? { state: 'confirmed' } : { state: 'pending', detail: s.confirmationStatus };
    },
  };
}
