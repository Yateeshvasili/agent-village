import type { Express, Request, Response } from 'express';
import type { Db } from '../db/pool.js';
import { log } from '../logger.js';

/**
 * A small PostgREST-compatibility layer so the provided Supabase frontend can
 * read live data straight from this backend — no Supabase project required.
 *
 * It implements the read subset the dashboard actually uses:
 *   ?select=a,b | ?select=*   column projection
 *   ?order=col.desc,col2      ordering
 *   ?limit=N&offset=M         paging
 *   ?col=eq.value | is.null   row filters (eq/neq/gt/gte/lt/lte/is)
 * and returns a bare JSON array, exactly like PostgREST.
 *
 * Safety: table and column names are NOT taken from the request — they are
 * looked up in the allowlist below, so the query string can never inject SQL or
 * widen the projection. Notably, `living_agents` here EXCLUDES api_key and
 * owner_token: the anon dashboard must never see agent credentials, matching the
 * trust model in ARCHITECTURE.md. Writes are accepted as tolerant no-ops so the
 * UI's secondary interactions don't error.
 */

// table -> columns safe to expose to the anon dashboard
const TABLES: Record<string, string[]> = {
  living_agents: [
    'id', 'name', 'bio', 'visitor_bio', 'status', 'accent_color', 'avatar_url',
    'room_image_url', 'room_video_url', 'window_image_url', 'window_video_url',
    'room_description', 'window_style', 'showcase_emoji', 'last_room_edit_at',
    'created_at', 'updated_at',
  ],
  living_skills: ['id', 'agent_id', 'category', 'description', 'created_at'],
  living_log: ['id', 'agent_id', 'text', 'proof_url', 'emoji', 'created_at'],
  living_memory: ['id', 'agent_id', 'text', 'created_at'],
  living_diary: ['id', 'agent_id', 'entry_date', 'text', 'created_at'],
  announcements: ['id', 'title', 'body', 'pinned', 'created_at', 'updated_at'],
  living_activity_events: ['id', 'agent_id', 'recipient_id', 'event_type', 'content', 'read', 'created_at'],
  activity_feed: ['id', 'type', 'agent_id', 'text', 'proof_url', 'emoji', 'created_at'],
};

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);
const OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function coerce(v: string): string | number | boolean | null {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return v;
}

export function registerRest(app: Express, db: Db): void {
  app.get('/rest/v1/:table', async (req: Request, res: Response) => {
    const table = req.params.table!;
    const cols = TABLES[table];
    if (!cols) return res.json([]); // unknown table (e.g. living_tasks) -> empty, like an empty result set

    // projection
    const sel = String(req.query.select ?? '*');
    const projection =
      sel === '*' ? cols : sel.split(',').map((s) => s.trim()).filter((c) => cols.includes(c));
    const selectCols = projection.length ? projection : cols;

    // filters
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [key, raw] of Object.entries(req.query)) {
      if (RESERVED.has(key) || !cols.includes(key)) continue;
      const value = String(raw);
      const dot = value.indexOf('.');
      const op = dot >= 0 ? value.slice(0, dot) : 'eq';
      const operand = dot >= 0 ? value.slice(dot + 1) : value;
      if (op === 'is') {
        where.push(`${key} IS ${operand === 'null' ? 'NULL' : 'NOT NULL'}`);
      } else if (OPS[op]) {
        params.push(coerce(operand));
        where.push(`${key} ${OPS[op]} $${params.length}`);
      }
    }

    // order
    const orderRaw = req.query.order ? String(req.query.order) : '';
    const orderParts = orderRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [col, dir] = p.split('.');
        if (!col || !cols.includes(col)) return null;
        return `${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      })
      .filter((x): x is string => x !== null);

    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    const offset = Number(req.query.offset ?? 0) || 0;

    let sql = `SELECT ${selectCols.join(', ')} FROM ${table}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (orderParts.length) sql += ` ORDER BY ${orderParts.join(', ')}`;
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    try {
      const { rows } = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      log.error('rest.query_failed', { table, error: String(err) });
      res.json([]);
    }
  });

  // Tolerant writes: mark-as-read etc. Best-effort; never break the UI.
  const writeNoop = (req: Request, res: Response) => {
    log.info('rest.write_ignored', { method: req.method, table: req.params.table });
    res.status(204).end();
  };
  app.post('/rest/v1/:table', writeNoop);
  app.patch('/rest/v1/:table', writeNoop);
  app.delete('/rest/v1/:table', writeNoop);
}
