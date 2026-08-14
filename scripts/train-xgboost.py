#!/usr/bin/env python3
"""
Train XGBoost deal-scorer on real archived Jiji listings.

Loads listings + sellers + deal_scores from SQLite, engineers features from
recon-derived signals, applies weak-supervision labels (no ground-truth scam
labels exist in the archive), trains an XGBoost multi-class classifier with
the speed/memory knobs from the optimization notes, and saves the model to
ml-models/deal_scorer.json. Records metadata in the ModelArtifact table.

Usage:
    python3 scripts/train-xgboost.py

Output:
    - ml-models/deal_scorer.json (XGBoost model)
    - ml-models/feature_names.json (feature column order)
    - ml-models/training_metrics.json (train/val accuracy, logloss)
    - row in ModelArtifact table
"""

import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import xgboost as xgb
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import accuracy_score, classification_report
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Install with: pip install xgboost scikit-learn pandas numpy")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "custom.db"
MODELS_DIR = ROOT / "ml-models"
MODELS_DIR.mkdir(exist_ok=True)

MODEL_PATH = MODELS_DIR / "deal_scorer.json"
FEATURE_NAMES_PATH = MODELS_DIR / "feature_names.json"
METRICS_PATH = MODELS_DIR / "training_metrics.json"

# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------
# These are the recon-derived features. The same fields must be produced by
# the TS scorer at inference time — see src/lib/deal-scorer.ts for the
# weighted-features fallback (used when the trained model is unavailable).

FEATURE_COLUMNS = [
    "price",
    "price_vs_median",        # placeholder; computed per-category below
    "views",
    "fav_count",
    "image_count",
    "days_on_market",
    "seller_account_age_days",
    "seller_total_listings",
    "seller_adverts_count",
    "seller_feedback_count",
    "seller_rating",
    "dealer_ratio",            # adverts_count / max(feedback_count, 1)
    "has_phone",
    "phone_leaked",
    "verified_badge",
    "is_dealer",
    "has_date_created",
    "has_date_edited",
    "has_date_moderated",
    "edit_churn_hours",        # date_edited - date_created (hours)
    "moderation_churn_hours",  # date_moderated - date_created (hours)
    "edit_churn_24h",
    "moderation_churn_1h",
    "is_boost",
    "available_tops_count",
    "sold_reported",
    "can_make_offer",
    "abuse_reported",
    "status_active",
    "image_duplicate_count",
    "cross_seller_count",
    "relist_count",
    "cross_market_count",
    "below_market_valuation",
    "above_market_valuation",
]

LABELS = ["GREAT", "FAIR", "RISKY", "SCAM"]
LABEL_TO_ID = {label: i for i, label in enumerate(LABELS)}


def load_dataframe(conn: sqlite3.Connection) -> pd.DataFrame:
    """
    Load listings + sellers + deal_scores into a single DataFrame.
    """
    query = """
    SELECT
        l.id AS listing_id,
        l.marketId,
        l.price,
        l.imageCount AS image_count,
        l.views,
        l.favCount AS fav_count,
        l.daysOnMarket AS days_on_market,
        l.dateCreated,
        l.dateEdited,
        l.dateModerated,
        l.soldReported AS sold_reported,
        l.canMakeOffer AS can_make_offer,
        l.abuseReported AS abuse_reported,
        l.isBoost AS is_boost,
        l.availableTopsCount AS available_tops_count,
        l.status,
        l.priceValuationLow AS price_valuation_low,
        l.priceValuationHigh AS price_valuation_high,
        l.categoryId AS category_id,
        s.accountAgeDays AS seller_account_age_days,
        s.totalListings AS seller_total_listings,
        s.advertsCount AS seller_adverts_count,
        s.feedbackCount AS seller_feedback_count,
        s.rating AS seller_rating,
        s.phone AS seller_phone,
        s.hidePhone AS seller_hide_phone,
        s.phoneLeaked AS seller_phone_leaked,
        s.verifiedBadge AS verified_badge,
        s.isDealer AS is_dealer,
        ds.score AS existing_score,
        ds.classification AS existing_classification,
        ds.imageDuplicateCount AS image_duplicate_count,
        ds.crossMarketBroker AS cross_market_broker,
        ds.relistCount AS relist_count,
        ih_stats.cross_seller_count,
        ih_stats.cross_market_count
    FROM Listing l
    JOIN Seller s ON l.sellerId = s.id
    LEFT JOIN DealScore ds ON ds.listingId = l.id
    LEFT JOIN (
        SELECT listingId, COUNT(DISTINCT sellerId) AS cross_seller_count, COUNT(DISTINCT marketId) AS cross_market_count
        FROM ImageHash
        GROUP BY listingId
    ) ih_stats ON ih_stats.listingId = l.id
    """
    df = pd.read_sql_query(query, conn)
    return df


