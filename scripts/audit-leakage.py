#!/usr/bin/env python3
"""
Leakage audit — train with and without price_vs_median to confirm the
suspicion that the 99.7% accuracy is the model reverse-engineering the
labeling heuristic, not learning anything real.

If accuracy collapses from 99.7% to ~65% when we drop price_vs_median,
that confirms leakage: the label was derived from price_vs_median, so
the model was just learning the labeling function.
"""

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
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "custom.db"

FEATURE_COLUMNS = [
    "price",
    "price_vs_median",        # ← SUSPECTED LEAK
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
    return pd.read_sql_query(query, conn)


def engineer_features(df):
    def median_ratio(group):
        med = group.median()
        if med is None or med <= 0:
            return pd.Series([0.0] * len(group), index=group.index)
        return (med - group) / med
    df["price_vs_median"] = df.groupby("category_id")["price"].transform(median_ratio)

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

    df["image_duplicate_count"] = df["image_duplicate_count"].fillna(0)
    df["cross_seller_count"] = df["cross_seller_count"].fillna(1)
    df["relist_count"] = df["relist_count"].fillna(0)
    df["cross_market_broker"] = df["cross_market_broker"].fillna(0).astype(int)

    # SAME labeling function as train-xgboost.py — this is what we're auditing
    def weak_label(row):
        if row["abuse_reported"] == 1 or row.get("cross_market_broker", 0) == 1:
            return "SCAM"
        if row.get("cross_seller_count", 1) > 1:
            return "SCAM"
        if row.get("below_market_valuation", 0) == 1:
            return "SCAM"
        if row["views"] is not None and row["views"] > 1000 and (row["fav_count"] or 0) < 2:
            return "SCAM"
        if row["price_vs_median"] > 0.20:
            return "GREAT"
        if row["dealer_ratio"] > 50 or row.get("is_dealer", 0) == 1:
            return "RISKY"
        if row["price_vs_median"] < -0.15:
            return "RISKY"
        if row["views"] is not None and row["views"] < 10:
            return "RISKY"
        return "FAIR"

    df["label"] = df.apply(weak_label, axis=1)
    X = df[FEATURE_COLUMNS].copy().fillna(0).astype(np.float32)
    y = df["label"]
    return X, y, df


def train_and_evaluate(X, y, label, exclude_features=None):
    """Train XGBoost with optional feature exclusion."""
    features = [f for f in X.columns if f not in (exclude_features or [])]
    X_sub = X[features]

    present_labels = sorted(y.unique())
    label_to_id = {l: i for i, l in enumerate(present_labels)}
    y_id = y.map(label_to_id)

    class_counts = y_id.value_counts()
    can_stratify = class_counts.min() >= 2
    X_train, X_val, y_train, y_val = train_test_split(
        X_sub, y_id, test_size=0.2, random_state=42,
        stratify=y_id if can_stratify else None,
    )

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
        print(f"  [{label}] Need at least 2 classes — skipping")
        return None

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

    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    y_pred = model.predict(X_val)
    y_pred = np.asarray(y_pred).ravel().astype(int)
    y_val_arr = np.asarray(y_val).ravel().astype(int)
    accuracy = accuracy_score(y_val_arr, y_pred)

    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])[:5]

    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    print(f"  Features used: {len(features)}")
    print(f"  Features excluded: {exclude_features or []}")
    print(f"  Train rows: {len(X_train)}, Val rows: {len(X_val)}")
    print(f"  Classes: {train_labels}")
    print(f"  Label distribution: {dict(y_train.value_counts().sort_index())}")
    print(f"  Accuracy: {accuracy:.3f}")
    print(f"  Top 5 features by gain:")
    for name, score in importance_sorted:
        print(f"    {name}: {score:.3f}")

    return {"accuracy": accuracy, "top_features": importance_sorted, "n_features": len(features)}


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("[audit] Loading data...")
    df = load_dataframe(conn)
    print(f"[audit] Loaded {len(df)} listings")

    X, y, raw_df = engineer_features(df)

    # Show the label distribution
    print(f"\n[audit] Label distribution:")
    for label, count in y.value_counts().items():
        print(f"  {label}: {count} ({count/len(y)*100:.1f}%)")

    # Show how price_vs_median relates to the label
    print(f"\n[audit] price_vs_median by label (the smoking gun):")
    for label in sorted(y.unique()):
        mask = y == label
        pvm = raw_df.loc[mask, "price_vs_median"]
        print(f"  {label}: mean={pvm.mean():.3f}, min={pvm.min():.3f}, max={pvm.max():.3f}")

    # Experiment 1: full feature set (the 99.7% model)
    result_full = train_and_evaluate(X, y, "EXPERIMENT 1: Full feature set (with price_vs_median)")

    # Experiment 2: exclude price_vs_median
    result_no_pvm = train_and_evaluate(X, y, "EXPERIMENT 2: EXCLUDING price_vs_median (leakage test)",
                                       exclude_features=["price_vs_median"])

    # Experiment 3: exclude all price-derived features
    result_no_price = train_and_evaluate(X, y, "EXPERIMENT 3: EXCLUDING all price features",
                                         exclude_features=["price", "price_vs_median"])

    # Summary
    print(f"\n{'='*60}")
    print(f"  LEAKAGE AUDIT SUMMARY")
    print(f"{'='*60}")
    if result_full and result_no_pvm:
        drop = result_full["accuracy"] - result_no_pvm["accuracy"]
        print(f"  With price_vs_median:    {result_full['accuracy']:.1%}")
        print(f"  Without price_vs_median: {result_no_pvm['accuracy']:.1%}")
        print(f"  Accuracy drop:            {drop:.1%}")
        if drop > 0.15:
            print(f"\n  ⚠  LEAKAGE CONFIRMED: dropping price_vs_median causes a {drop:.1%} accuracy drop.")
            print(f"     The 99.7% accuracy was the model reverse-engineering the labeling heuristic,")
            print(f"     not learning anything real about deals.")
            print(f"\n  The label 'GREAT' is defined as price_vs_median > 0.20 in the weak_label function.")
            print(f"  Including price_vs_median as a feature is pure target leakage.")
        else:
            print(f"\n  ✓ No significant leakage — price_vs_median is not the labeling function.")

    conn.close()


if __name__ == "__main__":
    main()
