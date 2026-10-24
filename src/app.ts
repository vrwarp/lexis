import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'node:module';
import { Auth, originAllowed, securityHeaders } from './auth/http.js';
import { ClaudeLogin, LoginError, envCredentialShadowsLogin, probeAuth, readAccount } from './claude.js';
import { CREDENTIAL_LABEL, detectCredential, ensureDirs, env } from './env.js';
import { coverMime, replaceCover } from './epub.js';
import { sessionFor } from './orchestrator.js';
import { createProject, getProject, listProjects, type Project } from './projects.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

/** A file inside a package that doesn't export it: find the package root from its entry point. */
function browserBundle(pkg: string, rel: string): string {
  let dir = path.dirname(createRequire(import.meta.url).resolve(pkg));
  // Sub-folders may hold stub package.json files ({"type": "commonjs"}): look for the one naming the package.
  const named = (d: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === pkg;
    } catch {
      return false;
    }
  };
  while (!named(dir)) {
    if (path.dirname(dir) === dir) throw new Error(`cannot find the root of ${pkg}`);
    dir = path.dirname(dir);
  }
  return path.join(dir, rel);
}

/**
 * The whole web app: static UI, sign-in (password, then passkeys), project
 * API, Claude link and the live event WebSocket. `server.ts` listens; tests
 * mount it on any port.
 */
