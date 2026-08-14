# Leakage Audit — Honest Findings

## The Problem

The v1 XGBoost model achieved **99.7% validation accuracy** on 3,023 real
archived listings. This was not real learning — it was **target leakage**.

## The Smoking Gun

The v1 labeling function was:
```python
if row["price_vs_median"] > 0.20: return "GREAT"
if row["price_vs_median"] < -0.15: return "RISKY"
```

And `price_vs_median` was feature #2 in the feature matrix. The model's
top feature by gain was `price_vs_median` at 17.9 — it was literally
learning the labeling function.

## The Audit (3 experiments)

| Experiment | Features | Accuracy | Top Feature |
|-----------|----------|----------|-------------|
| Full feature set | 35 (incl. price_vs_median) | 99.7% | price_vs_median (17.9) |
| Exclude price_vs_median | 34 | 90.2% | moderation_churn_1h (10.5) |
| Exclude all price features | 33 | 85.5% | has_date_moderated (32.2) |

The 9.4% drop (not the predicted collapse to 65%) reveals a **second
leakage path**: archival-capture-type leakage. The remaining 90.2% comes
from features like `has_date_created`, `moderation_churn_1h`, and
`cross_market_count` — which are only present on "item" captures (774/3023
rows), not "listing" captures. The model learned "has full data → item
capture → different price dynamics → guess the label" rather than anything
about deal quality.

## The v2 Attempt (also leaking)

Tried a non-price-based target: "motivated seller" signal using
`days_on_market`, `can_make_offer`, `views < 20`, `is_dealer`.

Result: **100% accuracy** — worse than v1.

Root cause: the SUSPICIOUS class was defined by `abuse_reported`,
`cross_seller_count`, `views + fav_count`, and `moderation_churn_1h` —
all features in the matrix. The model perfectly reconstructed the label
from the features that defined it.

## The Hard Truth

**Any label defined from static snapshot features will leak.** The model
will always learn the labeling function, not real deal quality.

The only non-leaking target requires **temporal data**:
- The same listing captured at multiple points in time
- Price changes over time (not just static price vs median)
- Views velocity (views/day changing over time)
- Edit churn rate (how often the seller edits)

This requires **entity resolution** — collapsing multiple Wayback captures
of the same listing GUID into a single time-series record with:
- `first_seen`, `last_seen`
- `price_delta` (price change between captures)
- `days_listed` (total time on market across captures)
- `views_velocity` (views/day trend)
- `edit_count` (number of edits observed)

## What This Means

The v1 model (`ml-models/deal_scorer.json`) is **not reliable for
production use**. Its 99.7% accuracy is a mirror of the labeling heuristic,
not a measure of deal-detection ability.

The weighted-features scorer in `src/lib/deal-scorer.ts` remains the
primary scorer. It's honest about being a heuristic — it doesn't pretend
to be a trained model.

## Next Steps

1. **Build the HTML card extractor** for Wayback category pages
   - These have multiple capture timestamps per listing
   - Enables entity resolution across captures

2. **Implement entity resolution**
   - Collapse multiple captures of the same GUID into a time series
   - Compute `price_delta`, `days_listed`, `views_velocity`

3. **Define a temporal target**
   - "Price dropped >20% and stayed listed >14 days" = motivated seller
   - This CANNOT be reconstructed from a single snapshot
   - This is the actual deal signal

4. **Retrain on temporal features**
   - Only then will the model learn something real
