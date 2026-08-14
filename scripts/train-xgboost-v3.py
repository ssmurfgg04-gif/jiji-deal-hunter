#!/usr/bin/env python3
"""
End-to-end XGBoost v3 trainer — REAL DATA, motivated_seller target.

Trains on the CanonicalItem table joined with last-known Listing + Seller data.
Outputs a deal-scorer.ts-compatible JSON model (flat-indexed trees with
{feature, threshold, left, right, leaf, value} nodes).

Key design:
  - Target: motivated_seller (price dropped >20% AND listed >=14d AND >=3 captures)
  - Features: LAST-SNAPSHOT features only (what you'd know at inference time)
    — explicitly excludes price_delta_pct, days_listed, price_volatility,
    price_drop_rate (those are target components)
  - Split: TIME-BASED (train on early captures, val on later — simulates real
    inference where you see a listing today and predict future price trajectory)
  - Output: deal_scorer_v3.json with metrics_v3.json sidecar

Usage:
  python3 scripts/train-xgboost-v3.py
"""

import json
import sqlite3
import sys
import math
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd

try:
    import xgboost as xgb
    from sklearn.metrics import (
        accuracy_score, classification_report, confusion_matrix,
        roc_auc_score, f1_score, precision_recall_curve,
    )
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

ROOT = Path("/home/z/my-project/work/jiji-deal-hunter")
DB_PATH = ROOT / "db" / "custom.db"
MODELS_DIR = ROOT / "ml-models"
MODELS_DIR.mkdir(exist_ok=True)
MODEL_PATH = MODELS_DIR / "deal_scorer_v3.json"
METRICS_PATH = MODELS_DIR / "training_metrics_v3.json"

# Features known at inference time (last snapshot).
# CRITICAL: EXCLUDES price_delta_pct, days_listed, price_volatility, price_drop_rate
# — those are derived from the time series (which is the target).
FEATURE_COLUMNS = [
    "price",                    # last-known price
    "views",
    "fav_count",
    "image_count",
    "days_on_market",           # from listing record (NOT canonical days_listed)
    "seller_adverts_count",
    "seller_feedback_count",
    "seller_rating",
    "dealer_ratio",
    "has_phone",
    "verified_badge",
    "is_dealer",
    "is_boost",
    "available_tops_count",
    "capture_count",            # how many times we've seen this item
]


def load_data(conn):
    """Load canonical items with >=2 captures + their last-snapshot listing data."""
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

    # PRIMARY target: motivated_seller (now we have 113 positives — enough to train)
    # Fall back to staleListing if motivated_seller has <20 positives
    n_motivated = int(df["motivatedSeller"].sum()) if "motivatedSeller" in df.columns else 0
    n_stale = int(df["staleListing"].sum()) if "staleListing" in df.columns else 0
    if n_motivated >= 20:
        df["label"] = df["motivatedSeller"].astype(int)
        target_name = "motivated_seller"
        n_pos = n_motivated
    elif n_stale >= 20:
        df["label"] = df["staleListing"].astype(int)
        target_name = "stale_listing (fallback — not enough motivated sellers)"
        n_pos = n_stale
    else:
        print(f"FATAL: not enough positives (motivated={n_motivated}, stale={n_stale})")
        sys.exit(1)

    return df, target_name, n_pos


