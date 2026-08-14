"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
  Building2,
  Clock,
  Crosshair,
  Eye,
  Ghost,
  Gauge,
  Image as ImageIcon,
  MapPin,
  Pause,
  Phone,
  Play,
  Radio,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  TrendingDown,
  Users,
  Wifi,
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
type MarketId = "ke" | "ng" | "gh" | "tz" | "ug";

interface EnrichedListing {
  id: string;
  marketId: string;
  guid: string;
  title: string;
  price: number;
  currency: string;
  category: string;
  condition: string;
  location: string | null;
  imageUrl: string | null;
  imageCount: number;
  views: number;
  favCount: number;
  daysOnMarket: number;
  url: string | null;
  collectedAt: string;
  status: string;
  statusColor: string | null;
  dateCreated: string | null;
  dateEdited: string | null;
  dateModerated: string | null;
  soldReported: boolean;
  canMakeOffer: boolean;
  abuseReported: boolean;
  isBoost: boolean;
  availableTopsCount: number;
  seller: {
    id: string;
    marketId: string;
    numericUserId: number;
    username: string;
    location: string | null;
    accountAgeDays: number;
    totalListings: number;
    advertsCount: number;
    feedbackCount: number;
    rating: number;
    hidePhone: boolean;
    phoneLeaked: boolean;
    phone: string | null;
    verifiedBadge: boolean;
    isDealer: boolean;
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
    editChurn24h: boolean;
    moderationChurn24h: boolean;
    isGhostListing: boolean;
    abuseFlagged: boolean;
    isBoosted: boolean;
    dealerRatio: number;
    crossMarketBroker: boolean;
    imageDuplicateCount: number;
    relistCount: number;
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
  ghostListings: number;
  abuseFlagged: number;
  editChurn: number;
  moderationChurn: number;
  crossMarketBrokers: number;
  dealers: number;
  imageHashes: { total: number; duplicates: number };
  categories: { slug: string; count: number }[];
  markets: { id: string; count: number }[];
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

interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastRunSummary: {
    itemsCollected: number;
    itemsUpdated: number;
    fakeDiscounts: number;
    scamsFlagged: number;
    durationMs: number;
  } | null;
  nextRunAt: string | null;
  totalRuns: number;
}

interface LiveApiStatus {
  lastMode: "live" | "blocked" | "error";
  lastCheckedAt: string | null;
  lastError: string | null;
  liveSuccessCount: number;
  failureCount: number;
}

interface MarketInfo {
  id: MarketId;
  name: string;
  baseUrl: string;
  currency: string;
  enabled: boolean;
  lastCensusAt: string | null;
  listingsTracked: number;
}

interface SystemStatus {
  liveApi: LiveApiStatus;
  proxyPool: { working: number; total: number };
  markets: MarketInfo[];
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

const MARKET_LABELS: Record<MarketId, string> = {
  ke: "🇰🇪 Kenya",
  ng: "🇳🇬 Nigeria",
  gh: "🇬🇭 Ghana",
  tz: "🇹🇿 Tanzania",
  ug: "🇺🇬 Uganda",
};

const classColor: Record<DealClass, string> = {
  GREAT: "bg-emerald-100 text-emerald-700 border-emerald-200",
  FAIR: "bg-amber-100 text-amber-700 border-amber-200",
  RISKY: "bg-orange-100 text-orange-700 border-orange-200",
  SCAM: "bg-red-100 text-red-700 border-red-200",
};

function formatKES(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return `${n}`;
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

function nextRunAtLabel(s: SchedulerStatus | null, inLabel: string | null): string {
  if (!s) return "—";
  if (s.running) return "running...";
  if (!s.enabled) return "paused";
  if (!s.nextRunAt) return "starting...";
  return `next in ${inLabel ?? "?"}`;
}

export default function Home() {
  const [listings, setListings] = useState<EnrichedListing[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [seedingProxies, setSeedingProxies] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Live search bar state
  const [searchQ, setSearchQ] = useState("");
  const [searchMarket, setSearchMarket] = useState<MarketId>("ke");
  const [searchMinPrice, setSearchMinPrice] = useState("");
  const [searchMaxPrice, setSearchMaxPrice] = useState("");
  const [searchSort, setSearchSort] = useState<"new" | "price_asc" | "price_desc" | "relevance">("relevance");

  // DB listing filters
  const [q, setQ] = useState("");
  const [marketFilter, setMarketFilter] = useState<string>("all");
  const [category, setCategory] = useState("all");
  const [classification, setClassification] = useState("all");
  const [sort, setSort] = useState("-deal");
  const [filterMode, setFilterMode] = useState<"abuse" | "ghost" | "broker" | null>(null);

  // Tick "now" every 30s
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(i);
  }, []);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (marketFilter !== "all") params.set("marketId", marketFilter);
      if (category !== "all") params.set("category", category);
      if (classification !== "all") params.set("class", classification);
      params.set("sort", sort);
      if (filterMode === "abuse") params.set("abuse", "1");
      if (filterMode === "ghost") params.set("ghost", "1");
      if (filterMode === "broker") params.set("broker", "1");
      const resp = await fetch(`/api/listings?${params.toString()}`);
      const data = await resp.json();
      setListings(data.listings ?? []);
    } catch {
      toast.error("Failed to load listings");
    } finally {
      setLoading(false);
    }
  }, [q, marketFilter, category, classification, sort, filterMode]);

  const fetchStats = useCallback(async () => {
    try {
      const resp = await fetch("/api/stats");
      const data = await resp.json();
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  const fetchScheduler = useCallback(async () => {
    try {
      const resp = await fetch("/api/scheduler");
      const data = await resp.json();
      setScheduler(data as SchedulerStatus);
    } catch {
      // ignore
    }
  }, []);

  const fetchSystemStatus = useCallback(async () => {
    try {
      const resp = await fetch("/api/status");
      const data = await resp.json();
      setSystemStatus(data as SystemStatus);
    } catch {
      // ignore
    }
  }, []);

  const toggleScheduler = useCallback(
    async (action: "pause" | "resume" | "trigger") => {
      try {
        const resp = await fetch("/api/scheduler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = await resp.json();
        if (data.ok) {
          setScheduler(data.status as SchedulerStatus);
          if (action === "trigger") {
            toast.success("Manual collection triggered.");
            await Promise.all([fetchListings(), fetchStats()]);
          } else {
            toast.success(`Scheduler ${action}d.`);
          }
        } else {
          toast.error(data.error ?? `Scheduler ${action} failed`);
        }
      } catch {
        toast.error(`Scheduler ${action} failed`);
      }
    },
    [fetchListings, fetchStats]
  );

  const seedDefaultsAndValidate = useCallback(async () => {
    setSeedingProxies(true);
    try {
      const seedResp = await fetch("/api/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed_defaults" }),
      });
      const seedData = await seedResp.json();
      if (!seedData.ok) {
        toast.error(seedData.error ?? "Seed failed");
        return;
      }
      toast.info(`Seeded ${seedData.added} proxies. Validating...`);
      const valResp = await fetch("/api/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate" }),
      });
      const valData = await valResp.json();
      if (valData.ok) {
        toast.success(
          `Validated ${valData.tested} — ${valData.working} working against Jiji.`
        );
        await fetchSystemStatus();
      } else {
        toast.error(valData.error ?? "Validation failed");
      }
    } catch {
      toast.error("Proxy operation failed");
    } finally {
      setSeedingProxies(false);
    }
  }, [fetchSystemStatus]);

  const runCollection = useCallback(async () => {
    setCollecting(true);
    try {
      const resp = await fetch("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: marketFilter !== "all" ? marketFilter : undefined }),
      });
      const data = await resp.json();
      if (data.ok) {
        toast.success(
          `Collected ${data.summary.itemsCollected} new, ${data.summary.itemsUpdated} updated. ${data.summary.fakeDiscounts} fake discounts, ${data.summary.scamsFlagged} scams flagged.`
        );
        await Promise.all([fetchListings(), fetchStats(), fetchSystemStatus()]);
      } else if (data.blocked) {
        toast.error("Live API blocked by Cloudflare. Deploy to a server with residential IP or add proxies.");
        await fetchSystemStatus();
      } else {
        toast.error(data.error ?? "Collection failed");
      }
    } catch {
      toast.error("Collection failed");
    } finally {
      setCollecting(false);
    }
  }, [fetchListings, fetchStats, fetchSystemStatus, marketFilter]);

  const runLiveSearch = useCallback(async () => {
    if (!searchQ.trim()) {
      toast.error("Enter a search query first");
      return;
    }
    setSearching(true);
    try {
      const resp = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: searchQ.trim(),
          marketId: searchMarket,
          minPrice: searchMinPrice ? Number(searchMinPrice) : undefined,
          maxPrice: searchMaxPrice ? Number(searchMaxPrice) : undefined,
          sort: searchSort,
          persist: true,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        toast.success(
          `Found ${data.count} listings on Jiji ${searchMarket.toUpperCase()}. Persisted ${data.persisted} to DB.`
        );
        await Promise.all([fetchListings(), fetchStats(), fetchSystemStatus()]);
      } else if (data.blocked) {
        toast.error("Live API blocked by Cloudflare. Deploy to a server with residential IP.");
        await fetchSystemStatus();
      } else {
        toast.error(data.error ?? "Search failed");
      }
    } catch {
      toast.error("Search failed");
    } finally {
      setSearching(false);
    }
  }, [searchQ, searchMarket, searchMinPrice, searchMaxPrice, searchSort, fetchListings, fetchStats, fetchSystemStatus]);

  // Initial load
  useEffect(() => {
    (async () => {
      const [statsResp, schedResp, statusResp] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/scheduler"),
        fetch("/api/status"),
      ]);
      const [statsData, schedData, statusData] = await Promise.all([
        statsResp.json(),
        schedResp.json(),
        statusResp.json(),
      ]);
      setStats(statsData as StatsResponse);
      setScheduler(schedData as SchedulerStatus);
      setSystemStatus(statusData as SystemStatus);
      await fetchListings();
    })();
     
  }, []);

  // Re-fetch listings when filters change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fetchListings(), 250);
    return () => clearTimeout(t);
  }, [q, marketFilter, category, classification, sort, filterMode, fetchListings]);

  // Auto-refresh stats + scheduler + status every 60s
  useEffect(() => {
    const i = setInterval(() => {
      fetchStats();
      fetchScheduler();
      fetchSystemStatus();
    }, 60000);
    return () => clearInterval(i);
  }, [fetchStats, fetchScheduler, fetchSystemStatus]);

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

  const nextRunIn = useMemo(() => {
    if (!scheduler?.nextRunAt) return null;
    const ms = new Date(scheduler.nextRunAt).getTime() - now;
    if (ms <= 0) return "due";
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }, [scheduler, now]);

  const statCards = useMemo(() => {
    if (!stats) return [];
    return [
      { label: "Total Listings", value: stats.total.toLocaleString(), icon: ShoppingBag, tone: "neutral" as const },
      { label: "Great Deals", value: stats.greatDeals.toLocaleString(), sub: `${stats.fairDeals} fair`, icon: Gauge, tone: "good" as const },
      { label: "Fake Discounts", value: stats.fakeDiscounts.toLocaleString(), sub: `avg real ${pct(stats.avgDiscount)} off`, icon: TrendingDown, tone: "warn" as const },
      { label: "Scams Flagged", value: stats.scams.toLocaleString(), sub: `${stats.riskyDeals} risky`, icon: ShieldAlert, tone: "danger" as const },
      { label: "Ghost Listings", value: stats.ghostListings.toLocaleString(), sub: "sold but still active", icon: Ghost, tone: "danger" as const },
      { label: "Abuse Flagged", value: stats.abuseFlagged.toLocaleString(), sub: "previously reported", icon: AlertTriangle, tone: "danger" as const },
      { label: "Cross-Market Brokers", value: stats.crossMarketBrokers.toLocaleString(), sub: "same image across markets", icon: Building2, tone: "danger" as const },
      { label: "Detected Dealers", value: stats.dealers.toLocaleString(), sub: "adverts/feedback > 50", icon: Users, tone: "warn" as const },
    ];
  }, [stats]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-foreground text-background flex items-center justify-center">
              <Crosshair className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Jiji Deal Hunter</h1>
              <p className="text-xs text-muted-foreground">
                Multi-market · API-first · image-hash dedup · recon-derived scam signals
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {systemStatus?.liveApi && (
              <Badge
                variant="outline"
                className={`gap-1.5 font-normal ${
                  systemStatus.liveApi.lastMode === "live"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : systemStatus.liveApi.lastMode === "blocked"
                      ? "bg-red-50 text-red-700 border-red-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                }`}
                title={systemStatus.liveApi.lastError ?? "Live API status"}
              >
                {systemStatus.liveApi.lastMode === "live" ? <Radio className="size-3" /> : <AlertTriangle className="size-3" />}
                {systemStatus.liveApi.lastMode === "live"
                  ? "LIVE API"
                  : systemStatus.liveApi.lastMode === "blocked"
                    ? "BLOCKED"
                    : "ERROR"}
              </Badge>
            )}
            {scheduler && (
              <Badge variant="outline" className="gap-1.5 font-normal">
                <Clock className="size-3" />
                {scheduler.enabled ? nextRunAtLabel(scheduler, nextRunIn) : "Paused"}
              </Badge>
            )}
            {systemStatus?.proxyPool && (
              <Badge
                variant="outline"
                className={`gap-1.5 font-normal ${
                  systemStatus.proxyPool.working > 0
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-muted"
                }`}
              >
                <Server className="size-3" />
                {systemStatus.proxyPool.working}/{systemStatus.proxyPool.total} proxies
              </Badge>
            )}
            {scheduler && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => toggleScheduler(scheduler.enabled ? "pause" : "resume")}
              >
                {scheduler.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {scheduler.enabled ? "Pause" : "Resume"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={seedDefaultsAndValidate}
              disabled={seedingProxies}
            >
              <Wifi className="size-3.5" />
              {seedingProxies ? "..." : "Proxies"}
            </Button>
            <Button onClick={runCollection} disabled={collecting} size="sm">
              <Activity className="size-3.5" />
              {collecting ? "Collecting..." : "Collect"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 flex-1 space-y-6">
        {/* Live Search Bar — query Jiji directly with price filters */}
        <section className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Search className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Live Jiji Search</h2>
            <span className="text-xs text-muted-foreground">
              Query the live API directly — exact match, price filters, sort. Results are persisted to the DB.
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <Input
              placeholder="Search Jiji (e.g. iphone 14, toyota vitz, ps5)..."
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runLiveSearch(); }}
              className="md:col-span-4"
            />
            <Select value={searchMarket} onValueChange={(v) => setSearchMarket(v as MarketId)}>
              <SelectTrigger className="md:col-span-2">
                <SelectValue placeholder="Market" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MARKET_LABELS) as MarketId[]).map((m) => (
                  <SelectItem key={m} value={m}>{MARKET_LABELS[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="Min price"
              type="number"
              value={searchMinPrice}
              onChange={(e) => setSearchMinPrice(e.target.value)}
              className="md:col-span-2"
            />
            <Input
              placeholder="Max price"
              type="number"
              value={searchMaxPrice}
              onChange={(e) => setSearchMaxPrice(e.target.value)}
              className="md:col-span-2"
            />
            <Select value={searchSort} onValueChange={(v) => setSearchSort(v as any)}>
              <SelectTrigger className="md:col-span-1">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relevance">Relevance</SelectItem>
                <SelectItem value="new">Newest</SelectItem>
                <SelectItem value="price_asc">Price ↑</SelectItem>
                <SelectItem value="price_desc">Price ↓</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={runLiveSearch} disabled={searching} className="md:col-span-1">
              {searching ? "..." : "Go"}
            </Button>
          </div>
        </section>

        {/* Stat Cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {statCards.length === 0
            ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
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
                        <span className="truncate">{s.label}</span>
                        <span className={`inline-flex size-6 items-center justify-center rounded-md border ${toneClass} shrink-0`}>
                          <s.icon className="size-3" />
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="text-xl font-semibold tracking-tight">{s.value}</div>
                      {s.sub && <div className="text-[10px] text-muted-foreground mt-1 truncate">{s.sub}</div>}
                    </CardContent>
                  </Card>
                );
              })}
        </section>

        {/* Filters */}
        <section className="flex flex-col md:flex-row gap-2 md:items-center flex-wrap">
          <Input
            placeholder="Filter DB listings..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="md:max-w-xs"
          />
          <Select value={marketFilter} onValueChange={setMarketFilter}>
            <SelectTrigger className="md:w-32">
              <SelectValue placeholder="Market" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All markets</SelectItem>
              {(systemStatus?.markets ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id.toUpperCase()} ({m.listingsTracked})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <SelectTrigger className="md:w-36">
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
            <SelectTrigger className="md:w-40">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-deal">Best deal first</SelectItem>
              <SelectItem value="price-asc">Price: low to high</SelectItem>
              <SelectItem value="price-desc">Price: high to low</SelectItem>
              <SelectItem value="recent">Recently collected</SelectItem>
              <SelectItem value="risk">Highest risk first</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filterMode ?? "none"}
            onValueChange={(v) => setFilterMode(v === "none" ? null : (v as any))}
          >
            <SelectTrigger className="md:w-40">
              <SelectValue placeholder="Special filters" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No special filter</SelectItem>
              <SelectItem value="abuse">Abuse-flagged only</SelectItem>
              <SelectItem value="ghost">Ghost listings only</SelectItem>
              <SelectItem value="broker">Cross-market brokers</SelectItem>
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
                <TableHead className="w-[22%]">Item</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Median</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Seller</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Scam Signals</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : listings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                    No listings in DB. Use the search bar above to query Jiji live, or click Collect.
                  </TableCell>
                </TableRow>
              ) : (
                listings.map((l) => (
                  <Fragment key={l.id}>
                    <TableRow
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
                              <ImageIcon className="size-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate">{l.title}</div>
                            <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
                              <Badge variant="outline" className="text-[10px] py-0 px-1">{l.marketId.toUpperCase()}</Badge>
                              <span>{l.condition}</span>
                              {l.location && (
                                <>
                                  <span>·</span>
                                  <MapPin className="size-2.5" />
                                  <span>{l.location}</span>
                                </>
                              )}
                              <span>·</span>
                              <Eye className="size-2.5" />
                              <span>{l.views} views</span>
                              <span>·</span>
                              <span>{l.daysOnMarket}d</span>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-semibold">
                        {l.price.toLocaleString()}
                        <div className="text-[10px] text-muted-foreground">{l.currency}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {l.marketMedian ? l.marketMedian.toLocaleString() : "—"}
                        {l.score && l.marketMedian > 0 && (
                          <span className={`ml-1 ${l.score.priceVsMedian > 0 ? "text-emerald-600" : "text-red-600"}`}>
                            ({l.score.priceVsMedian > 0 ? "−" : "+"}
                            {Math.abs(l.score.priceVsMedian * 100).toFixed(0)}%)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {l.score ? (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold tabular-nums">{l.score.score.toFixed(0)}</span>
                            <Badge variant="outline" className={classColor[l.score.classification]}>
                              {l.score.classification}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">unscored</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm">{l.seller.username}</span>
                          {l.seller.verifiedBadge && <ShieldCheck className="size-3 text-emerald-600" />}
                          {l.seller.isDealer && <Building2 className="size-3 text-orange-600" />}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {l.seller.accountAgeDays}d · {l.seller.totalListings} listings ·{" "}
                          {l.seller.advertsCount}/{Math.max(l.seller.feedbackCount, 1)} ads/fb
                        </div>
                      </TableCell>
                      <TableCell>
                        {l.seller.phone ? (
                          <a
                            href={`tel:${l.seller.phone.replace(/\s/g, "")}`}
                            className="font-mono text-xs hover:underline inline-flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Phone className="size-3" />
                            {l.seller.phone}
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">No phone</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {l.score?.hasFakeDiscount && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-orange-50 text-orange-700 border-orange-200">
                              Fake %
                            </Badge>
                          )}
                          {l.score?.hasPhoneLeak && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-red-50 text-red-700 border-red-200">
                              Phone leak
                            </Badge>
                          )}
                          {l.score?.isGhostListing && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-red-50 text-red-700 border-red-200">
                              <Ghost className="size-2.5" /> Ghost
                            </Badge>
                          )}
                          {l.score?.abuseFlagged && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-red-50 text-red-700 border-red-200">
                              <AlertTriangle className="size-2.5" /> Abuse
                            </Badge>
                          )}
                          {l.score?.moderationChurn24h && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-orange-50 text-orange-700 border-orange-200">
                              Mod churn
                            </Badge>
                          )}
                          {l.score?.editChurn24h && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-amber-50 text-amber-700 border-amber-200">
                              Edit churn
                            </Badge>
                          )}
                          {l.score?.isBoosted && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-purple-50 text-purple-700 border-purple-200">
                              Boosted
                            </Badge>
                          )}
                          {l.score?.crossMarketBroker && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-red-50 text-red-700 border-red-200">
                              <Building2 className="size-2.5" /> Broker
                            </Badge>
                          )}
                          {l.score && l.score.imageDuplicateCount > 0 && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 bg-orange-50 text-orange-700 border-orange-200">
                              <ImageIcon className="size-2.5" /> {l.score.imageDuplicateCount}x dup
                            </Badge>
                          )}
                          {!l.score?.hasFakeDiscount &&
                           !l.score?.hasPhoneLeak &&
                           !l.score?.isGhostListing &&
                           !l.score?.abuseFlagged &&
                           !l.score?.crossMarketBroker &&
                           (!l.score || l.score.imageDuplicateCount === 0) && (
                            <span className="text-[10px] text-muted-foreground">
                              risk {Math.round((l.score?.sellerRisk ?? 0) * 100)}%
                            </span>
                          )}
                        </div>
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
                        <TableCell colSpan={8} className="p-4">
                          <ExpandedRow loading={historyLoading} history={history} listing={l} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </main>

      <footer className="border-t bg-card mt-auto">
        <div className="container mx-auto px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2 text-xs text-muted-foreground">
          <div>
            Pipeline: <span className="font-mono">categories_counts.json → listing?category_type → item/{`{guid}`} → image-hash dedup → XGBoost-style scorer</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1"><Users className="size-3" /> {stats?.total ?? 0} listings</span>
            <span className="inline-flex items-center gap-1"><TrendingDown className="size-3" /> {stats?.fakeDiscounts ?? 0} fake discounts</span>
            <span className="inline-flex items-center gap-1"><Ghost className="size-3" /> {stats?.ghostListings ?? 0} ghosts</span>
            <span className="inline-flex items-center gap-1"><AlertTriangle className="size-3" /> {stats?.abuseFlagged ?? 0} abuse</span>
            <span className="inline-flex items-center gap-1"><Building2 className="size-3" /> {stats?.crossMarketBrokers ?? 0} brokers</span>
            <span className="inline-flex items-center gap-1"><ImageIcon className="size-3" /> {stats?.imageHashes?.total ?? 0} image hashes ({stats?.imageHashes?.duplicates ?? 0} dup)</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ExpandedRow({
  loading,
  history,
  listing,
}: {
  loading: boolean;
  history: HistoryResponse | null;
  listing: EnrichedListing;
}) {
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!history) return <div className="text-sm text-muted-foreground">No history available.</div>;

  const chartData = history.history.map((h) => ({
    date: new Date(h.recordedAt).toLocaleDateString(),
    price: h.price,
  }));

  const factors = listing.score ? parseFactors(listing) : [];
  const claimedVsReal =
    listing.score?.claimedDiscount != null && listing.score?.realDiscount != null
      ? { claimed: listing.score.claimedDiscount, real: listing.score.realDiscount }
      : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="md:col-span-2 border rounded-lg p-3 bg-background">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Price History</h3>
          {claimedVsReal && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-orange-600 line-through">Claimed {pct(claimedVsReal.claimed)} off</span>
              <span className="text-emerald-600">Real {pct(claimedVsReal.real)} off</span>
            </div>
          )}
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => formatKES(v)} width={50} />
              <Tooltip formatter={(v: number) => [v.toLocaleString(), "Price"]} contentStyle={{ fontSize: 12 }} />
              <ReferenceLine y={history.listing.currentPrice} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="price" stroke="hsl(var(--foreground))" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="border rounded-lg p-3 bg-background">
        <h3 className="text-sm font-medium mb-2">Risk Factors</h3>
        <div className="space-y-1.5">
          {factors.map((f) => (
            <div key={f.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <span className={`font-mono font-medium ${f.danger ? "text-red-600" : ""}`}>{f.value}</span>
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t">
          <div className="text-xs text-muted-foreground mb-1">Seller Contact</div>
          {listing.seller.phone ? (
            <a
              href={`tel:${listing.seller.phone.replace(/\s/g, "")}`}
              className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-800 text-xs font-mono hover:bg-emerald-100"
            >
              <Phone className="size-3.5" />
              Call {listing.seller.phone}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">No phone published</span>
          )}
          {listing.seller.phoneLeaked && (
            <div className="text-[10px] text-red-600 mt-1">⚠ Phone hidden on listing but API exposed it.</div>
          )}
        </div>

        {listing.url && (
          <a href={listing.url} target="_blank" rel="noopener noreferrer" className="block mt-3 text-xs text-foreground underline underline-offset-2">
            View original listing →
          </a>
        )}
      </div>
    </div>
  );
}

function parseFactors(l: EnrichedListing): { label: string; value: string; danger?: boolean }[] {
  if (!l.score) return [];
  const factors: Array<{ label: string; value: string; danger?: boolean }> = [
    { label: "Price vs Median", value: `${(l.score.priceVsMedian * 100).toFixed(1)}%` },
    { label: "Seller Risk", value: `${(l.score.sellerRisk * 100).toFixed(0)}%` },
    { label: "Dealer Ratio", value: l.score.dealerRatio.toFixed(1), danger: l.score.dealerRatio > 50 },
    { label: "Image Duplicates", value: String(l.score.imageDuplicateCount), danger: l.score.imageDuplicateCount > 0 },
    { label: "Relist Count", value: String(l.score.relistCount), danger: l.score.relistCount > 0 },
    { label: "Edit Churn 24h", value: l.score.editChurn24h ? "YES" : "no", danger: l.score.editChurn24h },
    { label: "Mod Churn 24h", value: l.score.moderationChurn24h ? "YES" : "no", danger: l.score.moderationChurn24h },
    { label: "Ghost Listing", value: l.score.isGhostListing ? "YES" : "no", danger: l.score.isGhostListing },
    { label: "Abuse Flagged", value: l.score.abuseFlagged ? "YES" : "no", danger: l.score.abuseFlagged },
    { label: "Boosted", value: l.score.isBoosted ? "YES" : "no" },
    { label: "Cross-Market", value: l.score.crossMarketBroker ? "YES" : "no", danger: l.score.crossMarketBroker },
    { label: "Phone Leak", value: l.score.hasPhoneLeak ? "YES" : "no", danger: l.score.hasPhoneLeak },
    { label: "Fake Discount", value: l.score.hasFakeDiscount ? "YES" : "no", danger: l.score.hasFakeDiscount },
  ];
  if (l.score.claimedDiscount != null) {
    factors.push({ label: "Claimed Discount", value: pct(l.score.claimedDiscount) });
  }
  if (l.score.realDiscount != null) {
    factors.push({ label: "Real Discount", value: pct(l.score.realDiscount) });
  }
  return factors;
}
