import { User } from '../billing/entities/user.entity';

/**
 * How the guard asks "who holds this session".
 *
 * An interface rather than the service itself, because the guard is declared
 * in `common` and the sessions live in `auth`, which imports billing, which
 * the guard already depends on. Depending on the concrete class would close
 * that loop; depending on a shape does not.
 */
export interface SessionResolver {
  resolveSession(token: string): Promise<User | null>;
}

export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');

/** `Authorization: Bearer <token>` → the token. */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
