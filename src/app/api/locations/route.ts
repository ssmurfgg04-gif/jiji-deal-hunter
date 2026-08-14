import { NextResponse } from "next/server";
import { KNOWN_LOCATIONS } from "@/lib/location";

/**
 * GET /api/locations
 *
 * Returns the list of known locations for the buyer-location dropdown.
 * Used by the dashboard's "Distance from" filter.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    count: KNOWN_LOCATIONS.length,
    locations: KNOWN_LOCATIONS,
  });
}
