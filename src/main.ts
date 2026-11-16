import { formatUnits, parseUnits, type Address, type WalletClient } from 'viem';
import {
  EXPLORER,
  FACTORY,
  REGISTRY,
  connectWallet,
  createLaunchCalldata,
  curveState,
  deployment,
  executeLaunch,
  getBlockNumber,
  listConfigs,
  predictLaunch,
  priceFromSqrt,
  quote,
  sampleCurve,
  scanLaunches,
  simulateLaunch,
  tokenMeta,
  DEMO_CREATOR,
  type CurveState,
  type LaunchConfig,
  type LaunchRec,
  type TokenMeta,
} from './chain';

// ---------- helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return '—';
  if (p >= 0.01) return p.toFixed(4);
  if (p >= 1e-6) return p.toPrecision(3);
  return p.toExponential(2);
}

function fmtAmount(raw: bigint, decimals: number): string {
  const v = Number(formatUnits(raw, decimals));
  if (v >= 1_000_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (v > 0) return v.toPrecision(3);
  return '0';
}

const STATUS_LABELS: Record<number, string> = { 0: 'Pending', 1: 'Trading', 2: 'Migrated' };

// ---------- state ----------
let launches: LaunchRec[] = [];
let selected: LaunchRec | null = null;
let selectedMeta: TokenMeta | null = null;
let selectedState: CurveState | null = null;
let configs: LaunchConfig[] = [];
let wallet: { address: Address; client: WalletClient } | null = null;
let direction: 'buy' | 'sell' = 'buy';
let selectionSeq = 0;
let lastPlan: { name: string; symbol: string; uri: string; configId: bigint } | null = null;
const metaByToken = new Map<string, TokenMeta>();
const unavailableCurves = new Set<string>();
let userPicked = false;
let autoSelecting = false;

// ---------- header ----------
let blockFailures = 0;
async function tickBlock() {
  try {
    const n = await getBlockNumber();
    blockFailures = 0;
    $('blockTicker').textContent = `GIWA Sepolia · block ${fmtInt(Number(n))}`;
  } catch {
    // Do not flash "unreachable" for a single hiccup; reads already retry.
    blockFailures++;
    if (blockFailures >= 2) $('blockTicker').textContent = 'GIWA Sepolia · RPC unreachable, retrying…';
  }
}

$('connectBtn').addEventListener('click', async () => {
  const btn = $('connectBtn') as HTMLButtonElement;
  if (wallet) return;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    wallet = await connectWallet();
    btn.textContent = short(wallet.address);
    $('wCreator').textContent = `${wallet.address} (your wallet)`;
    $('planOut').textContent = 'Wallet connected. Run a preview to plan the launch from your address.';
    lastPlan = null;
    ($('wLaunch') as HTMLButtonElement).disabled = true;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Connect wallet';
    $('planOut').textContent = e instanceof Error ? e.message : 'Wallet connection failed.';
  }
});

// ---------- board ----------
function renderBoard() {
  const body = $('boardBody');
  if (!launches.length) {
    body.innerHTML = '<tr><td colspan="6" class="board-empty">Scanning the factory…</td></tr>';
    return;
  }
  body.innerHTML = launches
    .map((l) => {
      const meta = metaByToken.get(l.token.toLowerCase());
      const isSel = selected && selected.curve.toLowerCase() === l.curve.toLowerCase();
      const unavail = unavailableCurves.has(l.curve.toLowerCase());
      return `<tr data-curve="${l.curve}" class="${isSel ? 'selected' : ''}">
        <td><span class="token-name">${meta ? esc(meta.name) : 'Loading…'}</span><span class="token-sym">${meta ? esc(meta.symbol) : ''}</span></td>
        <td class="mono">#${esc(l.configId)}</td>
        <td class="mono">${fmtInt(l.block)}</td>
        <td class="mono">${short(l.creator)}</td>
        <td class="mono">${short(l.curve)}</td>
        <td>${isSel ? 'Selected' : unavail ? 'Unavailable' : 'Inspect'}</td>
      </tr>`;
    })
    .join('');
  for (const row of body.querySelectorAll('tr[data-curve]')) {
    row.addEventListener('click', () => {
      const rec = launches.find((l) => l.curve === row.getAttribute('data-curve'));
      if (rec) {
        userPicked = true;
        void selectLaunch(rec);
      }
    });
  }
}

