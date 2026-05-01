import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { quotaUsage } from "@/db/schema";
import { DAILY_QUOTA, pacificDate, type QuotaAccounter } from "./quota";

export class DbQuotaAccounter implements QuotaAccounter {
  async spend(units: number): Promise<void> {
    if (units <= 0) return;
    const date = pacificDate();
    await db
      .insert(quotaUsage)
      .values({ date, unitsUsed: units })
      .onConflictDoUpdate({
        target: quotaUsage.date,
        set: { unitsUsed: drizzleSql`${quotaUsage.unitsUsed} + ${units}` },
      });
  }

  async remaining(): Promise<number> {
    const date = pacificDate();
    const row = await db.query.quotaUsage.findFirst({
      where: (t, { eq }) => eq(t.date, date),
    });
    const used = row?.unitsUsed ?? 0;
    return Math.max(0, DAILY_QUOTA - used);
  }
}