def engineer_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """
    Build the feature matrix X and weak-supervision labels y from raw DB rows.
    """
    # Compute per-category median price (market median)
    def median_ratio(group):
        med = group.median()
        if med is None or med <= 0:
            return pd.Series([0.0] * len(group), index=group.index)
        return (med - group) / med
    df["price_vs_median"] = df.groupby("category_id")["price"].transform(median_ratio)

    # Parse dates
    for col in ["dateCreated", "dateEdited", "dateModerated"]:
        df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)

    # Churn signals
    df["has_date_created"] = df["dateCreated"].notna().astype(int)
    df["has_date_edited"] = df["dateEdited"].notna().astype(int)
    df["has_date_moderated"] = df["dateModerated"].notna().astype(int)

    df["edit_churn_hours"] = (df["dateEdited"] - df["dateCreated"]).dt.total_seconds() / 3600
    df["moderation_churn_hours"] = (df["dateModerated"] - df["dateCreated"]).dt.total_seconds() / 3600

    df["edit_churn_24h"] = (df["edit_churn_hours"].notna() & (df["edit_churn_hours"] < 24) & (df["edit_churn_hours"] >= 0)).astype(int)
    df["moderation_churn_1h"] = (df["moderation_churn_hours"].notna() & (df["moderation_churn_hours"] < 1) & (df["moderation_churn_hours"] >= 0)).astype(int)

    # Phone signals
    df["has_phone"] = df["seller_phone"].notna() & (df["seller_phone"].astype(str).str.len() > 0)
    df["has_phone"] = df["has_phone"].astype(int)
    df["phone_leaked"] = df["seller_phone_leaked"].astype(int)

    # Dealer ratio
    df["dealer_ratio"] = df["seller_adverts_count"] / df["seller_feedback_count"].clip(lower=1)

    # Status active
    df["status_active"] = (df["status"] == "active").astype(int)

    # Price valuation
    df["below_market_valuation"] = (
        df["price_valuation_low"].notna() &
        (df["price"] < df["price_valuation_low"].fillna(0) * 0.85)
    ).astype(int)
    df["above_market_valuation"] = (
        df["price_valuation_high"].notna() &
        (df["price"] > df["price_valuation_high"].fillna(0) * 1.15)
    ).astype(int)

    # Fill image-hash stats
    df["image_duplicate_count"] = df["image_duplicate_count"].fillna(0)
    df["cross_seller_count"] = df["cross_seller_count"].fillna(1)  # self = 1
    df["cross_market_count"] = df["cross_market_count"].fillna(1)
    df["relist_count"] = df["relist_count"].fillna(0)
    df["cross_market_broker"] = df["cross_market_broker"].fillna(0).astype(int)

    # If we have an existing classification from the weighted-features scorer,
    # use it as the weak label. Otherwise synthesize one from heuristics.
    def weak_label(row):
        if pd.notna(row["existing_classification"]):
            return row["existing_classification"]
        # Heuristic fallback — calibrated to produce all 4 classes on the seed data
        # SCAM: strong scam signals
        if row["abuse_reported"] == 1 or row.get("cross_market_broker", 0) == 1:
            return "SCAM"
        if row.get("cross_seller_count", 1) > 1:
            return "SCAM"
        # Price below market valuation = too good to be true = likely scam
        if row.get("below_market_valuation", 0) == 1:
            return "SCAM"
        # GREAT: below median + established seller
        if row["price_vs_median"] > 0.15 and row["seller_account_age_days"] >= 30:
            return "GREAT"
        if row["price_vs_median"] > 0.2 and row["seller_rating"] >= 50:
            return "GREAT"
        # RISKY: dealer or very low views or overpriced
        if row["dealer_ratio"] > 50 or row.get("is_dealer", 0) == 1:
            return "RISKY"
        if row["price_vs_median"] < -0.2:
            return "RISKY"
        if row["views"] < 5:
            return "RISKY"
        # Otherwise: FAIR
        return "FAIR"

    df["label"] = df.apply(weak_label, axis=1)

    # Remap labels to contiguous 0..N indices (XGBoost requirement).
    # If a class has zero samples, drop it from the training set.
    present_labels = sorted(df["label"].unique())
    LABEL_TO_ID_LOCAL = {label: i for i, label in enumerate(present_labels)}
    df["label_id"] = df["label"].map(LABEL_TO_ID_LOCAL)
    # Persist the actual label order in a global so the trainer can use it
    global LABELS, LABEL_TO_ID
    LABELS = present_labels
    LABEL_TO_ID = LABEL_TO_ID_LOCAL

    # Build X with the canonical feature columns
    X = df[FEATURE_COLUMNS].copy()
    # Replace NaN with 0 (XGBoost can handle NaN natively, but explicit is cleaner)
    X = X.fillna(0)
    # Cast to float32 for memory efficiency
    X = X.astype(np.float32)
    y = df["label_id"]

    return X, y