async function ensureMeta(rec: LaunchRec) {
  const key = rec.token.toLowerCase();
  if (metaByToken.has(key)) return;
  const meta = await tokenMeta(rec.token);
  // Unresolved fallbacks are not pinned into the board map: tokenMeta does
  // not cache failures, so a later scan update retries the reads.
  if (!meta.resolved) return;
  metaByToken.set(key, meta);
  renderBoard();
  if (selected && selected.token.toLowerCase() === key) {
    selectedMeta = meta;
    renderSelectedHead();
  }
}

// ---------- selected launch / chart ----------
function renderSelectedHead() {
  if (!selected) return;
  const meta = selectedMeta;
  $('chartTitle').textContent = meta ? `${meta.name} (${meta.symbol})` : 'Launch';
  $('chartSub').textContent = `curve ${selected.curve} · token ${selected.token}`;
  const st = selectedState;
  if (st?.status !== undefined) {
    $('chartStatus').textContent = STATUS_LABELS[st.status] ?? `Status ${st.status}`;
  }
  if (st?.sqrtPrice !== undefined && meta) {
    $('csPrice').textContent = `${fmtPrice(priceFromSqrt(st.sqrtPrice, meta.decimals, 18))} WETH`;
  }
  if (st?.quoteReserve !== undefined) $('csQuoteReserve').textContent = `${fmtAmount(st.quoteReserve, 18)} WETH`;
  if (st?.baseReserve !== undefined && meta) $('csBaseReserve').textContent = `${fmtAmount(st.baseReserve, meta.decimals)} ${meta.symbol}`;
  if (st?.feeBps !== undefined) $('csFee').textContent = `${(st.feeBps / 100).toFixed(2)}%`;
  if (st?.quoteReserve !== undefined && st?.migrationQuoteThreshold && st.migrationQuoteThreshold > 0n) {
    const pct = Math.min(100, Number((st.quoteReserve * 10000n) / st.migrationQuoteThreshold) / 100);
    ($('migFill') as HTMLDivElement).style.width = `${pct}%`;
    $('migLabel').textContent = `${pct.toFixed(1)}% of ${fmtAmount(st.migrationQuoteThreshold, 18)} WETH threshold`;
  } else {
    $('migLabel').textContent = 'threshold unavailable for this curve';
  }
}

