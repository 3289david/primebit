import { Contract, JsonRpcProvider, Wallet, formatUnits, isAddress } from 'ethers';
import { toUnits } from '../util.js';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
];

export function evmAdapter(cfg) {
  const pk = process.env[cfg.keyEnv];
  let provider = null;
  let wallet = null;
  const prov = () => (provider ??= new JsonRpcProvider(process.env[cfg.rpcEnv] || cfg.rpc, cfg.chainId, { staticNetwork: true }));
  const signer = () => (wallet ??= new Wallet(pk, prov()));
  const address = () => (pk ? new Wallet(pk).address : null);

  return {
    configured: !!pk,
    address,
    valid: (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && isAddress(a),

    async gasBalance() {
      return Number(formatUnits(await prov().getBalance(address()), 18));
    },
    async balance(coin) {
      if (!coin.contract) return this.gasBalance();
      const raw = await new Contract(coin.contract, ERC20, prov()).balanceOf(address());
      return Number(formatUnits(raw, coin.decimals));
    },
    async send(coin, to, amount) {
      const units = toUnits(amount, coin.dp, coin.decimals);
      const tx = coin.contract
        ? await new Contract(coin.contract, ERC20, signer()).transfer(to, units)
        : await signer().sendTransaction({ to, value: units });
      return tx.hash;
    },
    async check(txid) {
      const r = await prov().getTransactionReceipt(txid);
      if (!r) return { state: 'pending', detail: '블록 대기' };
      if (r.status === 0) return { state: 'failed', detail: 'reverted' };
      const conf = await r.confirmations();
      return conf >= cfg.confirmations
        ? { state: 'confirmed' }
        : { state: 'pending', detail: `${conf}/${cfg.confirmations} 컨펌` };
    },
  };
}
