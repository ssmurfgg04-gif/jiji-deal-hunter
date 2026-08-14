"use client";

/**
 * Global error boundary.
 *
 * Next.js route-level error boundary. Catches any unhandled error thrown
 * during render of any route under /app, including the dashboard. Shows
 * a friendly fallback instead of a blank white page or a stack trace.
 *
 * Specifically useful for:
 *   - The temporal tab hitting empty states when the temporal tables
 *     don't exist yet (before live-collector has run)
 *   - API 500s that propagate as render errors
 *   - Prisma client initialization failures
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/routing/error-handling
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console — in production this should also go to Sentry / Datadog.
    console.error("[error-boundary]", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border bg-card p-8 text-center space-y-4">
        <div className="mx-auto w-fit rounded-full bg-red-100 p-3 dark:bg-red-950">
          <AlertTriangle className="size-6 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="text-xl font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">
          The dashboard hit an unexpected error. This is usually a transient
          backend issue — try reloading. If it persists, check the server logs
          for a stack trace.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono">
            Error ID: {error.digest}
          </p>
        )}
        {error.message && (
          <details className="text-xs text-left bg-muted/50 rounded p-2">
            <summary className="cursor-pointer text-muted-foreground">
              Show error details
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-all">{error.message}</pre>
          </details>
        )}
        <div className="flex gap-2 justify-center pt-2">
          <Button onClick={reset} variant="default">
            <RotateCcw className="size-4 mr-2" />
            Try again
          </Button>
          <Button
            onClick={() => (window.location.href = "/")}
            variant="outline"
          >
            Reload page
          </Button>
        </div>
      </div>
    </div>
  );
}
