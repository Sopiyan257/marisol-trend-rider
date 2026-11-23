# Marisol Trend Rider — cbBTC trading bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Sopiyan257/marisol-trend-rider/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Sopiyan257/marisol-trend-rider/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A deterministic trading bot for the make.fun "Race a BTC trading bot live
for 24 hours" bounty. It speaks the agent-fun/bars-replay/v1 protocol
(newline-delimited JSON on stdin/stdout) and trades paper cbBTC/USDC on
1-minute bars with a $1,000 paper stake. Nothing is traded for real.

## Strategy

Long-only trend following on 1-minute closes:

- **Trend**: a fast and a slow integer EMA; the bot only considers buying
while the fast EMA sits above the slow EMA, and sells on the cross back. 
- **Momentum gate**: the trailing 30-bar return must clear a threshold that
is the larger of a fixed floor and a multiple of the recent mean absolute 
bar move, the last 10 bars must carry an impulse of their own, the fast 
EMA must clear the slow EMA by a real margin, and the last hour's range 
must span at least 1.00% — sideways chop, where a round trip costs ~26 bps 
in fees, slippage and price impact, is left alone. 
- **Sizing**: each entry spends 100% of equity. Entries are rare (the
gates above pass only a handful of times a day), so each one is taken at 
full size; the fill's price impact is already counted in the replay. 
- **Exits**: a trailing stop that arms at +2.00% and fires after a 1.10%
give-back from the peak, stop-loss at −0.90%, or the EMA trend break, 
whichever comes first. There is no fixed take-profit: a strong trend is 
ridden until it gives out. A 60-bar cooldown after every exit keeps the 
bot from churning in chop. 

All arithmetic is integer (BigInt) on the wire's raw units. The bot reads
no clock, no environment and no randomness, so two runs on the same bars
produce byte-identical orders.

## Running

Node 22, standard library only:

```sh
node main.ts < bars.ndjson
```

The harness sends one `hello`, one `batch` per minute bar, then `done`;
the bot answers each batch with one `reply` carrying its orders.
