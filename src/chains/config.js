// 체인/코인 정의. 새 코인은 COINS 에 한 줄만 추가하면 됩니다 (EVM 체인/토큰은 어댑터 수정 불필요).

/**
 * family: 어댑터 종류 (tron | evm | sol | xrp | btc)
 * keyEnv: 해당 체인 핫월렛 개인키를 담는 환경변수 (EVM 체인은 모두 같은 키/같은 주소 공유)
 * confirmations: 이 블록 수 이상 쌓여야 '확정' 처리
 * gasWarn: 수수료용 네이티브 코인이 이 값 미만이면 관리자에게 경고
 */
export const CHAINS = {
  tron: { name: 'TRON (TRC20)', family: 'tron', native: 'TRX', keyEnv: 'TRON_PRIVATE_KEY', confirmations: 19, gasWarn: 100, explorerTx: 'https://tronscan.org/#/transaction/', addrHint: 'T로 시작 (34자)' },
  eth: { name: 'Ethereum (ERC20)', family: 'evm', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', rpcEnv: 'RPC_ETH', native: 'ETH', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 12, gasWarn: 0.02, explorerTx: 'https://etherscan.io/tx/', addrHint: '0x...' },
  bsc: { name: 'BNB Smart Chain (BEP20)', family: 'evm', chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', rpcEnv: 'RPC_BSC', native: 'BNB', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 15, gasWarn: 0.05, explorerTx: 'https://bscscan.com/tx/', addrHint: '0x...' },
  polygon: { name: 'Polygon', family: 'evm', chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', rpcEnv: 'RPC_POLYGON', native: 'POL', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 30, gasWarn: 20, explorerTx: 'https://polygonscan.com/tx/', addrHint: '0x...' },
  avax: { name: 'Avalanche C-Chain', family: 'evm', chainId: 43114, rpc: 'https://avalanche-c-chain-rpc.publicnode.com', rpcEnv: 'RPC_AVAX', native: 'AVAX', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 3, gasWarn: 1, explorerTx: 'https://snowtrace.io/tx/', addrHint: '0x...' },
  arb: { name: 'Arbitrum One', family: 'evm', chainId: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com', rpcEnv: 'RPC_ARB', native: 'ETH', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 5, gasWarn: 0.003, explorerTx: 'https://arbiscan.io/tx/', addrHint: '0x...' },
  op: { name: 'Optimism', family: 'evm', chainId: 10, rpc: 'https://optimism-rpc.publicnode.com', rpcEnv: 'RPC_OP', native: 'ETH', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 5, gasWarn: 0.003, explorerTx: 'https://optimistic.etherscan.io/tx/', addrHint: '0x...' },
  base: { name: 'Base', family: 'evm', chainId: 8453, rpc: 'https://base-rpc.publicnode.com', rpcEnv: 'RPC_BASE', native: 'ETH', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 5, gasWarn: 0.003, explorerTx: 'https://basescan.org/tx/', addrHint: '0x...' },
  linea: { name: 'Linea', family: 'evm', chainId: 59144, rpc: 'https://rpc.linea.build', rpcEnv: 'RPC_LINEA', native: 'ETH', keyEnv: 'EVM_PRIVATE_KEY', confirmations: 5, gasWarn: 0.003, explorerTx: 'https://lineascan.build/tx/', addrHint: '0x...' },
  sol: { name: 'Solana', family: 'sol', rpc: 'https://api.mainnet-beta.solana.com', rpcEnv: 'RPC_SOL', native: 'SOL', keyEnv: 'SOL_PRIVATE_KEY', confirmations: 1, gasWarn: 0.05, explorerTx: 'https://solscan.io/tx/', addrHint: '솔라나 지갑 주소' },
  xrp: { name: 'XRP Ledger', family: 'xrp', rpc: 'wss://xrplcluster.com', rpcEnv: 'RPC_XRP', native: 'XRP', keyEnv: 'XRP_SEED', confirmations: 1, gasWarn: 5, explorerTx: 'https://xrpscan.com/tx/', addrHint: 'r... 또는 r...:데스티네이션태그' },
  btc: { name: 'Bitcoin', family: 'btc', rpc: 'https://mempool.space/api', rpcEnv: 'RPC_BTC', native: 'BTC', keyEnv: 'BTC_WIF', confirmations: 2, gasWarn: 0.0005, explorerTx: 'https://mempool.space/tx/', addrHint: 'bc1... / 1... / 3...' },
};

const coin = (chain, symbol, label, o = {}) => ({
  chain, symbol, label,
  decimals: 6,        // 온체인 소수 자릿수
  dp: 6,              // 송금/견적에 쓰는 소수 자릿수 (decimals 이하)
  minAmount: 1,
  priceMode: 'upbit', // upbit: 업비트 KRW 마켓 | usd: 코인베이스 달러가 × 업비트 USDT 원화가
  ...o,
});

// key 는 '코인-네트워크'. 같은 심볼이라도 네트워크가 다르면 별도 상품입니다.
export const COINS = {
  'USDT-TRC20': coin('tron', 'USDT', '테더 USDT · TRON(TRC20)', { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }),
  TRX: coin('tron', 'TRX', '트론 TRX · TRON', { minAmount: 10 }),
  ETH: coin('eth', 'ETH', '이더리움 ETH · Ethereum', { decimals: 18, minAmount: 0.001 }),
  'USDT-ERC20': coin('eth', 'USDT', '테더 USDT · Ethereum(ERC20)', { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }),
  'USDC-ERC20': coin('eth', 'USDC', 'USDC · Ethereum(ERC20)', { contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }),
  BNB: coin('bsc', 'BNB', '비앤비 BNB · BSC', { decimals: 18, minAmount: 0.01, priceMode: 'usd' }),
  'USDT-BEP20': coin('bsc', 'USDT', '테더 USDT · BSC(BEP20)', { decimals: 18, contract: '0x55d398326f99059fF775485246999027B3197955' }),
  POL: coin('polygon', 'POL', '폴리곤 POL · Polygon', { decimals: 18 }),
  'USDT-POLYGON': coin('polygon', 'USDT', '테더 USDT · Polygon', { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' }),
  AVAX: coin('avax', 'AVAX', '아발란체 AVAX · C-Chain', { decimals: 18, minAmount: 0.1 }),
  'ETH-ARB': coin('arb', 'ETH', '이더리움 ETH · Arbitrum', { decimals: 18, minAmount: 0.001 }),
  'USDT-ARB': coin('arb', 'USDT', '테더 USDT · Arbitrum', { contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' }),
  'ETH-OP': coin('op', 'ETH', '이더리움 ETH · Optimism', { decimals: 18, minAmount: 0.001 }),
  'ETH-BASE': coin('base', 'ETH', '이더리움 ETH · Base', { decimals: 18, minAmount: 0.001 }),
  'USDC-BASE': coin('base', 'USDC', 'USDC · Base', { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
  'ETH-LINEA': coin('linea', 'ETH', '이더리움 ETH · Linea', { decimals: 18, minAmount: 0.001 }),
  SOL: coin('sol', 'SOL', '솔라나 SOL · Solana', { decimals: 9, minAmount: 0.01 }),
  'USDT-SOL': coin('sol', 'USDT', '테더 USDT · Solana', { contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }),
  'USDC-SOL': coin('sol', 'USDC', 'USDC · Solana', { contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
  XRP: coin('xrp', 'XRP', '리플 XRP · XRP Ledger', { minAmount: 1 }),
  BTC: coin('btc', 'BTC', '비트코인 BTC · Bitcoin', { decimals: 8, dp: 8, minAmount: 0.0001 }),
};

/** 음성채널 시세판에 보여줄 재고 코인 */
export const FEATURED = ['USDT-TRC20', 'BTC'];

export const explorerUrl = (coinKey, txid) => {
  const c = COINS[coinKey];
  return c && txid ? CHAINS[c.chain].explorerTx + txid : null;
};
