/** What happened. Drives both the message and the default severity. */
export enum AlertType {
  /** Competitor price fell by more than the configured threshold. */
  PriceDrop = 'price_drop',
  /** Competitor price rose by more than the configured threshold. */
  PriceRise = 'price_rise',
  /** Competitor is now cheaper than our configured target price. */
  Undercut = 'undercut',
  /** Competitor price is the lowest ever recorded for this product. */
  AllTimeLow = 'all_time_low',
  /** Listing reported the item as out of stock. */
  OutOfStock = 'out_of_stock',
  /** Listing failed repeatedly and was deactivated. */
  ScrapeFailing = 'scrape_failing',
}

export enum AlertSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

/** Delivery state of an alert towards the outbound channels. */
export enum AlertDeliveryStatus {
  Pending = 'pending',
  Delivered = 'delivered',
  Failed = 'failed',
  /** No channel configured — the alert is stored but was never sent. */
  Skipped = 'skipped',
}