def train_model(X: pd.DataFrame, y: pd.Series) -> dict:
    """
    Train XGBoost with the speed/memory knobs from the optimization notes.
    """
    # Train/val split (80/20)
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    # If only 2 classes, use binary objective; else multi-class.
    n_classes = len(LABELS)
    if n_classes < 2:
        print("[train] Need at least 2 classes — aborting.")
        sys.exit(1)

    if n_classes == 2:
        objective = "binary:logistic"
        eval_metric = "logloss"
        num_class_param = None
    else:
        objective = "multi:softprob"
        eval_metric = "mlogloss"
        num_class_param = n_classes

    # XGBoost with the knobs from the optimization notes
    model = xgb.XGBClassifier(
        objective=objective,
        eval_metric=eval_metric,
        tree_method="hist",          # 10-50x faster, default in 2.0+
        max_bin=128,                  # Memory + speed
        subsample=0.8,                # Speed + regularization
        colsample_bytree=0.8,         # Speed + regularization
        max_depth=6,                  # Shallow = fast, less overfit
        n_estimators=200,             # Sufficient for ~800 rows
        learning_rate=0.1,
        n_jobs=-1,                    # Use all CPU cores
        early_stopping_rounds=20,     # Stop when done
        random_state=42,
    )
    if num_class_param is not None:
        model.set_params(num_class=num_class_param)

    print(f"[train] Training XGBoost ({objective}) on {len(X_train)} rows, {len(FEATURE_COLUMNS)} features, {n_classes} classes...")
    print(f"[train] Label distribution: {y_train.value_counts().to_dict()}")

    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=False,
    )

    # Evaluate
    y_pred = model.predict(X_val)
    # For binary, y_pred may be 0/1; for multi-class, integer class IDs
    y_pred = np.asarray(y_pred).ravel().astype(int)
    y_val_arr = np.asarray(y_val).ravel().astype(int)
    accuracy = accuracy_score(y_val_arr, y_pred)
    report = classification_report(y_val_arr, y_pred, target_names=LABELS, output_dict=True, zero_division=0)

    print(f"[train] Val accuracy: {accuracy:.3f}")
    print(f"[train] Best iteration: {model.best_iteration}")

    # Save model
    model.save_model(str(MODEL_PATH))
    with open(FEATURE_NAMES_PATH, "w") as f:
        json.dump(FEATURE_COLUMNS, f, indent=2)

    # Feature importance
    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])[:10]
    print("[train] Top 10 features by gain:")
    for name, score in importance_sorted:
        print(f"  {name}: {score:.3f}")

    metrics = {
        "accuracy": float(accuracy),
        "best_iteration": int(model.best_iteration) if model.best_iteration else 0,
        "n_train": len(X_train),
        "n_val": len(X_val),
        "n_features": len(FEATURE_COLUMNS),
        "label_distribution": {LABELS[i]: int((y == i).sum()) for i in range(len(LABELS))},
        "classification_report": report,
        "top_features": [{"name": n, "gain": float(s)} for n, s in importance_sorted],
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    return metrics


def record_artifact(conn: sqlite3.Connection, metrics: dict):
    """
    Insert/update the ModelArtifact row.
    """
    # Deactivate previous
    conn.execute("UPDATE ModelArtifact SET active = 0 WHERE name = 'deal-scorer'")
    # Insert new
    conn.execute(
        """
        INSERT INTO ModelArtifact (id, name, version, algorithm, filePath, trainingRows, features, metrics, trainedAt, active)
        VALUES (lower(hex(randomblob(12))), 'deal-scorer', 1, 'xgboost', ?, ?, ?, ?, datetime('now'), 1)
        """,
        (
            str(MODEL_PATH.relative_to(ROOT)),
            metrics["n_train"] + metrics["n_val"],
            json.dumps(FEATURE_COLUMNS),
            json.dumps(metrics),
        ),
    )
    conn.commit()


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("[train] Loading data from SQLite...")
    df = load_dataframe(conn)
    print(f"[train] Loaded {len(df)} listings")

    if len(df) < 50:
        print(f"[train] WARNING: Only {len(df)} rows — XGBoost will overfit. Need 500+ for a real model.")
        print("[train] Proceeding anyway (this is a smoke test on the 16-row seed).")

    print("[train] Engineering features...")
    X, y = engineer_features(df)
    print(f"[train] Feature matrix: {X.shape}")

    print("[train] Training XGBoost...")
    metrics = train_model(X, y)

    print("[train] Recording model artifact in DB...")
    record_artifact(conn, metrics)

    print(f"[train] Model saved to {MODEL_PATH}")
    print(f"[train] Features saved to {FEATURE_NAMES_PATH}")
    print(f"[train] Metrics saved to {METRICS_PATH}")

    conn.close()


if __name__ == "__main__":
    main()
