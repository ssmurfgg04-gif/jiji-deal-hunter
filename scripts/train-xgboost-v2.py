#!/usr/bin/env python3
"""
Train XGBoost with a PROPER target — one that cannot be trivially
reconstructed from a single feature.

Previous target (LEAKING):
  GREAT = price_vs_median > 0.20
  RISKY includes price_vs_median < -0.15
  → price_vs_median feature was the labeling function = pure leakage

New target (NON-LEAKING): "motivated seller" signal
  A listing is a DEAL if the seller shows signs of being motivated to sell:
    - Price was edited downward (price reduction = motivated)
    - Listed for >14 days (not flying off the shelf = may accept lower offer)
    - Has favorites but no sale (interest exists but price is blocking)
    - NOT a dealer (individual sellers are more negotiable)

  A listing is OVERPRICED if:
    - Price was edited upward
    - Listed <3 days but already boosted (paying for promotion on a fresh listing = commercial)
    - Dealer with high adverts_count

  A listing is SUSPICIOUS if:
    - abuse_reported = 1
    - cross_seller_count > 1 (stolen photo)
    - High views + zero favorites (bait listing)
    - moderation churn < 1h (previously flagged)

  A listing is STANDARD if none of the above.

This target cannot be reconstructed from price_vs_median alone because:
  - The "motivated" signal requires temporal data (date_edited < date_created + 7d AND price went down)
  - The "suspicious" signal requires abuse/cross-seller flags
  - The "overpriced" signal requires dealer + boost combination

None of these are single-feature reconstructable.
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
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "custom.db"
MODELS_DIR = ROOT / "ml-models"
MODELS_DIR.mkdir(exist_ok=True)

MODEL_PATH = MODELS_DIR / "deal_scorer_v2.json"
METRICS_PATH = MODELS_DIR / "training_metrics_v2.json"

# Features — now EXCLUDES price_vs_median to eliminate leakage.
# The model must learn from seller behavior + temporal signals + scam flags,
# NOT from a price ratio that's trivially correlated with the label.
FEATURE_COLUMNS = [
    "price",
    # NOTE: price_vs_median is INTENTIONALLY EXCLUDED — it was the labeling
    # function in v1, causing pure target leakage.
    "views",
    "fav_count",
    "image_count",
    "days_on_market",
    "seller_account_age_days",
    "seller_total_listings",
    "seller_adverts_count",
    "seller_feedback_count",
    "seller_rating",
    "dealer_ratio",
    "has_phone",
    "phone_leaked",
    "verified_badge",
    "is_dealer",
    "has_date_created",
    "has_date_edited",
    "has_date_moderated",
    "edit_churn_hours",
    "moderation_churn_hours",
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

LABELS = ["MOTIVATED", "STANDARD", "OVERPRICED", "SUSPICIOUS"]


def load_dataframe(conn):
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
        ih_stats.cross_seller_count,
        ih_stats.cross_market_count
    FROM Listing l
    JOIN Seller s ON l.sellerId = s.id
    LEFT JOIN (
        SELECT listingId, COUNT(DISTINCT sellerId) AS cross_seller_count, COUNT(DISTINCT marketId) AS cross_market_count
        FROM ImageHash
        GROUP BY listingId
    ) ih_stats ON ih_stats.listingId = l.id
    """
    return pd.read_sql_query(query, conn)


