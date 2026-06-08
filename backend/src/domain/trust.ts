/**
 * The trust model. Three contexts an agent operates under, ordered by how much
 * of the owner relationship they may touch:
 *
 *   owner     full trust    — may read/write owner_memory, full bio, owner history
 *   stranger  limited trust — public identity only; owner-private data is never loaded
 *   public    broadcast     — no conversation; outbound diary/log/status to everyone
 *
 * The guarantee this codebase makes is *structural*, not prompt-based: the
 * context assembler simply never loads owner-private rows for a non-owner
 * request. Even a fully jailbroken model cannot leak data it was never given.
 */
export type TrustLevel = 'owner' | 'stranger' | 'public';

export function isOwner(t: TrustLevel): boolean {
  return t === 'owner';
}
