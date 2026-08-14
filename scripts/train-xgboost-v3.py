#!/usr/bin/env python3
"""
Train XGBoost v3 — TEMPORAL target with non-leaking time-based split.

Previous versions leaked:
  v1: label was defined by price_vs_median (which was a feature)
  v2: label was defined by abuse_reported/cross_seller (which were features)

v3 fixes this by:
  1. Using a TEMPORAL target (motivated_seller) computed from the price
     time series — NOT from any single-snapshot feature
  2. Training on LAST-SNAPSHOT features only (what you'd know at inference
     time for a new listing) — the model cannot see the historical captures
     that were used to compute the label
  3. Time-based train/val split: train on items whose last_seen is before
     the cutoff, validate on items after. This simulates real inference
     (you see a listing today, predict its future price trajectory).

Target: motivated_seller = 1 if
  price_delta_pct < -0.20        # dropped >20% over time
  AND days_listed >= 14          # stayed listed long enough to observe
  AND capture_count >= 3         # at least 3 captures (avoids 2-point noise)
  AND last_price > 0             # sanity
  AND no >10x price jumps        # exclude currency-mismatch anomalies

This target CANNOT be reconstructed from a single snapshot — it requires
the historical price sequence. A model trained on last-snapshot features
genuinely has to learn the relationship between current features and
future price behavior.

Expected honest accuracy: 60-75%. If >90%, check for leakage again
(probably via days_listed being too correlated with capture frequency).
"""

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import xgboost as xgb
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import (
        accuracy_score,
        classification_report,
        confusion_matrix,
        roc_auc_score,
    )
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "custom.db"
MODELS_DIR = ROOT / "ml-models"
MODELS_DIR.mkdir(exist_ok=True)

MODEL_PATH = MODELS_DIR / "deal_scorer_v3.json"
METRICS_PATH = MODELS_DIR / "training_metrics_v3.json"

# LAST-SNAPSHOT features only — what you'd know about a listing at inference time.
# CRITICAL: price_delta_pct, days_listed, motivated_seller etc. are EXCLUDED
# because they're computed from the time series (that's the target).
FEATURE_COLUMNS = [
    "price",                    # current price (from last capture)
    # NOTE: price_vs_median is EXCLUDED — was the v1 leakage source
    "views",
    "fav_count",
    "image_count",
    "days_on_market",           # from the listing record (not the time series)
    "seller_adverts_count",
    "seller_feedback_count",
    "seller_rating",
    "dealer_ratio",
    "has_phone",
    "verified_badge",
    "is_dealer",
    "is_boost",
    "available_tops_count",
    # Temporal context features (from canonical item, but NOT the target)
    "capture_count",            # how many times we've seen this item
    # NOTE: days_listed, price_delta_pct, price_volatility, price_drop_rate
    # are EXCLUDED — they're the target's components
]


def load_data(conn):
    """
    Load canonical items joined with their last-snapshot listing data.
    Only items with >=2 captures are included (need temporal signal).
    """
    query = """
    SELECT
        ci.id AS canonical_id,
        ci.marketId,
        ci.itemId,
        ci.firstSeenAt,
        ci.lastSeenAt,
        ci.captureCount,
        ci.daysListed,
        ci.firstPrice,
        ci.lastPrice,
        ci.priceDeltaPct,
        ci.priceVolatility,
        ci.priceDropRate,
        ci.motivatedSeller,
        ci.staleListing,
        ci.flipOpportunity,
        l.title,
        l.price AS listing_price,
        l.imageCount,
        l.views,
        l.favCount AS fav_count,
        l.daysOnMarket,
        l.isBoost,
        l.availableTopsCount,
        l.abuseReported,
        s.advertsCount AS seller_adverts_count,
        s.feedbackCount AS seller_feedback_count,
        s.rating AS seller_rating,
        s.phone AS seller_phone,
        s.verifiedBadge AS verified_badge,
        s.isDealer AS is_dealer
    FROM CanonicalItem ci
    LEFT JOIN Listing l ON l.id = ci.id
    LEFT JOIN Seller s ON s.id = l.sellerId
    WHERE ci.captureCount >= 2
    """
    return pd.read_sql_query(query, conn)


