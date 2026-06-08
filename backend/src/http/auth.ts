import type { Request } from 'express';
import type { Agent, ResolvedRequester } from '../domain/types.js';
import type { TrustLevel } from '../domain/trust.js';

/**
 * Resolve the trust context of an inbound request against a specific agent.
 *
 * The rule: you are the OWNER of this agent iff you present its owner_token via
 * `Authorization: Bearer <token>`. Everyone else is a STRANGER, identified for
 * conversation-threading purposes by `X-Visitor-Id` (or a generated anon id).
 *
 * Trust is always resolved per-agent: holding Luna's owner token makes you a
 * stranger to Bolt. This is the only place trust is decided.
 */
export function resolveRequester(req: Request, agent: Agent): ResolvedRequester {
  const token = bearer(req);
  if (token && token === agent.owner_token) {
    return { trust: 'owner', participantId: 'owner' };
  }
  const visitorId = (req.header('x-visitor-id') || '').trim() || 'anon';
  return { trust: 'stranger', participantId: visitorId };
}

/** For routes that must be the owner (e.g. reading private memory). */
export function requireOwner(req: Request, agent: Agent): TrustLevel | null {
  const token = bearer(req);
  return token && token === agent.owner_token ? 'owner' : null;
}

function bearer(req: Request): string | null {
  const h = req.header('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}
