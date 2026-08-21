interface QuotaRecord {
  day: string;
  used: number;
}

export class DailyQuotaLimiter {
  private readonly records = new Map<string, QuotaRecord>();

  consume(provider: string, limit: number, now: Date = new Date()): void {
    if (!Number.isFinite(limit) || limit < 1) return;
    const day = now.toISOString().slice(0, 10);
    const current = this.records.get(provider);
    const record = current?.day === day ? current : { day, used: 0 };
    if (record.used >= limit) {
      throw new Error(`${provider} 已达到今日 ${limit} 次的本地调用上限。`);
    }
    record.used += 1;
    this.records.set(provider, record);
  }

  usage(provider: string, now: Date = new Date()): number {
    const record = this.records.get(provider);
    return record?.day === now.toISOString().slice(0, 10) ? record.used : 0;
  }
}

export const externalApiQuota = new DailyQuotaLimiter();
