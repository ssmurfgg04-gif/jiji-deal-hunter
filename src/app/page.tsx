"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Crosshair,
  Gauge,
  Phone,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  TrendingDown,
  Users,
} from "lucide-react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";
import { formatDistanceToNow } from "date-fns";

type DealClass = "GREAT" | "FAIR" | "RISKY" | "SCAM";

interface EnrichedListing {
  id: string;
  title: string;
  price: number;
  currency: string;
  category: string;
  condition: string;
  location: string | null;
  imageUrl: string | null;
  imageCount: number;
  views: number;
  daysOnMarket: number;
  url: string | null;
  collectedAt: string;
  seller: {
    id: string;
    username: string;
    location: string | null;
    accountAgeDays: number;
    totalListings: number;
    rating: number;
    hidePhone: boolean;
    phoneLeaked: boolean;
    verifiedBadge: boolean;
  };
  marketMedian: number;
  score: {
    score: number;
    classification: DealClass;
    priceVsMedian: number;
    sellerRisk: number;
    popularityRisk: number;
    priceManipulation: number;
    hasPhoneLeak: boolean;
    hasFakeDiscount: boolean;
    claimedDiscount: number | null;
    realDiscount: number | null;
  } | null;
}

interface StatsResponse {
  total: number;
  greatDeals: number;
  fairDeals: number;
  riskyDeals: number;
  scams: number;
  fakeDiscounts: number;
  avgDiscount: number;
  categories: { slug: string; count: number }[];
  lastRun: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    itemsCollected: number;
    itemsUpdated: number;
    fakeDiscounts: number;
    scamsFlagged: number;
    sourceMode: string;
  } | null;
}

interface HistoryResponse {
  listing: {
    id: string;
    title: string;
    currentPrice: number;
    category: string;
    condition: string;
    url: string | null;
  };
  history: { price: number; recordedAt: string }[];
  score: any;
}

const classColor: Record<DealClass, string> = {
  GREAT: "bg-emerald-100 text-emerald-700 border-emerald-200",
  FAIR: "bg-amber-100 text-amber-700 border-amber-200",
  RISKY: "bg-orange-100 text-orange-700 border-orange-200",
  SCAM: "bg-red-100 text-red-700 border-red-200",
};

function formatKES(n: number): string {
  if (n >= 1000) return `KES ${(n / 1000).toFixed(0)}K`;
  return `KES ${n}`;
}

function pct(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function timeAgo(date: string | null): string {
  if (!date) return "never";
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return "—";
  }
}

