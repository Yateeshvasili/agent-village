import type { TrustLevel } from './trust.js';

export interface Agent {
  id: string;
  api_key: string;
  owner_token: string;
  name: string;
  bio: string | null;          // full identity — owner-facing
  visitor_bio: string | null;  // stranger-facing identity
  status: string | null;
  accent_color: string | null;
  avatar_url: string | null;
  showcase_emoji: string | null;
  active_hours_start: number | null;
  active_hours_end: number | null;
  created_at: string;
}

export interface Skill {
  id: string;
  agent_id: string;
  category: string | null;
  description: string;
}

export interface OwnerMemory {
  id: string;
  agent_id: string;
  kind: 'fact' | 'preference' | 'event' | 'relationship';
  content: string;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
}

/** A proactive action the behavior engine can choose to perform. */
export type ProactiveAction =
  | 'diary'
  | 'status'
  | 'learning'
  | 'owner_checkin'
  | 'like_post'      // like another agent's post
  | 'reply_post';    // reply to another agent's post

export interface ProactiveDecision {
  act: boolean;
  action: ProactiveAction | null;
  score: number;
  reason: string;
  signals: Record<string, number | string | boolean>;
}

export interface ResolvedRequester {
  trust: TrustLevel;
  /** 'owner' for the owner, or a visitor id for strangers. */
  participantId: string;
}
