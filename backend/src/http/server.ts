import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Container } from '../container.js';
import type { Agent, Skill } from '../domain/types.js';
import { resolveRequester, requireOwner } from './auth.js';
import { registerRest } from './rest.js';
import { log } from '../logger.js';

// Repo root (where the provided index.html + fonts/ live): backend/src/http -> ../../..
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Public projection of an agent — never includes bio, api_key, or owner_token. */
function publicAgent(a: Agent, skills: Skill[]) {
  return {
    id: a.id,
    name: a.name,
    visitor_bio: a.visitor_bio,
    status: a.status,
    accent_color: a.accent_color,
    avatar_url: a.avatar_url,
    showcase_emoji: a.showcase_emoji,
    skills: skills.map((s) => ({ category: s.category, description: s.description })),
  };
}

const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createServer(c: Container): Express {
  const app = express();
  app.use(express.json());

  // Permissive CORS so the static frontend (file:// or another origin) can call us.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Visitor-Id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // PostgREST-compatible read layer + the provided dashboard, so the UI can run
  // against this backend with no Supabase project. Open /app/index.html.
  registerRest(app, c.db);
  app.use('/app', express.static(repoRoot));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, backend: c.db.backend, llm: c.llm.name });
  });

  // A human-friendly index so hitting the root in a browser isn't a dead end.
  // (This is a JSON API; the browsable GETs are listed below.)
  app.get('/', (_req, res) => {
    res.json({
      service: 'agent-village-backend',
      note: 'This is a JSON API, not a website. Try the GET endpoints below in your browser.',
      browsable: ['/healthz', '/agents', '/agents/Luna', '/agents/Luna/events', '/feed'],
      docs: 'See backend/README.md and backend/ARCHITECTURE.md',
    });
  });

  // --- lifecycle ----------------------------------------------------------
  const createAgentSchema = z.object({
    name: z.string().min(1).max(40),
    bio: z.string().min(1).max(600),
    visitorBio: z.string().max(300).optional(),
    status: z.string().max(120).optional(),
    accentColor: z.string().max(16).optional(),
    showcaseEmoji: z.string().max(8).optional(),
    skills: z.array(z.string().max(160)).max(10).optional(),
    activeHoursStart: z.number().int().min(0).max(23).optional(),
    activeHoursEnd: z.number().int().min(0).max(23).optional(),
  });

  app.post(
    '/agents',
    asyncH(async (req, res) => {
      const parsed = createAgentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { agent, ownerToken } = await c.services.bootstrap.createAgent(parsed.data);
      const skills = await c.repos.agents.skills(agent.id);
      // ownerToken is the owner credential — returned ONCE at creation.
      res.status(201).json({ agent: publicAgent(agent, skills), ownerToken });
    }),
  );

  app.get(
    '/agents',
    asyncH(async (_req, res) => {
      const agents = await c.repos.agents.list();
      const out = await Promise.all(
        agents.map(async (a) => publicAgent(a, await c.repos.agents.skills(a.id))),
      );
      res.json({ agents: out });
    }),
  );

  app.get(
    '/agents/:id',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      res.json({ agent: publicAgent(agent, await c.repos.agents.skills(agent.id)) });
    }),
  );

  // --- messaging (trust boundary) ----------------------------------------
  const messageSchema = z.object({ message: z.string().min(1).max(2000) });

  app.post(
    '/agents/:id/messages',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      const parsed = messageSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const requester = resolveRequester(req, agent);
      const result = await c.services.conversation.handleMessage(agent, requester, parsed.data.message);
      res.json({
        agent: agent.name,
        trust: requester.trust,
        reply: result.reply,
        memoriesLearned: result.memoriesLearned,
        conversationId: result.conversationId,
      });
    }),
  );

  // Conversation history for the requester's OWN thread. Trust is resolved from
  // the request: an owner token returns the owner thread; otherwise the caller's
  // stranger thread (by X-Visitor-Id). A stranger can never read the owner thread.
  app.get(
    '/agents/:id/conversation',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      const requester = resolveRequester(req, agent);
      const messages = await c.repos.conversations.messagesFor(agent.id, requester.trust, requester.participantId);
      res.json({ agent: agent.name, trust: requester.trust, messages });
    }),
  );

  // Owner-only: read the agent's private memory about its owner.
  app.get(
    '/agents/:id/memory',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      if (!requireOwner(req, agent)) {
        return res.status(403).json({ error: 'owner authentication required' });
      }
      const memories = await c.repos.memory.ownerMemories(agent.id);
      res.json({ agent: agent.name, memories });
    }),
  );

  // --- proactive + observability -----------------------------------------
  // Force a proactive evaluation now (demo / ops). Returns the decision + why.
  app.post(
    '/agents/:id/tick',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      const force = req.query.force === '1' || req.query.force === 'true';
      const decision = await c.services.proactive.tick(agent, { force });
      res.json({ agent: agent.name, decision });
    }),
  );

  // Behavior/observability trace for an agent.
  app.get(
    '/agents/:id/events',
    asyncH(async (req, res) => {
      const agent = await c.repos.agents.byIdOrName(req.params.id!);
      if (!agent) return res.status(404).json({ error: 'agent not found' });
      const events = await c.repos.events.recent(agent.id, 50);
      res.json({ agent: agent.name, events });
    }),
  );

  // --- public feed --------------------------------------------------------
  app.get(
    '/feed',
    asyncH(async (_req, res) => {
      res.json({ feed: await c.repos.feed.feed(60) });
    }),
  );

  // --- frontend compatibility --------------------------------------------
  // The provided dashboard calls BACKEND_URL/chat/token for its (optional) DM
  // tab. We return a stub so the UI doesn't error; real Stream wiring is out of
  // scope per the brief (messaging is implemented as the API endpoints above).
  app.post('/chat/token', (req, res) => {
    res.json({ token: 'stub-token', note: 'DM is implemented via POST /agents/:id/messages' });
  });

  // --- error handler ------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('http.error', { error: String(err) });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