export default function Home() {
  const [listings, setListings] = useState<EnrichedListing[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Filters
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [classification, setClassification] = useState("all");
  const [sort, setSort] = useState("-deal");

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (category !== "all") params.set("category", category);
      if (classification !== "all") params.set("class", classification);
      params.set("sort", sort);
      const resp = await fetch(`/api/listings?${params.toString()}`);
      const data = await resp.json();
      setListings(data.listings ?? []);
    } catch (e) {
      toast.error("Failed to load listings");
    } finally {
      setLoading(false);
    }
  }, [q, category, classification, sort]);

  const fetchStats = useCallback(async () => {
    try {
      const resp = await fetch("/api/stats");
      const data = await resp.json();
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  const runCollection = useCallback(async () => {
    setCollecting(true);
    try {
      const resp = await fetch("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (data.ok) {
        toast.success(
          `Collected ${data.summary.itemsCollected} new, ${data.summary.itemsUpdated} updated. ${data.summary.fakeDiscounts} fake discounts, ${data.summary.scamsFlagged} scams flagged.`
        );
        await Promise.all([fetchListings(), fetchStats()]);
      } else {
        toast.error(data.error ?? "Collection failed");
      }
    } catch (e) {
      toast.error("Collection failed");
    } finally {
      setCollecting(false);
    }
  }, [fetchListings, fetchStats]);

  // Initial load — and auto-collect if DB is empty
  useEffect(() => {
    (async () => {
      const statsResp = await fetch("/api/stats");
      const statsData: StatsResponse = await statsResp.json();
      setStats(statsData);
      if (statsData.total === 0 && !collecting) {
        // DB is empty — kick off the first collection automatically
        setCollecting(true);
        try {
          const resp = await fetch("/api/collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await resp.json();
          if (data.ok) {
            toast.success(
              `Initial collection done: ${data.summary.itemsCollected} new listings. ${data.summary.fakeDiscounts} fake discounts, ${data.summary.scamsFlagged} scams flagged.`
            );
          } else {
            toast.error(data.error ?? "Initial collection failed");
          }
        } catch {
          toast.error("Initial collection failed");
        } finally {
          setCollecting(false);
        }
      }
      await fetchListings();
      await fetchStats();
    })();
     
  }, []);

  // Re-fetch listings when filters change (debounced search)
  useEffect(() => {
    const t = setTimeout(() => fetchListings(), 250);
    return () => clearTimeout(t);
  }, [q, category, classification, sort, fetchListings]);

  // Auto-refresh stats every 60s
  useEffect(() => {
    const i = setInterval(() => fetchStats(), 60000);
    return () => clearInterval(i);
  }, [fetchStats]);

  const toggleExpand = useCallback(
    async (listingId: string) => {
      if (expandedRow === listingId) {
        setExpandedRow(null);
        setHistory(null);
        return;
      }
      setExpandedRow(listingId);
      setHistoryLoading(true);
      try {
        const resp = await fetch(`/api/listing-history?id=${listingId}`);
        const data = await resp.json();
        setHistory(data);
      } catch {
        toast.error("Failed to load price history");
      } finally {
        setHistoryLoading(false);
      }
    },
    [expandedRow]
  );

  const statCards = useMemo(() => {
    if (!stats) return [];
    return [
      {
        label: "Total Listings",
        value: stats.total.toLocaleString(),
        icon: ShoppingBag,
        tone: "neutral" as const,
      },
      {
        label: "Great Deals",
        value: stats.greatDeals.toLocaleString(),
        sub: `${stats.fairDeals} fair`,
        icon: Gauge,
        tone: "good" as const,
      },
      {
        label: "Fake Discounts",
        value: stats.fakeDiscounts.toLocaleString(),
        sub: `avg real ${pct(stats.avgDiscount)} off`,
        icon: TrendingDown,
        tone: "warn" as const,
      },
      {
        label: "Scams Flagged",
        value: stats.scams.toLocaleString(),
        sub: `${stats.riskyDeals} risky`,
        icon: ShieldAlert,
        tone: "danger" as const,
      },
    ];
  }, [stats]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-foreground text-background flex items-center justify-center">
              <Crosshair className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Jiji Deal Hunter</h1>
              <p className="text-xs text-muted-foreground">
                API-first collector · fake-discount detector · XGBoost-style deal scoring
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="gap-1.5 font-normal">
              <Activity className="size-3" />
              Last run: {timeAgo(stats?.lastRun?.finishedAt ?? null)}
            </Badge>
            {stats?.lastRun?.sourceMode && (
              <Badge variant="outline" className="font-normal">
                Source: {stats.lastRun.sourceMode}
              </Badge>
            )}
            <Button onClick={runCollection} disabled={collecting} size="sm">
              {collecting ? "Collecting..." : "Run Collection Now"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 flex-1 space-y-6">
        {/* Stat Cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {statCards.length === 0
            ? Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))
            : statCards.map((s) => {
                const toneClass =
                  s.tone === "good"
                    ? "text-emerald-600 bg-emerald-50 border-emerald-100"
                    : s.tone === "warn"
                      ? "text-orange-600 bg-orange-50 border-orange-100"
                      : s.tone === "danger"
                        ? "text-red-600 bg-red-50 border-red-100"
                        : "text-foreground bg-muted border-border";
                return (
                  <Card key={s.label} className="overflow-hidden">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                        {s.label}
                        <span
                          className={`inline-flex size-7 items-center justify-center rounded-md border ${toneClass}`}
                        >
                          <s.icon className="size-3.5" />
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
                      {s.sub && (
                        <div className="text-xs text-muted-foreground mt-1">{s.sub}</div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
        </section>

        {/* Filters */}
        <section className="flex flex-col md:flex-row gap-2 md:items-center">
          <Input
            placeholder="Search listings (e.g. iphone, ps5, macbook)..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="md:max-w-xs"
          />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="md:w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {(stats?.categories ?? []).map((c) => (
                <SelectItem key={c.slug} value={c.slug}>
                  {c.slug} ({c.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={classification} onValueChange={setClassification}>
            <SelectTrigger className="md:w-40">
              <SelectValue placeholder="Deal class" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All deals</SelectItem>
              <SelectItem value="GREAT">Great</SelectItem>
              <SelectItem value="FAIR">Fair</SelectItem>
              <SelectItem value="RISKY">Risky</SelectItem>
              <SelectItem value="SCAM">Scam</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="md:w-44">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-deal">Best deal first</SelectItem>
              <SelectItem value="price-asc">Price: low to high</SelectItem>
              <SelectItem value="price-desc">Price: high to low</SelectItem>
              <SelectItem value="recent">Recently collected</SelectItem>
            </SelectContent>
          </Select>
          <div className="md:ml-auto text-xs text-muted-foreground">
            {listings.length} listings shown
          </div>
        </section>

        {/* Main Table */}
        <section className="rounded-xl border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Item</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Market Median</TableHead>
                <TableHead>Deal Score</TableHead>
                <TableHead>Seller</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : listings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                    No listings found. Try adjusting filters or run a new collection.
                  </TableCell>
                </TableRow>
              ) : (
                listings.map((l) => (
                  <>
                    <TableRow
                      key={l.id}
                      onClick={() => toggleExpand(l.id)}
                      className="cursor-pointer hover:bg-muted/50"
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="size-10 rounded-md bg-muted flex items-center justify-center overflow-hidden shrink-0">
                            {l.imageUrl ? (
                               
                              <img
                                src={l.imageUrl}
                                alt=""
                                className="size-full object-cover"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                            ) : (
                              <ShoppingBag className="size-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate">{l.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {l.condition} · {l.location ?? "—"} · {l.views} views ·{" "}
                              {l.daysOnMarket}d on market
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-semibold">{formatKES(l.price)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {l.marketMedian ? formatKES(l.marketMedian) : "—"}
                        {l.score && l.marketMedian > 0 && (
                          <span
                            className={`ml-1 text-xs ${
                              l.score.priceVsMedian > 0 ? "text-emerald-600" : "text-red-600"
                            }`}
                          >
                            ({l.score.priceVsMedian > 0 ? "−" : "+"}
                            {Math.abs(l.score.priceVsMedian * 100).toFixed(0)}%)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {l.score ? (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold tabular-nums">
                              {l.score.score.toFixed(0)}
                            </span>
                            <Badge
                              variant="outline"
                              className={classColor[l.score.classification]}
                            >
                              {l.score.classification}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">unscored</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{l.seller.username}</span>
                          {l.seller.verifiedBadge && (
                            <ShieldCheck className="size-3.5 text-emerald-600" />
                          )}
                          {l.seller.phoneLeaked && (
                            <Phone className="size-3.5 text-red-600" />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {l.seller.accountAgeDays}d · {l.seller.totalListings} listings ·{" "}
                          {l.seller.rating.toFixed(1)}★
                        </div>
                      </TableCell>
                      <TableCell>
                        {l.score ? (
                          <div className="space-y-0.5">
                            {l.score.hasFakeDiscount && (
                              <div className="flex items-center gap-1 text-xs text-orange-600">
                                <AlertTriangle className="size-3" /> Fake discount
                              </div>
                            )}
                            {l.score.hasPhoneLeak && (
                              <div className="flex items-center gap-1 text-xs text-red-600">
                                <Phone className="size-3" /> Phone leak
                              </div>
                            )}
                            {!l.score.hasFakeDiscount && !l.score.hasPhoneLeak && (
                              <div className="text-xs text-muted-foreground">
                                risk {Math.round(l.score.sellerRisk * 100)}%
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {expandedRow === l.id ? (
                          <ArrowUp className="size-4 inline text-muted-foreground" />
                        ) : (
                          <ArrowDown className="size-4 inline text-muted-foreground" />
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedRow === l.id && (
                      <TableRow key={`${l.id}-expanded`} className="bg-muted/30">
                        <TableCell colSpan={7} className="p-4">
                          <ExpandedRow
                            loading={historyLoading}
                            history={history}
                            listing={l}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="container mx-auto px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2 text-xs text-muted-foreground">
          <div>
            Pipeline: <span className="font-mono">reverseloom → httpx API direct → DrissionPage fallback → XGBoost scorer</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3" /> {stats?.total ?? 0} listings tracked
            </span>
            <span className="inline-flex items-center gap-1">
              <TrendingDown className="size-3" /> {stats?.fakeDiscounts ?? 0} fake discounts
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldAlert className="size-3" /> {stats?.scams ?? 0} scams flagged
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Expanded row content: price-history sparkline + risk factors.
 */
function ExpandedRow({
  loading,
  history,
  listing,
}: {
  loading: boolean;
  history: HistoryResponse | null;
  listing: EnrichedListing;
}) {
  if (loading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!history) {
    return <div className="text-sm text-muted-foreground">No history available.</div>;
  }

  const chartData = history.history.map((h) => ({
    date: new Date(h.recordedAt).toLocaleDateString(),
    price: h.price,
  }));

  const factors = listing.score ? parseFactors(listing) : [];
  const claimedVsReal =
    listing.score?.claimedDiscount != null && listing.score?.realDiscount != null
      ? {
          claimed: listing.score.claimedDiscount,
          real: listing.score.realDiscount,
        }
      : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Price History Chart */}
      <div className="md:col-span-2 border rounded-lg p-3 bg-background">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Price History</h3>
          {claimedVsReal && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-orange-600 line-through">
                Claimed {pct(claimedVsReal.claimed)} off
              </span>
              <span className="text-emerald-600">
                Real {pct(claimedVsReal.real)} off
              </span>
            </div>
          )}
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis
                tick={{ fontSize: 10 }}
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v) => formatKES(v)}
                width={50}
              />
              <Tooltip
                formatter={(v: number) => [formatKES(v), "Price"]}
                contentStyle={{ fontSize: 12 }}
              />
              <ReferenceLine y={history.listing.currentPrice} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="price"
                stroke="hsl(var(--foreground))"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Risk Factors */}
      <div className="border rounded-lg p-3 bg-background">
        <h3 className="text-sm font-medium mb-2">Risk Factors</h3>
        <div className="space-y-2">
          {factors.map((f) => (
            <div key={f.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="font-mono font-medium">{f.value}</span>
            </div>
          ))}
        </div>
        {listing.url && (
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-3 text-xs text-foreground underline underline-offset-2"
          >
            View original listing →
          </a>
        )}
      </div>
    </div>
  );
}

function parseFactors(l: EnrichedListing): { label: string; value: string }[] {
  if (!l.score) return [];
  return [
    { label: "Price vs Median", value: `${(l.score.priceVsMedian * 100).toFixed(1)}%` },
    { label: "Seller Risk", value: `${(l.score.sellerRisk * 100).toFixed(0)}%` },
    { label: "Popularity Risk", value: `${(l.score.popularityRisk * 100).toFixed(0)}%` },
    {
      label: "Price Manipulation",
      value: `${(l.score.priceManipulation * 100).toFixed(0)}%`,
    },
    { label: "Phone Leak", value: l.score.hasPhoneLeak ? "YES" : "no" },
    { label: "Fake Discount", value: l.score.hasFakeDiscount ? "YES" : "no" },
    {
      label: "Claimed Discount",
      value: l.score.claimedDiscount != null ? pct(l.score.claimedDiscount) : "—",
    },
    {
      label: "Real Discount",
      value: l.score.realDiscount != null ? pct(l.score.realDiscount) : "—",
    },
  ];
}
