import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLiveApiStatus } from "@/lib/jiji-client";

/**
 * GET /api/collect/stream — Server-Sent Events for live collection progress.
 *
 * Streams real-time updates about the live API status (live / blocked / error),
 * success/failure counts, and the most recent collection runs. The dashboard
 * can subscribe to this endpoint to show live status without polling.
 *
 * SSE protocol:
 *   event: status
 *   data: { "lastMode": "blocked", "liveSuccessCount": 0, "failureCount": 12, ... }
 *
 *   event: runs
 *   data: [{ "id": "...", "startedAt": "...", "itemsCollected": 100, ... }, ...]
 *
 * Reconnect: browser EventSource auto-reconnects with exponential backoff.
 *
 * Why SSE not WebSocket:
 *   - Unidirectional (server → client only) — no client→server traffic needed
 *   - Native EventSource API in browsers (no library)
 *   - HTTP/2 multiplexing (no separate connection overhead)
 *   - Auto-reconnect built into the protocol
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      // Initial heartbeat
      send("heartbeat", { ts: Date.now() });

      // Stream status every 3s
      const statusInterval = setInterval(async () => {
        try {
          const status = await getLiveApiStatus();
          send("status", status);
        } catch (e: any) {
          send("error", { message: e?.message ?? "status fetch failed" });
        }
      }, 3000);

      // Stream recent runs every 10s
      const runsInterval = setInterval(async () => {
        try {
          const runs = await db.collectionRun.findMany({
            orderBy: { startedAt: "desc" },
            take: 5,
            select: {
              id: true,
              marketId: true,
              startedAt: true,
              finishedAt: true,
              itemsCollected: true,
              itemsUpdated: true,
              status: true,
              sourceMode: true,
            },
          });
          send("runs", runs);
        } catch (e: any) {
          send("error", { message: e?.message ?? "runs fetch failed" });
        }
      }, 10000);

      // Heartbeat every 30s to keep connection alive through proxies
      const heartbeatInterval = setInterval(() => {
        send("heartbeat", { ts: Date.now() });
      }, 30000);
      void heartbeatInterval; // keep ref to avoid GC

      // Cleanup hook — controller.close() triggers this
      // (Next.js will call cancel when client disconnects)
      void {
        cancel: () => {
          closed = true;
          clearInterval(statusInterval);
          clearInterval(runsInterval);
          clearInterval(heartbeatInterval);
        },
      };
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",  // disable nginx buffering
    },
  });
}