function drawChart(points: { supplyOut: number; price: number }[], side: 'buy' | 'sell', symbol: string) {
  const box = $('chartBox');
  if (points.length < 2) {
    box.innerHTML = '<p class="chart-empty">This curve did not answer quote sampling on either side. It may be paused or fully migrated.</p>';
    return;
  }
  const W = 640;
  const H = 250;
  const PAD = { l: 8, r: 8, t: 10, b: 22 };
  const xs = points.map((p) => Math.log10(Math.max(p.supplyOut, 1e-9)));
  const ys = points.map((p) => p.price);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const x = (v: number) => PAD.l + ((v - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(Math.log10(Math.max(p.supplyOut, 1e-9))).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const area = `${line} L${x(xMax).toFixed(1)},${H - PAD.b} L${x(xMin).toFixed(1)},${H - PAD.b} Z`;
  const last = points[points.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bonding curve sampled from live SDK quotes">
    <path d="${area}" fill="rgba(62,198,184,0.12)"></path>
    <path d="${line}" fill="none" stroke="#3ec6b8" stroke-width="2.5"></path>
    <circle cx="${x(Math.log10(Math.max(last.supplyOut, 1e-9)))}" cy="${y(last.price)}" r="4.5" fill="#ff7847"></circle>
    <text x="${PAD.l}" y="${H - 6}" fill="#8fa9b5" font-size="11" font-family="IBM Plex Mono">supply out (log scale) →</text>
    <text x="${W - PAD.r}" y="${H - 6}" fill="#8fa9b5" font-size="11" text-anchor="end" font-family="IBM Plex Mono">${esc(side)}-side quotes · ${esc(symbol)}</text>
    <text x="${PAD.l}" y="14" fill="#8fa9b5" font-size="11" font-family="IBM Plex Mono">price ${fmtPrice(yMax)} WETH</text>
  </svg>`;
}

async function selectLaunch(rec: LaunchRec) {
  selected = rec;
  selectedMeta = metaByToken.get(rec.token.toLowerCase()) ?? null;
  selectedState = null;
  renderBoard();
  renderSelectedHead();
  $('chartBox').innerHTML = '<p class="chart-empty">Sampling the curve with live SDK quotes…</p>';
  const seq = ++selectionSeq;
  const meta = await tokenMeta(rec.token);
  if (seq !== selectionSeq) return;
  selectedMeta = meta;
  if (meta.resolved) metaByToken.set(rec.token.toLowerCase(), meta);
  const [state, sample] = await Promise.all([
    curveState(rec.curve),
    sampleCurve(rec.curve, meta.decimals, 18),
  ]);
  if (seq !== selectionSeq) return;
  selectedState = state;
  renderSelectedHead();
  if (sample.points.length < 2) {
    // The curve does not answer quotes on either side (paused or fully
    // migrated). Mark it clearly, never surface raw RPC errors, and, when
    // this was the automatic pick, move on to the next live launch.
    unavailableCurves.add(rec.curve.toLowerCase());
    renderBoard();
    drawChart(sample.points, sample.side, meta.symbol);
    const msgEl = $('quoteMsg');
    msgEl.classList.add('error');
    msgEl.textContent = 'This launch is unavailable: its curve is not answering quotes (paused or fully migrated). Pick another launch from the board.';
    if (!userPicked) void autoSelect();
    return;
  }
  unavailableCurves.delete(rec.curve.toLowerCase());
  drawChart(sample.points, sample.side, meta.symbol);
  void runQuote();
}

/** Cheap liveness probe: one small quote per side, with retries inside quote(). */
async function probeCurve(rec: LaunchRec): Promise<boolean> {
  try {
    await quote(rec.curve, 10n ** 15n, false);
    return true;
  } catch {
    /* buy side silent: try sell side */
  }
  try {
    await quote(rec.curve, 10n ** 12n, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default selection: the newest launch whose curve actually answers quotes.
 * The newest launch overall is often already paused or migrated, so picking
 * launches[0] blindly landed the page on a dead curve.
 */
async function autoSelect() {
  if (autoSelecting || userPicked) return;
  if (selected && !unavailableCurves.has(selected.curve.toLowerCase())) return;
  autoSelecting = true;
  try {
    const candidates = launches.slice(0, 15);
    for (const rec of candidates) {
      if (unavailableCurves.has(rec.curve.toLowerCase())) continue;
      if (await probeCurve(rec)) {
        await selectLaunch(rec);
        return;
      }
      unavailableCurves.add(rec.curve.toLowerCase());
      renderBoard();
    }
    // Nothing in the newest 15 answers: fall back to the newest launch so
    // the page still shows its (unavailable) state instead of staying blank.
    if (candidates.length && !selected) await selectLaunch(candidates[0]);
  } finally {
    autoSelecting = false;
  }
}

// ---------- quote panel ----------
function setDirection(d: 'buy' | 'sell') {
  direction = d;
  $('dirBuy').classList.toggle('active', d === 'buy');
  $('dirSell').classList.toggle('active', d === 'sell');
  $('amountLabel').textContent = d === 'buy' ? 'You pay (WETH)' : `You pay (${selectedMeta?.symbol ?? 'token'})`;
  $('quoteOutLabel').textContent = d === 'buy' ? `You receive (${selectedMeta?.symbol ?? 'token'})` : 'You receive (WETH)';
  void runQuote();
}
$('dirBuy').addEventListener('click', () => setDirection('buy'));
$('dirSell').addEventListener('click', () => setDirection('sell'));

let quoteTimer: number | undefined;
$('quoteAmount').addEventListener('input', () => {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(() => void runQuote(), 450);
});

async function runQuote() {
  const outEl = $('quoteOut');
  const feeEl = $('quoteFee');
  const priceEl = $('quotePrice');
  const msgEl = $('quoteMsg');
  msgEl.classList.remove('error');
  if (!selected || !selectedMeta) {
    outEl.textContent = '—';
    return;
  }
  const rawInput = ($('quoteAmount') as HTMLInputElement).value.trim();
  let amountIn: bigint;
  try {
    amountIn = parseUnits(rawInput as `${number}`, direction === 'buy' ? 18 : selectedMeta.decimals);
    if (amountIn <= 0n) throw new Error('zero');
  } catch {
    msgEl.textContent = 'Enter an amount to get a live quote.';
    outEl.textContent = '—';
    feeEl.textContent = '—';
    priceEl.textContent = '—';
    return;
  }
  msgEl.textContent = 'Quoting on-chain…';
  try {
    const q = await quote(selected.curve, amountIn, direction === 'sell');
    const inHuman = Number(formatUnits(amountIn, direction === 'buy' ? 18 : selectedMeta.decimals));
    if (direction === 'buy') {
      outEl.textContent = `${fmtAmount(q.amountOut, selectedMeta.decimals)} ${selectedMeta.symbol}`;
      feeEl.textContent = `${fmtAmount(q.fee, 18)} WETH`;
      const outHuman = Number(formatUnits(q.amountOut, selectedMeta.decimals));
      priceEl.textContent = outHuman > 0 ? `${fmtPrice(inHuman / outHuman)} WETH` : '—';
    } else {
      outEl.textContent = `${fmtAmount(q.amountOut, 18)} WETH`;
      feeEl.textContent = `${fmtAmount(q.fee, selectedMeta.decimals)} ${selectedMeta.symbol}`;
      const outHuman = Number(formatUnits(q.amountOut, 18));
      priceEl.textContent = inHuman > 0 ? `${fmtPrice(outHuman / inHuman)} WETH` : '—';
    }
    msgEl.textContent = 'Quote is live from ALCClient.quoteExactInput at the current block.';
  } catch {
    outEl.textContent = '—';
    feeEl.textContent = '—';
    priceEl.textContent = '—';
    msgEl.classList.add('error');
    msgEl.textContent =
      'No live quote is available for this launch right now. Its curve may be paused or fully migrated; try the other direction or pick another launch from the board.';
  }
}

// ---------- configs ----------
function renderConfigs() {
  $('statConfigs').textContent = String(configs.filter((c) => c.enabled).length);
  const sel = $('wConfig') as HTMLSelectElement;
  sel.innerHTML = configs
    .filter((c) => c.enabled)
    .map((c) => {
      const lo = c.segments.length ? priceFromSqrt(c.segments[0].lower, 18, 18) : 0;
      const hi = c.segments.length ? priceFromSqrt(c.segments[c.segments.length - 1].upper, 18, 18) : 0;
      return `<option value="${c.id}">Config #${c.id} · ${c.segments.length} segment(s) · price ${fmtPrice(lo)} → ${fmtPrice(hi)}</option>`;
    })
    .join('');
  $('configList').innerHTML = configs
    .map((c) => {
      const lo = c.segments.length ? priceFromSqrt(c.segments[0].lower, 18, 18) : 0;
      const hi = c.segments.length ? priceFromSqrt(c.segments[c.segments.length - 1].upper, 18, 18) : 0;
      return `<div class="config-row">
        <span class="cid">Config #${c.id}</span>
        <span class="${c.enabled ? 'on' : 'off'}">${c.enabled ? 'Enabled' : 'Disabled'}</span>
        <span class="dim">${c.segments.length} segment(s) · price span ${fmtPrice(lo)} → ${fmtPrice(hi)} (raw)</span>
        <span class="dim mono hash">${c.hash ? esc(c.hash.slice(0, 18)) + '…' : ''}</span>
      </div>`;
    })
    .join('');
}

// ---------- wizard ----------
$('wPreview').addEventListener('click', async () => {
  const name = ($('wName') as HTMLInputElement).value.trim();
  const symbol = ($('wSymbol') as HTMLInputElement).value.trim();
  const uri = ($('wUri') as HTMLInputElement).value.trim();
  const configId = BigInt(($('wConfig') as HTMLSelectElement).value || '1');
  const creator = wallet?.address ?? DEMO_CREATOR;
  const out = $('planOut');
  if (!name || !symbol) {
    out.textContent = 'Give the token a name and a symbol first.';
    return;
  }
  out.textContent = 'Predicting addresses and simulating against live state…';
  lastPlan = { name, symbol, uri, configId };
  try {
    const [pred, sim] = await Promise.all([
      predictLaunch(creator, configId, uri),
      simulateLaunch(creator, name, symbol, uri, configId),
    ]);
    const calldata = createLaunchCalldata(name, symbol, uri, configId);
    out.innerHTML =
      `Token (predicted): <a href="${EXPLORER}/address/${pred.token}" target="_blank" rel="noreferrer">${pred.token}</a>\n` +
      `Curve (predicted): <a href="${EXPLORER}/address/${pred.curve}" target="_blank" rel="noreferrer">${pred.curve}</a>\n` +
      `Creator: ${creator}${wallet ? '' : ' (demo preview address)'}\n` +
      `Calldata: ${calldata.slice(0, 42)}… (${(calldata.length - 2) / 2} bytes)\n` +
      (sim.ok
        ? `<span class="ok">Simulation: passed. ${esc(sim.message)}</span>`
        : `<span class="bad">Simulation: reverted. ${esc(sim.message)}</span>`);
    ($('wLaunch') as HTMLButtonElement).disabled = !(wallet && sim.ok);
  } catch (e) {
    out.textContent = `Preview failed: ${e instanceof Error ? e.message.slice(0, 240) : 'unknown error'}`;
    ($('wLaunch') as HTMLButtonElement).disabled = true;
  }
});

$('wLaunch').addEventListener('click', async () => {
  if (!wallet || !lastPlan) return;
  const btn = $('wLaunch') as HTMLButtonElement;
  const out = $('planOut');
  btn.disabled = true;
  btn.textContent = 'Waiting for wallet…';
  try {
    const hash = await executeLaunch(wallet, lastPlan.name, lastPlan.symbol, lastPlan.uri, lastPlan.configId);
    out.innerHTML =
      `<span class="ok">Launch submitted and confirmed.</span>\n` +
      `Transaction: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">${hash}</a>\n` +
      `The board rescans the factory; your launch appears once its block is indexed by the scan.`;
    btn.textContent = 'Launched';
    void scanLaunches(onScanUpdate);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Launch on testnet';
    out.innerHTML = `<span class="bad">Launch failed: ${esc(e instanceof Error ? e.message.slice(0, 240) : 'unknown error')}</span>`;
  }
});

// ---------- boot ----------
let boardRenderQueued = false;
function onScanUpdate(u: { launches: LaunchRec[]; scanning: boolean }) {
  launches = u.launches;
  $('statLaunches').textContent = String(launches.length);
  $('scanLine').textContent = u.scanning
    ? `Scanning factory logs in 10k-block chunks, newest first… ${launches.length} launches found so far.`
    : `Factory scan complete: ${launches.length} launches indexed from block 36,220,000.`;
  if (!boardRenderQueued) {
    boardRenderQueued = true;
    window.setTimeout(() => {
      boardRenderQueued = false;
      renderBoard();
    }, 600);
  }
  for (const rec of launches.slice(0, 60)) void ensureMeta(rec);
  if (launches.length && (!selected || unavailableCurves.has(selected.curve.toLowerCase()))) void autoSelect();
}

function boot() {
  $('statFactory').textContent = short(FACTORY);
  const c = deployment.contracts as unknown as Record<string, string>;
  $('footContracts').textContent =
    `Factory ${FACTORY} · Registry ${REGISTRY} · Fee policy ${c.feePolicy ?? ''} · ` +
    `Token implementation ${c.tokenImplementation ?? ''} · Curve implementation ${c.curveImplementation ?? ''}`;
  void tickBlock();
  window.setInterval(() => void tickBlock(), 6000);
  void listConfigs()
    .then((cs) => {
      configs = cs;
      renderConfigs();
    })
    .catch(() => {
      $('configList').innerHTML = '<p class="board-empty">The config registry did not answer. Reload to retry.</p>';
    });
  void scanLaunches(onScanUpdate);
}

boot();
