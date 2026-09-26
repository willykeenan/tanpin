# How Tanpin forecasts and times a store

Tanpin follows **tanpin kanri** (単品管理): manage every SKU as its own item, not as a category average. The loop is the same one a careful store manager runs by hand:

1. Form a hypothesis about demand over the next few days.
2. Order against that hypothesis (pack size, lead time, cut-off, delivery window).
3. After the days pass, compare the hypothesis to what actually sold.
4. Keep, revise, or stop stocking the item.

The code in `src/engine/` is that loop, written down. It is not a neural net, not Holt–Winters, and not a marketplace “AI forecast.” It is daily unit volume, a recency-weighted average, a day-of-week factor, a short trend, a damper on promo spikes, and optional manager-entered multipliers. This page is the math in plain words.

## Time: the store’s clock, not the server’s

Every calendar day and weekday is computed in **`settings.timezone`**, an IANA name such as `Asia/Tokyo` or `America/Los_Angeles`. If that setting is empty or invalid, Tanpin uses the **host timezone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`).

That timezone is used for:

- Which civil day a sale belongs to (a 01:00 UTC sale is still yesterday evening in Los Angeles).
- Which weekday factor applies (Friday in Tokyo is Thursday afternoon in Los Angeles).
- Supplier **delivery window hours** and **order cut-offs** (09:00 means 09:00 in the store, via the Intl API).

Do not mix host-local `Date#getDay()` / `Date#getHours()` into this. Those follow `TZ` on the process; the engine follows the store.

## Daily volume, including zeros

Sales are summed into **calendar-day unit totals** in the store timezone. Two transactions of 5 on the same day are 10 units that day. A day with no sale is **0**, and that 0 stays in the series.

Ignoring zero days is the usual silent bug: an item that sells only on weekends looks like a strong everyday seller if you average “days that had a ticket.” Including the quiet weekdays is what makes the baseline honest.

The trailing window is 28 calendar days by default (56 for weekday factors) and ends on **yesterday**, the last completed store-local day. Today's partial day is left out: at 00:30 it would read as an almost-zero day and drag the average (and inflate σ, and so safety stock) every morning.

The series also **starts at the SKU's history start** — its first sale, or its `createdAt` if that is earlier — not at a zero-filled window edge. Days before a product existed are not days of zero demand; counting them makes a 20-day-old item look like it is trending up and noisy. Zero days *after* the history start are real and stay in.

## The pieces of a SKU forecast

For each product, `forecastProduct` builds:

### 1. Recency-weighted daily average

An exponentially weighted mean of the (spike-damped) daily totals, half-life 7 days. Yesterday counts twice as much as the day eight days back. A flat 10 units/day stays 10; a recent lift pulls the baseline up.

This number is `avgDailyDemand`. It is units per **day**, not tickets per day.

### 2. Day-of-week factor on daily volume

For each weekday, mean daily units (zeros included) ÷ overall daily mean. Thin history is shrunk toward 1.0: four or more observations of that weekday get the full factor; one observation only keeps a quarter of the gap.

The forecast does not emit a different model per weekday. It multiplies the baseline by the average factor of the weekdays that fall inside the lead-time horizon, each taken in the store timezone.

### 3. Trend

Mean of the recent half of the window vs mean of the older half, clamped to 0.6–1.4. A SKU that has doubled lately is not allowed to more-than-1.4× the baseline on trend alone. New items with no older sales get a modest 1.2× if they have started to move.

### 4. Damped promo spikes

A day above **2× the median** daily volume is treated as a promotion or a one-off event, not as the new normal. The damper keeps the median plus 30% of the excess. A 10-a-day item that sold 100 on Saturday becomes 37 for the purpose of the average, trend, and weekday factor. The raw daily series is still returned as `series` so the UI can show what actually sold.

This is deliberately crude. It will also damp a genuine step-change until more high days fill the window. That is the trade: one flyer does not rewrite next week’s order.

### 5. Manager hypotheses

A hypothesis is a multiplier with an optional product or category scope and a start/end time. Several that overlap **compound**. This is the forward-looking half of tanpin kanri: weather, a festival, a stockout at the shop next door. The engine will not invent these; a person (or another system) has to write them down.

### Putting them together

For each of the next `horizonDays` (default: the SKU’s lead time):

```
day_d = max(0, baseline × weekday(d) × trend × hypothesis(d))
```

`dailyForecast` is the mean of those days; `horizonForecast` is their sum. Safety stock still uses the standard deviation of the damped daily series.

## Checking the hypothesis: rolling-origin backtest

`backtest(store, { horizon })` walks each SKU:

- Stand at the close of a past store-local day (the **origin**).
- Forecast the next `horizon` days from sales known at that origin.
- Compare `horizonForecast` to units that actually sold in those days.

It reports, per SKU and overall:

| Metric | Meaning |
| --- | --- |
| **MAPE** | Mean \|forecast − actual\| / \|actual\|. Days (horizons) with actual 0 are skipped, because the ratio is undefined. |
| **sMAPE** | Mean 2\|forecast − actual\| / (\|forecast\| + \|actual\|). Defined when actual is 0. Symmetric: over- and under-forecast of the same size score the same. |
| **bias** | Mean (forecast − actual). Positive means the engine is ordering as if demand were higher than it was. |

“Rolling origin” means we do this at every eligible day, not once on a hand-picked week. Only completed days are scored (the lookback ends yesterday), and an origin needs at least seven days of the SKU's own history behind it; the history before its first sale is not treated as zero demand. You need roughly a month of history plus the horizon before `n` is useful. A constant 10-a-day SKU should show MAPE and sMAPE near 0 and bias near 0; a noisy SKU will not, and that is the point of measuring it.

## Replenishment (the order that follows the forecast)

The forecast is an input to reorder math, not a purchase order:

- **Safety stock** = z(service level) × daily σ × √lead time. z comes from the inverse normal CDF, so 95% is about 1.645, not a magic table.
- **Reorder point** = forecast demand over the lead time + safety stock. The lead-time forecast carries the weekday factor, the trend and any active hypothesis, so a heatwave hypothesis raises the trigger (and orders) immediately — not only the order size.
- **EOQ** = √(2 × annual demand × order cost / holding cost per unit), then **capped** so a single order cannot exceed `maxDaysOfSupply` (JIT discipline).
- Quantity is rounded up to pack size and MOQ.

ABC classifies SKUs by annual revenue: A is the head of the Pareto curve and deserves the tightest loop; C is where delist decisions start.

## Delivery ETAs

A supplier has `leadTimeDays`, optional `cutoffHour`, and `deliveryWindows` (civil hours). If the order misses today’s cut-off in the store timezone, the lead-time clock starts the next store-local calendar day. Lead time is counted in those calendar days (wall-clock time kept, DST included) so a spring-forward night does not skip a window. The ETA is the first delivery window at or after that earliest instant, still in the store timezone.

`describeEta` is a relative label (“in 2 days”, “overdue by 3h”) from millisecond difference. It does not depend on timezone.

## What this will not do

- It will not see a holiday unless someone enters a hypothesis or the holiday already sits in the sales history.
- It will not split intra-day (lunch vs evening) even though many stores need that; the grain is a calendar day.
- It will not stay accurate with three days of data. The weekday factor shrinks toward 1 until each weekday has been seen a few times.
- Backtest numbers on a SKU that barely sells will be noisy; MAPE in particular punishes small actuals.

That is the method: one number per SKU, explained in pieces, checked against the days that followed.
