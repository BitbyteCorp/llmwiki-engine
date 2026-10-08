import { Injectable } from '@nestjs/common';
import { UsageRepository, type UsageEntry, type UsageRow } from './usage.repository.js';

@Injectable()
export class UsageService {
  constructor(private readonly repository: UsageRepository) {}

  /** Record one actual provider response, never accumulated checkpoint totals. */
  record(entry: UsageEntry): void {
    this.repository.record(entry);
  }

  aggregate(days = 30): { days: number; rows: UsageRow[] } {
    return { days, rows: this.repository.aggregate(days) };
  }
}