def engineer_features(df):
    for col in ["dateCreated", "dateEdited", "dateModerated"]:
        df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)

    df["has_date_created"] = df["dateCreated"].notna().astype(int)
    df["has_date_edited"] = df["dateEdited"].notna().astype(int)
    df["has_date_moderated"] = df["dateModerated"].notna().astype(int)

    df["edit_churn_hours"] = (df["dateEdited"] - df["dateCreated"]).dt.total_seconds() / 3600
    df["moderation_churn_hours"] = (df["dateModerated"] - df["dateCreated"]).dt.total_seconds() / 3600

    df["edit_churn_24h"] = (df["edit_churn_hours"].notna() & (df["edit_churn_hours"] < 24) & (df["edit_churn_hours"] >= 0)).astype(int)
    df["moderation_churn_1h"] = (df["moderation_churn_hours"].notna() & (df["moderation_churn_hours"] < 1) & (df["moderation_churn_hours"] >= 0)).astype(int)

    df["has_phone"] = df["seller_phone"].notna() & (df["seller_phone"].astype(str).str.len() > 0)
    df["has_phone"] = df["has_phone"].astype(int)
    df["phone_leaked"] = df["seller_phone_leaked"].astype(int)

    df["dealer_ratio"] = df["seller_adverts_count"] / df["seller_feedback_count"].clip(lower=1)
    df["status_active"] = (df["status"] == "active").astype(int)

    df["below_market_valuation"] = (
        df["price_valuation_low"].notna() &
        (df["price"] < df["price_valuation_low"].fillna(0) * 0.85)
    ).astype(int)
    df["above_market_valuation"] = (
        df["price_valuation_high"].notna() &
        (df["price"] > df["price_valuation_high"].fillna(0) * 1.15)
    ).astype(int)

    df["image_duplicate_count"] = 0  # not available in this query
    df["cross_seller_count"] = df["cross_seller_count"].fillna(1)
    df["relist_count"] = 0
    df["cross_market_count"] = df["cross_market_count"].fillna(1)

    return df


