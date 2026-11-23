// Marisol Trend Rider — a deterministic cbBTC trend-following bot for
// agent-fun/bars-replay/v1 (make.fun btc-race-24h-20261123-0511).
//
// The bot speaks newline-delimited JSON on stdin/stdout: one hello, one batch
// per minute bar, one done. It answers every batch with exactly one reply
// echoing the batch's seq. Orders decided on batch t fill at bar t+1's open,
// so every decision here is made on the latest closed bar only.
//
// Strategy: long-only trend following on 1-minute closes.
//   - Two integer EMAs (fast/slow) plus a trailing momentum window describe
//     the trend; a volatility band (mean absolute bar move) describes chop.
//   - Entry needs all three: fast EMA above slow EMA, trailing momentum
//     above a threshold that is a multiple of recent volatility and of the
//     round-trip cost, and no position held. Size is the full equity:
//     entries are rare and heavily gated, so each one is taken at size.
//   - Exits: a trailing stop once a trade is well in profit (arms at
//     +2.00%, fires after a 1.10% give-back from the peak), a stop-loss,
//     and a trend break (fast EMA back under slow EMA). There is no fixed
//     take-profit: on a strong trend day the winner is ridden until the
//     trend itself gives out (v3 change; v2's +2.50% cap left the best
//     hours of the dev window unharvested).
//   - A cooldown after every exit keeps the bot out of sideways churn,
//     where the ~26 bps round-trip cost would bleed it dry.
// All arithmetic is integer (BigInt) on the wire's raw units: no clock, no
// randomness, no environment — two runs on the same bars answer identically.

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Tunables (dimensionless integers; bps = 1/100 of a percent)
// ---------------------------------------------------------------------------

const EMA_FAST = 12; // bars
const EMA_SLOW = 48; // bars
const MOM_BARS = 30; // trailing momentum window, bars
const MOM_FAST_BARS = 10; // impulse window: the move must be happening now
const MOM_FAST_MIN_BPS = 20; // ...and be at least this strong
const VOL_BARS = 60; // volatility lookback, bars
const ENTRY_MOM_BPS = 55; // momentum must exceed this and 4x mean bar move
const VOL_MULT = 4; // momentum threshold = VOL_MULT * mean |bar move|
const EMA_SEP_MIN_BPS = 12; // fast EMA must clear the slow one by this much
const RANGE_BARS = 60; // regime filter window
const RANGE_MIN_BPS = 100; // the last hour must span at least 1.00%
const SIZE_BPS = 10000; // spend 100% of equity per entry (v3: full size)
const TAKE_PROFIT_BPS = 100000; // fixed take-profit effectively off: winners ride the trend
const STOP_LOSS_BPS = 90; // -0.90% under average cost: sell
const TRAIL_ARM_BPS = 200; // trailing stop arms at +2.00%
const TRAIL_GIVE_BPS = 110; // ...and fires after a 1.10% give-back from peak
const COOLDOWN_BARS = 60; // bars to sit out after an exit
const SLIP_BPS = 200; // max_slippage_bps sent with every order
const MIN_HISTORY = 90; // bars before the first possible entry

const BPS = 10000n;

// ---------------------------------------------------------------------------
// Wire state
// ---------------------------------------------------------------------------

interface Bar {
  symbol: string;
  o: bigint;
  c: bigint;
  cDepth: bigint; // first hop depth at the close, quote raw units
}

let symbol = '';
let priceScale = 0;
let qtyScale = 0;
let quoteScale = 6;
let warmupBars = 0;
let minNotional = 0n;

let seqSeen = -1;
let cash = 0n;
let equity = 0n;
let heldQty = 0n;
let heldCost = 0n; // total quote units the held qty cost (fees included)

// Price history of closes (raw integer prices), oldest first.
const closes: bigint[] = [];
let emaFast: bigint | null = null;
let emaSlow: bigint | null = null;

let barsSinceExit = Number.POSITIVE_INFINITY; // cooldown counter
let peakGainBps = 0; // best unrealised gain of the open trade, bps
let orderSeq = 0;

function nextClientId(): string {
  orderSeq += 1;
  return `b${orderSeq}`;
}

// EMA step in integers: ema += (x - ema) * 2 / (n + 1), truncating toward zero
// exactly as BigInt division does — the same on every run.
function emaStep(ema: bigint | null, x: bigint, n: number): bigint {
  if (ema === null) return x;
  const num = 2n;
  const den = BigInt(n + 1);
  return ema + ((x - ema) * num) / den;
}

// Mean absolute one-bar move over the last `n` returns, in bps (integer).
function meanAbsMoveBps(n: number): number {
  const len = closes.length;
  if (len < 2) return 0;
  const from = Math.max(1, len - n);
  let sum = 0n;
  let count = 0n;
  for (let i = from; i < len; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (prev <= 0n) continue;
    const diff = cur >= prev ? cur - prev : prev - cur;
    sum += (diff * BPS) / prev;
    count += 1n;
  }
  if (count === 0n) return 0;
  return Number(sum / count);
}

// Trailing return over the last `n` bars, in bps (integer, signed).
function momentumBps(n: number): number {
  const len = closes.length;
  if (len <= n) return 0;
  const prev = closes[len - 1 - n]!;
  const cur = closes[len - 1]!;
  if (prev <= 0n) return 0;
  return Number(((cur - prev) * BPS) / prev);
}

