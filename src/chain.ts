// Slipway data layer: every read below goes through the official
// @ammora-protocol/sdk (deployment registry, ABIs, ALCClient quotes and
// launch prediction) plus viem as the SDK's transport.
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  ALCClient,
  giwaSepoliaAtomicLaunchDeployment as DEP,
  segmentedALCConfigRegistryV3Abi,
  segmentedALCLaunchFactoryV3Abi,
  segmentedBondingCurveV3Abi,
} from '@ammora-protocol/sdk';

export const deployment = DEP;
export const FACTORY = DEP.contracts.launchFactory as Address;
export const REGISTRY = DEP.contracts.configRegistry as Address;
export const RPC_URL = 'https://sepolia-rpc.giwa.io';
export const EXPLORER = 'https://sepolia-explorer.giwa.io';
export const DEPLOY_START_BLOCK = 36_220_000; // autoroute deployment start (SDK manifest)
const LOG_CHUNK = 10_000n; // GIWA RPC rejects eth_getLogs ranges above 10,000 blocks

export const giwaChain = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: EXPLORER } },
});

export const publicClient: PublicClient = createPublicClient({
  chain: giwaChain,
  transport: http(RPC_URL, { batch: true, timeout: 30_000 }),
});

const factoryAbi = segmentedALCLaunchFactoryV3Abi as unknown as readonly Record<string, unknown>[];
const curveAbi = segmentedBondingCurveV3Abi as unknown as readonly Record<string, unknown>[];
const registryAbi = segmentedALCConfigRegistryV3Abi as unknown as readonly Record<string, unknown>[];
const LAUNCH_TOPIC = toEventSelector(
  'LaunchCreated(address,address,address,uint256,bytes32,uint16,string)',
);

export interface LaunchRec {
  token: Address;
  curve: Address;
  creator: Address;
  configId: string;
  block: number;
  uri: string;
}

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
}

export interface CurveState {
  sqrtPrice?: bigint;
  status?: number;
  feeBps?: number;
  baseReserve?: bigint;
  quoteReserve?: bigint;
  migrationQuoteThreshold?: bigint;
  baseToken?: Address;
  quoteToken?: Address;
  canonicalPool?: Address;
}

export interface LaunchConfig {
  id: number;
  enabled: boolean;
  segments: { lower: bigint; upper: bigint; liquidity: bigint }[];
  hash?: string;
}

// ---------- local cache (discovery is a long log scan; keep progress) ----------
const LS_LAUNCHES = 'slipway.v1.launches';
const LS_RANGES = 'slipway.v1.ranges';
const LS_META = 'slipway.v1.meta';

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: run uncached */
  }
}

// ---------- block + discovery ----------
export function getBlockNumber(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

type Range = [number, number];

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function gaps(ranges: Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  let cur = from;
  for (const [a, b] of mergeRanges(ranges)) {
    if (b < cur) continue;
    if (a > cur) out.push([cur, Math.min(a - 1, to)]);
    cur = Math.max(cur, b + 1);
    if (cur > to) return out;
  }
  if (cur <= to) out.push([cur, to]);
  return out;
}

export interface ScanUpdate {
  launches: LaunchRec[];
  scanning: boolean;
  scannedTo: number;
  head: number;
}

export async function scanLaunches(onUpdate: (u: ScanUpdate) => void): Promise<void> {
  const head = Number(await getBlockNumber());
  const byCurve = new Map<string, LaunchRec>();
  for (const l of lsGet<LaunchRec[]>(LS_LAUNCHES) ?? []) byCurve.set(l.curve.toLowerCase(), l);
  let ranges = lsGet<Range[]>(LS_RANGES) ?? [];

  const emit = (scanning: boolean) => {
    const launches = [...byCurve.values()].sort((a, b) => b.block - a.block);
    const scannedTo = ranges.length ? Math.max(...ranges.map((r) => r[1])) : 0;
    onUpdate({ launches, scanning, scannedTo, head });
  };
  emit(true);

  // Work list: every unscanned 10k chunk in [DEPLOY_START, head], newest first
  // so fresh launches appear before the deep history backfill finishes.
  const chunks: Range[] = [];
  for (const [a, b] of gaps(ranges, DEPLOY_START_BLOCK, head)) {
    for (let s = a; s <= b; s += Number(LOG_CHUNK)) chunks.push([s, Math.min(s + Number(LOG_CHUNK) - 1, b)]);
  }
  chunks.sort((x, y) => y[1] - x[1]);

  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ([from, to]) => {
        try {
          const logs = (await publicClient.request({
            method: 'eth_getLogs',
            params: [
              {
                address: FACTORY,
                topics: [LAUNCH_TOPIC],
                fromBlock: `0x${from.toString(16)}`,
                toBlock: `0x${to.toString(16)}`,
              },
            ],
          } as never)) as { topics: Hex[]; data: Hex; blockNumber: Hex }[];
          for (const log of logs) {
            try {
              const decoded = decodeEventLog({
                abi: factoryAbi,
                data: log.data,
                topics: log.topics,
              } as never) as unknown as {
                args: { token: Address; curve: Address; creator: Address; configId: bigint; metadataURI: string };
              };
              const rec: LaunchRec = {
                token: decoded.args.token,
                curve: decoded.args.curve,
                creator: decoded.args.creator,
                configId: decoded.args.configId.toString(),
                block: Number(BigInt(log.blockNumber)),
                uri: decoded.args.metadataURI ?? '',
              };
              byCurve.set(rec.curve.toLowerCase(), rec);
            } catch {
              /* undecodable log: skip */
            }
          }
        } catch {
          /* RPC hiccup on one chunk: leave the gap for the next visit */
          return;
        }
        ranges = mergeRanges([...ranges, [from, to]]);
      }),
    );
    lsSet(LS_LAUNCHES, [...byCurve.values()]);
    lsSet(LS_RANGES, ranges);
    emit(true);
  }
  emit(false);
}