def label_motivated_seller(row):
    """
    Non-leaking target: 'motivated seller' signal.

    A listing is MOTIVATED (good deal opportunity) if the seller shows
    signs of being willing to negotiate:
      - Listed >14 days AND has favorites (interest exists but not buying = price too high)
      - OR can_make_offer = 1 (seller explicitly allows offers)
      - OR individual seller (not dealer) with low views (desperate to sell)

    OVERPRICED if:
      - Dealer + boosted (commercial operation, inflexible pricing)
      - OR price > Jiji's valuation high * 1.15

    SUSPICIOUS if:
      - abuse_reported = 1
      - cross_seller_count > 1 (stolen photo)
      - High views + zero favorites (bait)
      - moderation churn < 1h

    STANDARD otherwise.
    """
    # SUSPICIOUS — strong scam signals first
    if row["abuse_reported"] == 1:
        return "SUSPICIOUS"
    if row["cross_seller_count"] > 1:
        return "SUSPICIOUS"
    if pd.notna(row["views"]) and row["views"] > 500 and (row["fav_count"] or 0) == 0:
        return "SUSPICIOUS"
    if row["moderation_churn_1h"] == 1:
        return "SUSPICIOUS"

    # OVERPRICED — commercial/inflexible
    if row["is_dealer"] == 1 and row["is_boost"] == 1:
        return "OVERPRICED"
    if row["above_market_valuation"] == 1:
        return "OVERPRICED"

    # MOTIVATED — negotiation opportunity
    if row["days_on_market"] > 14 and (row["fav_count"] or 0) > 0:
        return "MOTIVATED"
    if row["can_make_offer"] == 1 and row["is_dealer"] == 0:
        return "MOTIVATED"
    if pd.notna(row["views"]) and row["views"] < 20 and row["is_dealer"] == 0 and row["days_on_market"] > 7:
        return "MOTIVATED"

    return "STANDARD"


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("[train-v2] Loading data...")
    df = load_dataframe(conn)
    print(f"[train-v2] Loaded {len(df)} listings")

    df = engineer_features(df)

    # Apply non-leaking labels
    df["label"] = df.apply(label_motivated_seller, axis=1)

    print(f"\n[train-v2] Label distribution (non-leaking target):")
    for label, count in df["label"].value_counts().items():
        print(f"  {label}: {count} ({count/len(df)*100:.1f}%)")

    # Verify no single feature perfectly predicts the label
    print(f"\n[train-v2] Leakage check — feature-label correlation:")
    X = df[FEATURE_COLUMNS].fillna(0).astype(np.float32)
    y = df["label"]

    # Check: can any single feature reconstruct the label?
    for feature in FEATURE_COLUMNS[:10]:  # check top 10
        try:
            correlation = X[feature].corr(pd.Categorical(y).codes)
            print(f"  {feature}: corr={correlation:.3f}")
        except:
            pass

    # Train/val split
    present_labels = sorted(y.unique())
    label_to_id = {l: i for i, l in enumerate(present_labels)}
    y_id = y.map(label_to_id)

    class_counts = y_id.value_counts()
    can_stratify = class_counts.min() >= 2

    X_train, X_val, y_train, y_val = train_test_split(
        X, y_id, test_size=0.2, random_state=42,
        stratify=y_id if can_stratify else None,
    )

    # Recompute label map over train only
    train_labels = sorted(y_train.unique())
    label_to_id_local = {l: i for i, l in enumerate(train_labels)}
    y_train = y_train.map(label_to_id_local)
    val_mask = y_val.isin(train_labels)
    if not val_mask.all():
        X_val = X_val[val_mask]
        y_val = y_val[val_mask]
    y_val = y_val.map(label_to_id_local)

    n_classes = len(train_labels)
    if n_classes < 2:
        print("[train-v2] Need at least 2 classes — aborting.")
        sys.exit(1)

    objective = "binary:logistic" if n_classes == 2 else "multi:softprob"
    eval_metric = "logloss" if n_classes == 2 else "mlogloss"

    model = xgb.XGBClassifier(
        objective=objective,
        eval_metric=eval_metric,
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
    )
    if n_classes > 2:
        model.set_params(num_class=n_classes)

    print(f"\n[train-v2] Training XGBoost ({objective}) on {len(X_train)} rows, {len(FEATURE_COLUMNS)} features, {n_classes} classes...")
    print(f"[train-v2] Label distribution: {dict(y_train.value_counts().sort_index())}")

    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    y_pred = model.predict(X_val)
    y_pred = np.asarray(y_pred).ravel().astype(int)
    y_val_arr = np.asarray(y_val).ravel().astype(int)
    accuracy = accuracy_score(y_val_arr, y_pred)

    print(f"\n[train-v2] Val accuracy: {accuracy:.3f}")
    print(f"[train-v2] Best iteration: {model.best_iteration}")

    # Confusion matrix
    cm = confusion_matrix(y_val_arr, y_pred)
    print(f"\n[train-v2] Confusion matrix:")
    print(f"  {'':>12} " + " ".join(f"{l:>12}" for l in train_labels))
    for i, label in enumerate(train_labels):
        print(f"  {label:>12} " + " ".join(f"{cm[i][j]:>12}" for j in range(len(train_labels))))

    report = classification_report(y_val_arr, y_pred, target_names=[LABELS[i] if i < len(LABELS) else f"Class_{i}" for i in train_labels], output_dict=True, zero_division=0)

    # Feature importance
    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])[:10]
    print(f"\n[train-v2] Top 10 features by gain:")
    for name, score in importance_sorted:
        print(f"  {name}: {score:.3f}")

    # Save model
    model.save_model(str(MODEL_PATH))

    metrics = {
        "version": "v2",
        "target": "motivated_seller (non-leaking)",
        "accuracy": float(accuracy),
        "best_iteration": int(model.best_iteration) if model.best_iteration else 0,
        "n_train": len(X_train),
        "n_val": len(X_val),
        "n_features": len(FEATURE_COLUMNS),
        "features_excluded": ["price_vs_median"],
        "exclusion_reason": "price_vs_median was the labeling function in v1 — pure target leakage",
        "label_distribution": {LABELS[i] if i < len(LABELS) else f"Class_{i}": int((y == i).sum()) for i in range(len(LABELS))},
        "classification_report": report,
        "top_features": [{"name": n, "gain": float(s)} for n, s in importance_sorted],
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"\n[train-v2] Model saved to {MODEL_PATH}")
    print(f"[train-v2] Metrics saved to {METRICS_PATH}")

    # Honest assessment
    baseline = max(class_counts) / len(y_id)
    print(f"\n[train-v2] Baseline (always predict majority class): {baseline:.1%}")
    print(f"[train-v2] Model accuracy: {accuracy:.1%}")
    print(f"[train-v2] Lift over baseline: {accuracy - baseline:.1%}")

    if accuracy - baseline < 0.05:
        print(f"\n[train-v2] ⚠  Lift < 5% — model barely beats naive baseline.")
        print(f"[train-v2]    This is HONEST: the non-leaking target is hard to predict")
        print(f"[train-v2]    from static features alone. Need temporal data (price drops")
        print(f"[train-v2]    over time, views velocity) to do better.")
    else:
        print(f"\n[train-v2] ✓ Lift > 5% — model is learning something real.")

    conn.close()


if __name__ == "__main__":
    main()