def dump_tree_as_nodes(dump_json):
    """
    Convert XGBoost's nested JSON dump (with children) into a flat-indexed
    array of TreeNode dicts compatible with deal-scorer.ts:
      {feature, threshold, left, right, leaf, value}

    Indexing: root is at position 0. Children reference parent via index.
    """
    nodes = []

    def walk(node):
        idx = len(nodes)
        nodes.append(None)  # placeholder, fill in after children are added
        if "leaf" in node:
            nodes[idx] = {
                "leaf": True,
                "value": float(node["leaf"]),
            }
        else:
            left_idx = walk(node["children"][0])
            right_idx = walk(node["children"][1])
            nodes[idx] = {
                "feature": str(node["split"]),
                "threshold": float(node["split_condition"]),
                "left": left_idx,
                "right": right_idx,
                "leaf": False,
            }
        return idx

    walk(dump_json)
    return nodes


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("[train-v3-e2e] Loading canonical items with >=2 captures...")
    df = load_data(conn)
    print(f"[train-v3-e2e] Loaded {len(df)} canonical items")

    if len(df) < 50:
        print(f"[train-v3-e2e] FATAL: Only {len(df)} items with temporal data.")
        sys.exit(1)

    df, target_name, n_pos = engineer_features(df)

    print(f"\n[train-v3-e2e] Target: {target_name}")
    print(f"[train-v3-e2e] Label distribution:")
    for label, count in df["label"].value_counts().items():
        print(f"  {label}: {count} ({count/len(df)*100:.1f}%)")

    # Leakage check
    print(f"\n[train-v3-e2e] Leakage check — feature-label correlation:")
    X = df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y = df["label"]
    for feature in FEATURE_COLUMNS:
        try:
            correlation = float(X[feature].corr(y))
            flag = " ⚠ HIGH" if abs(correlation) > 0.7 else ""
            print(f"  {feature}: corr={correlation:.3f}{flag}")
        except Exception:
            pass

    # TIME-BASED split — use median of lastSeenAt as cutoff
    df["lastSeenAt"] = pd.to_datetime(df["lastSeenAt"], utc=True, errors="coerce")
    cutoff = df["lastSeenAt"].quantile(0.7)  # 70% train, 30% val
    train_df = df[df["lastSeenAt"] < cutoff].copy()
    val_df = df[df["lastSeenAt"] >= cutoff].copy()

    print(f"\n[train-v3-e2e] Time-based split (cutoff: {cutoff.date()}):")
    print(f"  Train: {len(train_df)} items ({int(train_df['label'].sum())} positive)")
    print(f"  Val:   {len(val_df)} items ({int(val_df['label'].sum())} positive)")

    if len(train_df) < 20 or len(val_df) < 20 or train_df['label'].sum() < 5 or val_df['label'].sum() < 5:
        print(f"[train-v3-e2e] Insufficient data for time split — falling back to stratified random")
        from sklearn.model_selection import train_test_split
        train_df, val_df = train_test_split(df, test_size=0.3, random_state=42, stratify=df["label"])
        print(f"  Train: {len(train_df)} ({int(train_df['label'].sum())} pos), Val: {len(val_df)} ({int(val_df['label'].sum())} pos)")

    X_train = train_df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y_train = train_df["label"]
    X_val = val_df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y_val = val_df["label"]

    # Anti-overfit hyperparams (small data + class imbalance)
    pos_count = int(y_train.sum())
    neg_count = int((y_train == 0).sum())
    scale_pos_weight = max(neg_count / max(pos_count, 1), 1.0)

    model = xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="auc",
        tree_method="hist",
        max_bin=128,
        subsample=0.8,
        colsample_bytree=0.8,
        max_depth=3,              # was 6 — small data needs shallow trees
        min_child_weight=3,       # was 1 — avoid learning from individual outliers
        n_estimators=300,
        learning_rate=0.05,       # was 0.1 — slower, more conservative
        reg_alpha=0.1,            # L1 regularization
        reg_lambda=1.0,           # L2 regularization
        n_jobs=-1,
        early_stopping_rounds=30,
        random_state=42,
        scale_pos_weight=scale_pos_weight,
    )

    print(f"\n[train-v3-e2e] Training XGBoost on {len(X_train)} rows, {len(FEATURE_COLUMNS)} features...")
    print(f"[train-v3-e2e] scale_pos_weight: {scale_pos_weight:.2f}")

    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    y_proba = model.predict_proba(X_val)[:, 1]

    # Find optimal F1 threshold
    precision, recall, thresholds = precision_recall_curve(y_val, y_proba)
    f1s = 2 * precision * recall / (precision + recall + 1e-9)
    best_idx = int(np.argmax(f1s[:-1])) if len(thresholds) > 0 else 0
    best_threshold = float(thresholds[best_idx]) if len(thresholds) > 0 else 0.5
    best_f1 = float(f1s[best_idx])

    y_pred = (y_proba >= best_threshold).astype(int)
    accuracy = accuracy_score(y_val, y_pred)
    baseline_acc = max(y_val.value_counts()) / len(y_val)

    try:
        auc = float(roc_auc_score(y_val, y_proba))
    except Exception:
        auc = 0.5

    print(f"\n[train-v3-e2e] Results (threshold={best_threshold:.3f}):")
    print(f"  Val accuracy: {accuracy:.3f}")
    print(f"  Baseline (majority): {baseline_acc:.3f}")
    print(f"  Lift: {accuracy - baseline_acc:+.3f}")
    print(f"  AUC-ROC: {auc:.3f}")
    print(f"  F1: {best_f1:.3f}")

    cm = confusion_matrix(y_val, y_pred, labels=[0, 1])
    print(f"\n[train-v3-e2e] Confusion matrix:")
    print(f"  {'':>12} {'pred=0':>10} {'pred=1':>10}")
    if cm.shape == (2, 2):
        print(f"  {'actual=0':>12} {cm[0][0]:>10} {cm[0][1]:>10}")
        print(f"  {'actual=1':>12} {cm[1][0]:>10} {cm[1][1]:>10}")

    print(f"\n[train-v3-e2e] Classification report:")
    print(classification_report(y_val, y_pred, target_names=["not_motivated", "motivated"], zero_division=0))

    # Feature importance
    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])[:15]
    print(f"\n[train-v3-e2e] Top features by gain:")
    for name, score in importance_sorted:
        print(f"  {name}: {score:.3f}")

    # ----- Convert XGBoost model → deal-scorer.ts-compatible JSON -----
    booster = model.get_booster()
    tree_dumps = booster.get_dump(dump_format="json")
    trees_flat = []
    for td in tree_dumps:
        try:
            tree_obj = json.loads(td)
            flat = dump_tree_as_nodes(tree_obj)
            trees_flat.append(flat)
        except Exception as e:
            print(f"  [warn] Failed to dump tree: {e}")
            continue

    # base_score: XGBoost 2.x returns None for base_score on binary:logistic.
    # The standard default is 0.5 (after sigmoid of base_score=0).
    base_score = 0.0  # raw logit space — sum of trees added to this, then sigmoid

    artifact = {
        "version": 3,
        "features": FEATURE_COLUMNS,
        "trees": trees_flat,
        "baseScore": base_score,
        "metrics": {
            "auc": auc,
            "accuracy": float(accuracy),
            "baseline_accuracy": float(baseline_acc),
            "lift": float(accuracy - baseline_acc),
            "f1": best_f1,
            "optimal_threshold": best_threshold,
            "n_train": len(X_train),
            "n_val": len(X_val),
            "n_trees": len(trees_flat),
            "n_positive_train": pos_count,
            "n_positive_val": int(y_val.sum()),
            "best_iteration": int(model.best_iteration) if model.best_iteration else 0,
            "target": target_name,
        },
    }

    with open(MODEL_PATH, "w") as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train-v3-e2e] Model saved: {MODEL_PATH}")
    print(f"[train-v3-e2e]   {len(trees_flat)} trees, {len(FEATURE_COLUMNS)} features")

    metrics = {
        "version": "v3",
        "target": target_name,
        "split": f"time-based (cutoff={cutoff.date()})",
        "auc": auc,
        "accuracy": float(accuracy),
        "baseline_accuracy": float(baseline_acc),
        "lift": float(accuracy - baseline_acc),
        "f1": best_f1,
        "optimal_threshold": best_threshold,
        "n_train": len(X_train),
        "n_val": len(X_val),
        "n_positive_train": pos_count,
        "n_positive_val": int(y_val.sum()),
        "best_iteration": int(model.best_iteration) if model.best_iteration else 0,
        "n_trees": len(trees_flat),
        "scale_pos_weight": float(scale_pos_weight),
        "hyperparams": {
            "max_depth": 3,
            "learning_rate": 0.05,
            "n_estimators": 300,
            "min_child_weight": 3,
            "reg_alpha": 0.1,
            "reg_lambda": 1.0,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
        },
        "features_excluded": [
            "price_vs_median (v1 leakage source)",
            "price_delta_pct, days_listed, price_volatility, price_drop_rate (target components)",
            "abuse_reported, cross_seller_count (v2 leakage source)",
        ],
        "top_features": [{"name": n, "gain": float(s)} for n, s in importance_sorted],
        "feature_label_correlations": {
            f: float(X[f].corr(y)) for f in FEATURE_COLUMNS
        },
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"[train-v3-e2e] Metrics saved: {METRICS_PATH}")

    # Honest assessment
    lift = accuracy - baseline_acc
    if lift < 0.05:
        print(f"\n[train-v3-e2e] ⚠  Lift < 5% — model barely beats naive baseline.")
        print(f"[train-v3-e2e]    Real-world temporal prediction is hard. Need more captures per item.")
    elif lift < 0.15:
        print(f"\n[train-v3-e2e] ✓ Modest lift ({lift*100:.1f}%) — model is learning something real.")
    else:
        print(f"\n[train-v3-e2e] ✓ Strong lift ({lift*100:.1f}%) — check for leakage if >25%.")

    conn.close()


if __name__ == "__main__":
    main()