// Range of the last `n` closes (highest minus lowest) in bps of the latest.
function rangeBps(n: number): number {
  const len = closes.length;
  if (len < 2) return 0;
  const from = Math.max(0, len - n);
  let hi = closes[from]!;
  let lo = closes[from]!;
  for (let i = from; i < len; i++) {
    const c = closes[i]!;
    if (c > hi) hi = c;
    if (c < lo) lo = c;
  }
  const cur = closes[len - 1]!;
  if (cur <= 0n) return 0;
  return Number(((hi - lo) * BPS) / cur);
}

// Value of a quantity at a price, in quote raw units (truncated).
function valueAt(qty: bigint, price: bigint): bigint {
  // qty is at qty_scale, price at price_scale, quote at quote_scale.
  const num = qty * price * 10n ** BigInt(quoteScale);
  const den = 10n ** BigInt(qtyScale + priceScale);
  return num / den;
}

interface OrderOut {
  side: 'buy' | 'sell';
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
}

function decide(bar: Bar | null): OrderOut[] {
  if (bar === null) return [];
  if (seqSeen < warmupBars) return []; // orders on warm-up batches are rejected
  if (closes.length < MIN_HISTORY) return [];

  const close = bar.c;
  barsSinceExit += 1;

  // ----- holding: manage the exit -------------------------------------------
  if (heldQty > 0n) {
    // Average entry price implied by the account's cost basis.
    const avgPrice = heldCost > 0n ? (heldCost * 10n ** BigInt(qtyScale + priceScale)) / (heldQty * 10n ** BigInt(quoteScale)) : 0n;
    if (avgPrice > 0n) {
      const gainBps = Number(((close - avgPrice) * BPS) / avgPrice);
      if (gainBps > peakGainBps) peakGainBps = gainBps;
      const trendBroken = emaFast !== null && emaSlow !== null && emaFast < emaSlow;
      const takeProfit = gainBps >= TAKE_PROFIT_BPS;
      const stopLoss = gainBps <= -STOP_LOSS_BPS;
      const trailed = peakGainBps >= TRAIL_ARM_BPS && peakGainBps - gainBps >= TRAIL_GIVE_BPS;
      if (takeProfit || stopLoss || trailed || trendBroken) {
        return [
          {
            side: 'sell',
            client_id: nextClientId(),
            symbol,
            qty: heldQty.toString(),
            max_slippage_bps: SLIP_BPS,
          },
        ];
      }
    }
    return [];
  }

  // ----- flat: look for an entry --------------------------------------------
  peakGainBps = 0;
  if (barsSinceExit < COOLDOWN_BARS) return [];
  if (emaFast === null || emaSlow === null) return [];
  if (emaFast <= emaSlow) return [];

  const mom = momentumBps(MOM_BARS);
  const vol = meanAbsMoveBps(VOL_BARS);
  const threshold = Math.max(ENTRY_MOM_BPS, VOL_MULT * vol);
  if (mom < threshold) return [];
  // The move must be an impulse, not a slow grind: recent bars carry it too.
  if (momentumBps(MOM_FAST_BARS) < MOM_FAST_MIN_BPS) return [];
  // The trend must be established, not a fresh cross inside noise.
  if (Number(((emaFast - emaSlow) * BPS) / emaSlow) < EMA_SEP_MIN_BPS) return [];
  // Regime filter: the last hour must actually span some ground.
  if (rangeBps(RANGE_BARS) < RANGE_MIN_BPS) return [];

  const budget = (equity * BigInt(SIZE_BPS)) / BPS;
  const spend = budget < cash ? budget : cash;
  if (spend < minNotional || spend <= 0n) return [];
  return [
    {
      side: 'buy',
      client_id: nextClientId(),
      symbol,
      notional_quote_units: spend.toString(),
      max_slippage_bps: SLIP_BPS,
    },
  ];
}

// ---------------------------------------------------------------------------
// The line loop
// ---------------------------------------------------------------------------

function onHello(msg: any): void {
  const s = msg.symbols[0];
  symbol = s.symbol;
  priceScale = s.price_scale;
  qtyScale = s.qty_scale;
  quoteScale = msg.capital.quote_scale;
  warmupBars = msg.warmup_bars ?? 0;
  minNotional = BigInt(msg.fees.min_notional_quote_units);
  cash = BigInt(msg.capital.quote_units);
  equity = cash;
}

function onBatch(msg: any): OrderOut[] {
  seqSeen = msg.seq;
  cash = BigInt(msg.account.cash_quote_units);
  equity = BigInt(msg.account.equity_quote_units);
  heldQty = 0n;
  heldCost = 0n;
  for (const p of msg.account.positions) {
    if (p.symbol === symbol) {
      heldQty = BigInt(p.qty);
      heldCost = BigInt(p.cost_quote_units);
    }
  }
  // If the position just closed (we held some last batch and now hold none),
  // start the cooldown. Tracked by comparing against the previous batch.
  if (prevHeldQty > 0n && heldQty === 0n) barsSinceExit = 0;
  prevHeldQty = heldQty;

  let bar: Bar | null = null;
  for (const b of msg.bars) {
    if (b.symbol !== symbol) continue;
    bar = {
      symbol: b.symbol,
      o: BigInt(b.o),
      c: BigInt(b.c),
      cDepth: BigInt(b.c_depth[0] ?? '0'),
    };
    closes.push(bar.c);
    emaFast = emaStep(emaFast, bar.c, EMA_FAST);
    emaSlow = emaStep(emaSlow, bar.c, EMA_SLOW);
  }
  return decide(bar);
}

let prevHeldQty = 0n;

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      onHello(msg);
    } else if (msg.type === 'batch') {
      const orders = onBatch(msg);
      process.stdout.write(JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n');
    } else if (msg.type === 'done') {
      break;
    }
  }
}

await main();
