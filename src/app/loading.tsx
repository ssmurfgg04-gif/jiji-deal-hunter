/**
 * Global loading fallback.
 *
 * Shown by Next.js Suspense while any route segment under /app is loading.
 * Gives instant feedback on navigation instead of a blank screen.
 */
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="min-h-screen p-4 md:p-8 space-y-6">
      {/* Header skeleton */}
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Stat cards skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>

      {/* Tabs skeleton */}
      <Skeleton className="h-10 w-full max-w-md" />

      {/* Table skeleton */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