export function createServer(): http.Server {
  ensureDirs();

  const auth = new Auth();
  const webauthnBrowser = browserBundle('@simplewebauthn/browser', 'dist/bundle/index.umd.min.js');

  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Cross-site writes are refused outright; SameSite=Strict cookies already keep them signed out.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.get('origin'), req)) {
      res.status(403).json({ error: 'cross-site request refused' });
      return;
    }
    next();
  });
  app.use(express.json());
  app.use(express.static(path.join(env.root, 'public')));
  app.get('/vendor/webauthn.js', (_req, res) => res.sendFile(webauthnBrowser));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // ---------- sign-in ----------

  app.use('/api/auth', auth.router());
  // Everything else under /api needs a live session.
  app.use('/api', auth.require);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

  /** Refuse to start agent work before Claude Code has any credential to run it on. */
  function requireClaude(res: express.Response): boolean {
    if (detectCredential() !== 'none') return true;
    res.status(409).json({ error: 'Claude is not linked yet. Sign in with your Claude subscription under “Claude” first.' });
    return false;
  }

  function requireProject(req: express.Request, res: express.Response): Project | undefined {
    const project = getProject(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return undefined;
    }
    return project;
  }

  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
    (req: express.Request, res: express.Response) => {
      Promise.resolve(fn(req, res)).catch((error) => {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: String(error) });
      });
    };

  // ---------- projects ----------

  app.get('/api/projects', (_req, res) => {
    res.json(listProjects().map((p) => p.meta));
  });

  app.post(
    '/api/projects',
    upload.single('epub'),
    wrap(async (req, res) => {
      if (!req.file || !req.file.originalname.toLowerCase().endsWith('.epub')) {
        res.status(400).json({ error: 'an .epub file is required' });
        return;
      }
      const { name, targetLanguage, context } = req.body as Record<string, string>;
      if (!targetLanguage?.trim()) {
        res.status(400).json({ error: 'targetLanguage is required' });
        return;
      }
      const project = createProject({
        name: name?.trim() || req.file.originalname.replace(/\.epub$/i, ''),
        targetLanguage: targetLanguage.trim(),
        context: context?.trim() ?? '',
        epubBuffer: req.file.buffer,
        epubFilename: req.file.originalname,
      });
      res.json(project.meta);
    }),
  );

  app.get(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      res.json({
        ...project.meta,
        versions: await listVersions(project),
        awaitingReview: sessionFor(project).awaitingReview,
      });
    }),
  );

  app.get('/api/projects/:id/events', (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const after = Number(req.query.after ?? 0);
    res.json(project.readEvents(after));
  });

  // ---------- orchestration ----------

  app.post(
    '/api/projects/:id/start',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      if (!requireClaude(res)) return;
      const session = sessionFor(project);
      session.send(
        `Begin the translation of source.epub into ${project.meta.targetLanguage}. ` +
          (project.meta.context ? `User context: ${project.meta.context}. ` : '') +
          `Run the full pipeline from Preparation onward. If the workspace already contains partial pipeline output (original/, notes/, draft/, final/), assess what is already done and continue from there instead of redoing completed work.`,
      );
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/projects/:id/message',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      if (!requireClaude(res)) return;
      const text = String((req.body as { text?: string }).text ?? '').trim();
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      sessionFor(project).send(text);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/projects/:id/review',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const { decision, instructions } = req.body as { decision?: string; instructions?: string };
      if (decision !== 'approve' && decision !== 'revise') {
        res.status(400).json({ error: "decision must be 'approve' or 'revise'" });
        return;
      }
      const resolved = sessionFor(project).resolveReview(decision, instructions);
      if (!resolved) {
        res.status(409).json({ error: 'no review is pending' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/projects/:id/interrupt',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      await sessionFor(project).interrupt();
      res.json({ ok: true });
    }),
  );

  // ---------- versions ----------

  app.get(
    '/api/projects/:id/versions',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      res.json(await listVersions(project));
    }),
  );

  app.post(
    '/api/projects/:id/versions',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const label = String((req.body as { label?: string }).label ?? 'manual snapshot');
      const version = await saveVersion(project, label);
      res.json(version ?? { unchanged: true });
    }),
  );

  app.post(
    '/api/projects/:id/versions/:vid/revert',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const known = (await listVersions(project)).some((v) => v.id.startsWith(String(req.params.vid)));
      if (!known || !req.params.vid) {
        res.status(404).json({ error: 'unknown version' });
        return;
      }
      const version = await revertToVersion(project, String(req.params.vid));
      // Keep the orchestrator's mental model in sync if a session is live.
      const session = sessionFor(project);
      if (session.running) {
        session.send(
          `[The user reverted the workspace to version ${String(req.params.vid).slice(0, 8)} via the UI. Re-read the workspace state (notes/, draft/, final/) before doing anything else, and adjust your plan to match what actually exists now.]`,
        );
      }
      res.json(version);
    }),
  );

  // ---------- assets (inspection & review) ----------

  /** Resolve a user-supplied relative path safely inside the workspace. */
  function resolveWorkspacePath(project: Project, rel: string): string | null {
    const abs = path.resolve(project.workspace, rel);
    if (abs !== project.workspace && !abs.startsWith(project.workspace + path.sep)) return null;
    if (path.relative(project.workspace, abs).split(path.sep).includes('.git')) return null;
    return abs;
  }

  const TEXT_EXTENSIONS = new Set([
    '.xhtml', '.html', '.htm', '.txt', '.md', '.json', '.css', '.opf', '.ncx', '.xml', '.svg',
  ]);
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

  app.get(
    '/api/projects/:id/files',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const files: { path: string; size: number; mtime: string; kind: string }[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(abs);
          } else {
            const stat = fs.statSync(abs);
            const ext = path.extname(entry.name).toLowerCase();
            files.push({
              path: path.relative(project.workspace, abs),
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              kind: IMAGE_EXTENSIONS.has(ext) ? 'image' : TEXT_EXTENSIONS.has(ext) ? 'text' : 'binary',
            });
          }
        }
      };
      walk(project.workspace);
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      res.json(files);
    }),
  );

  app.get(
    '/api/projects/:id/files/content',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const abs = resolveWorkspacePath(project, String(req.query.path ?? ''));
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.status(404).json({ error: 'file not found' });
        return;
      }
      const size = fs.statSync(abs).size;
      const CAP = 2 * 1024 * 1024;
      const fd = fs.openSync(abs, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(size, CAP));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (buffer.includes(0)) {
          res.status(415).json({ error: 'binary file — use the raw endpoint' });
          return;
        }
        res.json({ path: req.query.path, content: buffer.toString('utf8'), truncated: size > CAP, size });
      } finally {
        fs.closeSync(fd);
      }
    }),
  );

  app.get(
    '/api/projects/:id/files/raw',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      const abs = resolveWorkspacePath(project, String(req.query.path ?? ''));
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.status(404).json({ error: 'file not found' });
        return;
      }
      res.sendFile(abs);
    }),
  );

  app.post(
    '/api/projects/:id/files/comment',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      if (!requireClaude(res)) return;
      const { path: filePath, comment, excerpt } = req.body as {
        path?: string;
        comment?: string;
        excerpt?: string;
      };
      if (!filePath || !comment?.trim()) {
        res.status(400).json({ error: 'path and comment are required' });
        return;
      }
      if (!resolveWorkspacePath(project, filePath)) {
        res.status(400).json({ error: 'invalid path' });
        return;
      }
      const quoted = excerpt?.trim()
        ? `\n\nRegarding this passage:\n${excerpt
            .trim()
            .slice(0, 1500)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}`
        : '';
      sessionFor(project).send(
        `[User comment on asset \`${filePath}\`]${quoted}\n\n${comment.trim()}`,
      );
      res.json({ ok: true });
    }),
  );

  // ---------- cover & packaging ----------

  app.post(
    '/api/projects/:id/cover',
    upload.single('cover'),
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      if (!req.file || !coverMime(req.file.originalname)) {
        res.status(400).json({ error: 'a jpg/png/gif/webp/svg image is required' });
        return;
      }
      // Remove older overrides so the packager sees exactly one.
      for (const f of fs.readdirSync(project.workspace)) {
        if (f.startsWith('cover_override.')) fs.rmSync(path.join(project.workspace, f));
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      const dest = `cover_override${ext}`;
      fs.writeFileSync(path.join(project.workspace, dest), req.file.buffer);
      project.meta.coverFilename = dest;
      project.save();
      project.emit('status', 'user', {
        status: project.meta.status,
        detail: `Custom cover uploaded (${dest})`,
      });
      res.json({ ok: true, coverFilename: dest });
    }),
  );

  app.post(
    '/api/projects/:id/repackage',
    wrap(async (req, res) => {
      const project = requireProject(req, res);
      if (!project) return;
      if (!project.meta.outputPath || !project.meta.coverFilename) {
        res.status(400).json({ error: 'requires a completed epub and an uploaded cover' });
        return;
      }
      const epub = path.join(project.workspace, project.meta.outputPath);
      const cover = path.join(project.workspace, project.meta.coverFilename);
      await replaceCover(epub, cover);
      await saveVersion(project, 'repackaged with custom cover');
      project.emit('progress', 'orchestrator', {
        phase: 'packaging',
        state: 'completed',
        detail: 'Repackaged with custom cover (deterministic, no agent involved)',
      });
      res.json({ ok: true });
    }),
  );

  app.get('/api/projects/:id/download', (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    if (!project.meta.outputPath) {
      res.status(404).json({ error: 'no translated epub yet' });
      return;
    }
    const file = path.join(project.workspace, project.meta.outputPath);
    res.download(file, `${project.meta.name} (${project.meta.targetLanguage}).epub`);
  });

  // ---------- Claude link: sign the container in from the browser ----------

  const claudeLogin = new ClaudeLogin();
  const loginGuard =
    (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        if (e instanceof LoginError) res.status(e.status).json({ error: e.message });
        else {
          console.error(e);
          res.status(500).json({ error: String(e) });
        }
      }
    };
  const bodyStr = (req: express.Request, key: string, max: number) => {
    const v = (req.body as Record<string, unknown> | undefined)?.[key];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };

  app.get(
    '/api/claude',
    loginGuard(async (req) => {
      const credential = detectCredential();
      return {
        credential,
        credentialLabel: CREDENTIAL_LABEL[credential],
        shadowedByEnv: envCredentialShadowsLogin(),
        hasLoginFile: fs.existsSync(path.join(env.claudeConfigDir, '.credentials.json')),
        auth: credential === 'none' ? 'needs_login' : await probeAuth(),
        inProgress: claudeLogin.inProgress,
        models: env.models,
        effort: env.effort,
        account: req.query.account === '1' && credential !== 'none' ? await readAccount() : undefined,
      };
    }),
  );
  app.post('/api/claude/login/start', loginGuard(() => claudeLogin.start()));
  app.post(
    '/api/claude/login/code',
    loginGuard((req) => claudeLogin.submit(bodyStr(req, 'id', 100), bodyStr(req, 'code', 2000))),
  );
  app.post(
    '/api/claude/login/cancel',
    loginGuard(async () => (claudeLogin.cancel(), { ok: true })),
  );
  app.post(
    '/api/claude/logout',
    loginGuard(async () => (await claudeLogin.signOut(), { ok: true })),
  );

  // ---------- websocket ----------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    if (!originAllowed(req.headers.origin, req)) {
      ws.close(4003, 'cross-site connection refused');
      return;
    }
    if (!auth.session(req.headers.cookie)) {
      ws.close(4001, 'sign-in required');
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    const project = getProject(url.searchParams.get('project') ?? '');
    if (!project) {
      ws.close(4004, 'unknown project');
      return;
    }
    const after = Number(url.searchParams.get('after') ?? 0);
    for (const event of project.readEvents(after)) {
      ws.send(JSON.stringify(event));
    }
    const unsubscribe = project.subscribe((event) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on('close', unsubscribe);
  });

  return server;
}
