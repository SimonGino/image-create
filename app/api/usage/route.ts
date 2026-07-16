import { count, eq, sql, sum } from "drizzle-orm";

import { db } from "@/db";
import { generations } from "@/db/schema";

// better-sqlite3 (via @/db) needs the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // aggregates change as generations are recorded

/**
 * Cumulative usage aggregates over successful generations (SPEC §6).
 * `cost_usd` (actual, the statistics source of truth) summed per total /
 * provider / model / month. SUM over an empty set is NULL → coerced to 0.
 * costUsd is a REAL column; drizzle types SUM(...) as string | null, so the
 * value is normalised through Number(...) and rounded to $0.001 precision.
 */

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const toCost = (v: string | number | null | undefined): number => round3(Number(v ?? 0));

export function GET(): Response {
  const successful = eq(generations.status, "success");
  // createdAt is a unix timestamp (seconds); bucket by calendar month.
  const monthExpr = sql<string>`strftime('%Y-%m', datetime(${generations.createdAt}, 'unixepoch'))`;

  const totalRow = db
    .select({ costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .get();

  const byProvider = db
    .select({
      providerId: generations.providerId,
      costUsd: sum(generations.costUsd),
      count: count(),
    })
    .from(generations)
    .where(successful)
    .groupBy(generations.providerId)
    .all();

  const byModel = db
    .select({
      modelId: generations.modelId,
      costUsd: sum(generations.costUsd),
      count: count(),
    })
    .from(generations)
    .where(successful)
    .groupBy(generations.modelId)
    .all();

  const byMonth = db
    .select({ month: monthExpr, costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .groupBy(monthExpr)
    .orderBy(monthExpr)
    .all();

  return Response.json({
    total: {
      costUsd: toCost(totalRow?.costUsd),
      count: totalRow?.count ?? 0,
    },
    byProvider: byProvider.map((r) => ({
      providerId: r.providerId,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
    byModel: byModel.map((r) => ({
      modelId: r.modelId,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
    byMonth: byMonth.map((r) => ({
      month: r.month,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
  });
}