// ---------- token metadata ----------
const metaCache = new Map<string, TokenMeta>();
for (const [k, v] of Object.entries(lsGet<Record<string, TokenMeta>>(LS_META) ?? {})) metaCache.set(k, v);

export async function tokenMeta(token: Address): Promise<TokenMeta> {
  const key = token.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;
  const read = async (functionName: 'name' | 'symbol' | 'decimals') =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName } as never).catch(() => null);
  const [name, symbol, decimals] = await Promise.all([read('name'), read('symbol'), read('decimals')]);
  const meta: TokenMeta = {
    name: (name as string) ?? 'Unknown token',
    symbol: (symbol as string) ?? '???',
    decimals: (decimals as number) ?? 18,
  };
  metaCache.set(key, meta);
  lsSet(LS_META, Object.fromEntries(metaCache));
  return meta;
}

// ---------- curve state + quotes (SDK ALCClient) ----------
export function alcFor(curve: Address): ALCClient {
  return new ALCClient(publicClient, curve, REGISTRY);
}

export async function curveState(curve: Address): Promise<CurveState> {
  const read = async (functionName: string) =>
    publicClient
      .readContract({ address: curve, abi: curveAbi as never, functionName: functionName as never })
      .catch(() => undefined);
  const [sqrtPrice, status, feeBps, baseReserve, quoteReserve, threshold, baseToken, quoteToken, canonicalPool] =
    await Promise.all([
      read('sqrtPrice'),
      read('status'),
      read('currentFeeBps'),
      read('baseReserve'),
      read('quoteReserve'),
      read('migrationQuoteThreshold'),
      read('baseToken'),
      read('quoteToken'),
      read('canonicalPool'),
    ]);
  return {
    sqrtPrice: sqrtPrice as bigint | undefined,
    status: status !== undefined ? Number(status) : undefined,
    feeBps: feeBps !== undefined ? Number(feeBps) : undefined,
    baseReserve: baseReserve as bigint | undefined,
    quoteReserve: quoteReserve as bigint | undefined,
    migrationQuoteThreshold: threshold as bigint | undefined,
    baseToken: baseToken as Address | undefined,
    quoteToken: quoteToken as Address | undefined,
    canonicalPool: canonicalPool as Address | undefined,
  };
}

export interface QuoteResult {
  amountOut: bigint;
  fee: bigint;
  amountIn: bigint;
}

export async function quote(curve: Address, amountIn: bigint, baseForQuote: boolean): Promise<QuoteResult> {
  const q = await alcFor(curve).quoteExactInput(amountIn, baseForQuote);
  return { amountOut: q.amountOut, fee: q.fee, amountIn: q.amountIn };
}

export interface CurvePoint {
  supplyOut: number; // cumulative base tokens out (human units)
  price: number; // marginal price, quote human units per base token
}

/** Sample the bonding curve with real SDK quotes and derive marginal prices. */
export async function sampleCurve(
  curve: Address,
  baseDecimals: number,
  quoteDecimals: number,
): Promise<{ points: CurvePoint[]; side: 'buy' | 'sell' }> {
  const alc = alcFor(curve);
  const steps = 22;
  const buyAmounts: bigint[] = [];
  for (let i = 0; i < steps; i++) {
    const exp = 15 + (3.3 * i) / (steps - 1); // 0.001 -> ~2 quote units
    buyAmounts.push(BigInt(Math.floor(10 ** exp)));
  }
  const trySide = async (baseForQuote: boolean, amounts: bigint[]) => {
    const results = await Promise.all(
      amounts.map(async (a) => {
        try {
          const q = await alc.quoteExactInput(a, baseForQuote);
          return { inRaw: a, outRaw: q.amountOut };
        } catch {
          return null;
        }
      }),
    );
    return results.filter((r): r is { inRaw: bigint; outRaw: bigint } => r !== null);
  };
  let side: 'buy' | 'sell' = 'buy';
  let raw = await trySide(false, buyAmounts);
  if (raw.length < 3) {
    side = 'sell';
    const sellAmounts = buyAmounts.map((a) => a * 10n ** BigInt(Math.max(0, baseDecimals - 6)));
    raw = await trySide(true, sellAmounts);
  }
  const points: CurvePoint[] = [];
  for (let i = 1; i < raw.length; i++) {
    const dIn = Number(raw[i].inRaw - raw[i - 1].inRaw);
    const dOut = Number(raw[i].outRaw - raw[i - 1].outRaw);
    if (dIn <= 0 || dOut <= 0) continue;
    // buy side: in=quote, out=base. sell side: in=base, out=quote.
    const priceRaw = side === 'buy' ? dIn / dOut : dOut / dIn;
    const supplyRaw = side === 'buy' ? raw[i].outRaw : raw[i].inRaw;
    points.push({
      supplyOut: Number(supplyRaw) / 10 ** baseDecimals,
      price: priceRaw * 10 ** (baseDecimals - quoteDecimals),
    });
  }
  return { points, side };
}

