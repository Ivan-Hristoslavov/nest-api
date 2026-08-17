import { Alert } from '../entities/alert.entity';

/** Extra context the channels render alongside the alert itself. */
export interface AlertContext {
  productName: string;
  productSku: string | null;
  competitorName: string | null;
  competitorUrl: string | null;
  targetPrice: number | null;
}

/** Injection token for the list of configured {@link AlertNotifier}s. */
export const ALERT_NOTIFIERS = Symbol('ALERT_NOTIFIERS');

/**
 * An outbound delivery channel.
 *
 * Channels are registered as a list; each reports whether it is configured, so
 * an unset `ALERT_SLACK_WEBHOOK_URL` disables Slack without any branching at
 * the call site.
 */
export interface AlertNotifier {
  readonly channel: string;
  isConfigured(): boolean;
  send(alert: Alert, context: AlertContext): Promise<void>;
}