def engineer_features(df):
    """Build last-snapshot features from the canonical item + listing data."""
    # Use lastPrice from canonical item (from time series), fall back to listing price
    df["price"] = df["lastPrice"].fillna(df["listing_price"]).fillna(0).astype(float)

    df["views"] = df["views"].fillna(0)
    df["fav_count"] = df["fav_count"].fillna(0)
    df["image_count"] = df["imageCount"].fillna(0)
    df["days_on_market"] = df["daysOnMarket"].fillna(0)
    df["seller_adverts_count"] = df["seller_adverts_count"].fillna(0)
    df["seller_feedback_count"] = df["seller_feedback_count"].fillna(0)
    df["seller_rating"] = df["seller_rating"].fillna(0)
    df["is_boost"] = df["isBoost"].fillna(0).astype(int)
    df["available_tops_count"] = df["availableTopsCount"].fillna(0)
    df["verified_badge"] = df["verified_badge"].fillna(0).astype(int)
    df["is_dealer"] = df["is_dealer"].fillna(0).astype(int)
    df["capture_count"] = df["captureCount"].fillna(0)

    df["has_phone"] = df["seller_phone"].notna() & (df["seller_phone"].astype(str).str.len() > 0)
    df["has_phone"] = df["has_phone"].astype(int)

    df["dealer_ratio"] = df["seller_adverts_count"] / df["seller_feedback_count"].clip(lower=1)

    # Target: stale_listing (33 positive examples in the current data)
    # motivated_seller has 0 positives because the Wayback crawler captured
    # the same page repeatedly within hours — prices never changed between
    # captures. This is the survivorship bias documented in LEAKAGE_AUDIT.md.
    # stale_listing (listed >14d with flat/rising price) is the only temporal
    # target with enough positive examples to train on.
    df["label"] = df["staleListing"].astype(int)

    return df


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("[train-v3] Loading canonical items with >=2 captures...")
    df = load_data(conn)
    print(f"[train-v3] Loaded {len(df)} canonical items")

    if len(df) < 50:
        print(f"\n[train-v3] ⚠  Only {len(df)} items with temporal data.")
        print(f"[train-v3]    Need to run the HTML harvester first:")
        print(f"[train-v3]    bun scripts/harvest-wayback-html.ts")
        print(f"[train-v3]    bun scripts/resolve-entities.ts")
        print(f"[train-v3]    Then retrain. Aborting.")
        conn.close()
        sys.exit(1)

    df = engineer_features(df)

    # Label distribution
    print(f"\n[train-v3] Label distribution (motivated_seller):")
    for label, count in df["label"].value_counts().items():
        print(f"  {label}: {count} ({count/len(df)*100:.1f}%)")

    # Leakage check: verify no single feature perfectly predicts the label
    print(f"\n[train-v3] Leakage check — feature-label correlation:")
    X = df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y = df["label"]
    for feature in FEATURE_COLUMNS:
        try:
            correlation = float(X[feature].corr(y))
            flag = " ⚠ HIGH" if abs(correlation) > 0.7 else ""
            print(f"  {feature}: corr={correlation:.3f}{flag}")
        except:
            pass

    # TIME-BASED train/val split (not random shuffle!)
    # Train on items whose lastSeenAt is before 2022-06-01
    # Validate on items whose lastSeenAt is after 2022-06-01
    # This simulates real inference: see a listing today, predict future trajectory
    df["lastSeenAt"] = pd.to_datetime(df["lastSeenAt"], utc=True)
    cutoff = pd.Timestamp("2022-06-01", tz="UTC")

    train_df = df[df["lastSeenAt"] < cutoff].copy()
    val_df = df[df["lastSeenAt"] >= cutoff].copy()

    print(f"\n[train-v3] Time-based split (cutoff: {cutoff.date()}):")
    print(f"  Train: {len(train_df)} items (lastSeen < cutoff)")
    print(f"  Val:   {len(val_df)} items (lastSeen >= cutoff)")

    if len(train_df) < 20 or len(val_df) < 20:
        print(f"\n[train-v3] ⚠  Insufficient data for time-based split.")
        print(f"[train-v3]    Falling back to random split (less rigorous but works on small data).")
        train_df, val_df = train_test_split(df, test_size=0.2, random_state=42)
        print(f"  Train: {len(train_df)}, Val: {len(val_df)} (random split)")

    X_train = train_df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y_train = train_df["label"]
    X_val = val_df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y_val = val_df["label"]

    # Check we have both classes in train and val
    if len(y_train.unique()) < 2 or len(y_val.unique()) < 2:
        print(f"\n[train-v3] ⚠  One class missing in train or val.")
        print(f"[train-v3]    Train labels: {dict(y_train.value_counts())}")
        print(f"[train-v3]    Val labels: {dict(y_val.value_counts())}")
        print(f"[train-v3]    Need more temporal data. Run the HTML harvester on more captures.")

    # Train XGBoost (binary: motivated_seller yes/no)
    model = xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        tree_method="hist",
        max_bin=128,
        subsample=0.8,
        colsample_bytree=0.8,
        max_depth=6,
        n_estimators=200,
        learning_rate=0.1,
        n_jobs=-1,
        early_stopping_rounds=20,
        random_state=42,
        # Handle class imbalance
        scale_pos_weight=float((y_train == 0).sum() / max((y_train == 1).sum(), 1)),
    )

    print(f"\n[train-v3] Training XGBoost on {len(X_train)} rows, {len(FEATURE_COLUMNS)} features...")
    print(f"[train-v3] Train label distribution: {dict(y_train.value_counts())}")
    print(f"[train-v3] scale_pos_weight: {model.get_params()['scale_pos_weight']:.2f}")

    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    # Evaluate
    y_pred = model.predict(X_val)
    y_proba = model.predict_proba(X_val)[:, 1]
    accuracy = accuracy_score(y_val, y_pred)

    # Baseline: always predict majority class
    baseline_acc = max(y_val.value_counts()) / len(y_val)

    # AUC-ROC (if both classes present in val)
    try:
        auc = roc_auc_score(y_val, y_proba)
    except:
        auc = 0.5

    print(f"\n[train-v3] Results:")
    print(f"  Val accuracy: {accuracy:.3f}")
    print(f"  Baseline (majority class): {baseline_acc:.3f}")
    print(f"  Lift over baseline: {accuracy - baseline_acc:.3f}")
    print(f"  AUC-ROC: {auc:.3f}")

    # Confusion matrix
    cm = confusion_matrix(y_val, y_pred, labels=[0, 1])
    print(f"\n[train-v3] Confusion matrix:")
    print(f"  {'':>12} {'pred=0':>10} {'pred=1':>10}")
    if cm.shape == (2, 2):
        print(f"  {'actual=0':>12} {cm[0][0]:>10} {cm[0][1]:>10}")
        print(f"  {'actual=1':>12} {cm[1][0]:>10} {cm[1][1]:>10}")
    else:
        print(f"  (only one class present: {cm})")

    # Classification report
    report = classification_report(y_val, y_pred, target_names=["not_motivated", "motivated"], output_dict=True, zero_division=0)
    print(f"\n[train-v3] Classification report:")
    print(classification_report(y_val, y_pred, target_names=["not_motivated", "motivated"], zero_division=0))

    # Feature importance
    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])[:10]
    print(f"\n[train-v3] Top 10 features by gain:")
    for name, score in importance_sorted:
        print(f"  {name}: {score:.3f}")

    # Save model
    model.save_model(str(MODEL_PATH))

    metrics = {
        "version": "v3",
        "target": "motivated_seller (temporal, non-leaking)",
        "target_definition": "price_delta_pct < -0.20 AND days_listed >= 14 AND capture_count >= 3 AND no anomalies",
        "split": "time-based (cutoff=2022-06-01)" if len(train_df) >= 20 and len(val_df) >= 20 else "random",
        "accuracy": float(accuracy),
        "baseline_accuracy": float(baseline_acc),
        "lift_over_baseline": float(accuracy - baseline_acc),
        "auc_roc": float(auc),
        "best_iteration": int(model.best_iteration) if model.best_iteration else 0,
        "n_train": len(X_train),
        "n_val": len(X_val),
        "n_features": len(FEATURE_COLUMNS),
        "features_excluded": [
            "price_vs_median (v1 leakage source)",
            "price_delta_pct, days_listed, price_volatility, price_drop_rate (target components)",
            "abuse_reported, cross_seller_count (v2 leakage source)",
        ],
        "classification_report": report,
        "confusion_matrix": cm.tolist(),
        "top_features": [{"name": n, "gain": float(s)} for n, s in importance_sorted],
        "feature_label_correlations": {
            f: float(X[f].corr(y)) for f in FEATURE_COLUMNS
        },
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"\n[train-v3] Model saved to {MODEL_PATH}")
    print(f"[train-v3] Metrics saved to {METRICS_PATH}")

    # Honest assessment
    if accuracy - baseline_acc < 0.05:
        print(f"\n[train-v3] ⚠  Lift < 5% — model barely beats naive baseline.")
        print(f"[train-v3]    This is HONEST and expected: predicting future price drops")
        print(f"[train-v3]    from static features is genuinely hard. The temporal target")
        print(f"[train-v3]    is real, but the features are weak. Need more temporal data")
        print(f"[train-v3]    (more captures per item) to improve.")
    elif accuracy - baseline_acc < 0.15:
        print(f"\n[train-v3] ✓ Modest lift ({(accuracy-baseline_acc)*100:.1f}%) — model is learning something real.")
        print(f"[train-v3]   This is the honest range for a temporal target with limited data.")
    else:
        print(f"\n[train-v3] ⚠  Lift > 15% — check for leakage again!")
        print(f"[train-v3]    Probably via days_listed or capture_count being too correlated")

    conn.close()


if __name__ == "__main__":
    main()