// ---------- launch configs (SDK registry ABI) ----------
export async function listConfigs(): Promise<LaunchConfig[]> {
  const next = (await publicClient.readContract({
    address: REGISTRY,
    abi: registryAbi as never,
    functionName: 'nextConfigId' as never,
  })) as bigint;
  const total = Math.min(Number(next) - 1, 64);
  const out: LaunchConfig[] = [];
  for (let id = 1; id <= total; id++) {
    const [enabled, segments, hash] = await Promise.all([
      publicClient
        .readContract({ address: REGISTRY, abi: registryAbi as never, functionName: 'enabled' as never, args: [BigInt(id)] })
        .catch(() => false),
      publicClient
        .readContract({ address: REGISTRY, abi: registryAbi as never, functionName: 'getCurve' as never, args: [BigInt(id)] })
        .catch(() => []),
      publicClient
        .readContract({ address: REGISTRY, abi: registryAbi as never, functionName: 'configHash' as never, args: [BigInt(id)] })
        .catch(() => undefined),
    ]);
    const segs = (segments as { lowerSqrtPrice: bigint; upperSqrtPrice: bigint; liquidity: bigint }[]).map((s) => ({
      lower: s.lowerSqrtPrice,
      upper: s.upperSqrtPrice,
      liquidity: s.liquidity,
    }));
    out.push({ id, enabled: Boolean(enabled), segments: segs, hash: hash as string | undefined });
  }
  return out;
}

/** Spot price (quote per base, human units) implied by a Q64 sqrt price. */
export function priceFromSqrt(sqrtPrice: bigint, baseDecimals: number, quoteDecimals: number): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}

// ---------- launch planning + execution ----------
const DEMO_CREATOR = '0x000000000000000000000000000000000000dEaD' as Address;
export { DEMO_CREATOR };

export async function predictLaunch(
  creator: Address,
  configId: bigint,
  metadataURI: string,
): Promise<{ token: Address; curve: Address }> {
  const alc = new ALCClient(publicClient, DEP.contracts.curveImplementation as Address, REGISTRY);
  const p = await alc.getPredictedLaunch({ factory: FACTORY, creator, configId, metadataURI });
  return { token: p.token as Address, curve: p.curve as Address };
}

export function createLaunchCalldata(name: string, symbol: string, metadataURI: string, configId: bigint): Hex {
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: 'createLaunch',
    args: [name, symbol, metadataURI, configId],
  } as never);
}

export async function simulateLaunch(
  creator: Address,
  name: string,
  symbol: string,
  metadataURI: string,
  configId: bigint,
): Promise<{ ok: boolean; message: string }> {
  try {
    await publicClient.simulateContract({
      address: FACTORY,
      abi: factoryAbi as never,
      functionName: 'createLaunch' as never,
      args: [name, symbol, metadataURI, configId] as never,
      account: creator,
    });
    return { ok: true, message: 'Simulation passed against live chain state. The launch would succeed from this address.' };
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return { ok: false, message: (err.shortMessage ?? err.message ?? 'Simulation reverted.').slice(0, 300) };
  }
}

// ---------- wallet (visitor's own, testnet only) ----------
declare global {
  interface Window {
    ethereum?: unknown;
  }
}

export async function connectWallet(): Promise<{ address: Address; client: WalletClient }> {
  if (!window.ethereum) throw new Error('No browser wallet found. Install a wallet extension to connect.');
  const client = createWalletClient({ chain: giwaChain, transport: custom(window.ethereum as never) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: giwaChain.id });
  } catch {
    await (window.ethereum as { request: (a: unknown) => Promise<unknown> }).request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: `0x${giwaChain.id.toString(16)}`,
          chainName: giwaChain.name,
          nativeCurrency: giwaChain.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    });
    await client.switchChain({ id: giwaChain.id });
  }
  return { address, client };
}

export async function executeLaunch(
  wallet: { address: Address; client: WalletClient },
  name: string,
  symbol: string,
  metadataURI: string,
  configId: bigint,
): Promise<Hex> {
  const hash = await wallet.client.writeContract({
    address: FACTORY,
    abi: factoryAbi as never,
    functionName: 'createLaunch' as never,
    args: [name, symbol, metadataURI, configId] as never,
    account: wallet.address,
    chain: giwaChain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
