/** Outcome of the most recent scrape attempt for a tracked product. */
export enum ScrapeStatus {
  /** Never scraped yet. */
  Pending = 'pending',
  /** Last run returned a usable price. */
  Success = 'success',
  /** Last run failed (network error, parse failure, timeout, ...). */
  Failed = 'failed',
  /** Product is excluded from the scheduled sweep. */
  Skipped = 'skipped',
}
