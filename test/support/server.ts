import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { freshEnv } from './boot.js';
import { makeEpub } from './epub.js';
import { type Scenario, fakeQuery, pipelineScenario } from './fake-sdk.js';

export interface TestServer {
  base: string;
  dataDir: string;
  server: http.Server;
  /** fetch with this client's cookie jar; `json` sends a JSON body; browsers' Origin header is sent on writes. */
  request(p: string, init?: RequestInit & { json?: unknown; anonymous?: boolean }): Promise<Response>;
  login(): Promise<void>;
  /** This client's session cookie ("name=value"), or ''. */
  cookie(): string;
  setCookie(c: string): void;
  /** Create a project from a generated EPUB and return its metadata. */
  createProject(fields?: Record<string, string>): Promise<{ id: string; [k: string]: unknown }>;
  ws(query: string, anonymous?: boolean): Promise<{ socket: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> }>;
  close(): Promise<void>;
}

/** Boot the real app on a free port, with the scripted SDK and the fake Claude binary. */
export async function startServer(opts: { scenario?: Scenario; env?: Record<string, string | undefined> } = {}): Promise<TestServer> {
  const dataDir = freshEnv(opts.env);
  const { sdk } = await import('../../src/sdk.js');
  sdk.query = fakeQuery(opts.scenario ?? pipelineScenario, () => ({ email: 'reader@example.com', subscriptionType: 'max' }));
  const { createServer } = await import('../../src/app.js');
  const server = createServer();
  // All interfaces, and addressed as localhost: passkeys need a host name (an IP is not a valid RP ID).
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  let cookie = '';

  const request: TestServer['request'] = async (p, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie && !init.anonymous && !headers.has('cookie')) headers.set('cookie', cookie);
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', base);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await fetch(base + p, { ...init, headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set && !init.anonymous) cookie = /Max-Age=0\b/.test(set) ? '' : set.split(';')[0];
    return res;
  };

  return {
    base,
    dataDir,
    server,
    request,
    async login() {
      const r = await request('/api/auth/password', { method: 'POST', json: { password: 'test-password' } });
      if (!r.ok) throw new Error(`login failed: ${r.status}`);
    },
    cookie: () => cookie,
    setCookie: (c) => {
      cookie = c;
    },
    async createProject(fields = {}) {
      const form = new FormData();
      const file = makeEpub(path.join(dataDir, `upload-${Date.now()}.epub`));
      form.append('epub', new Blob([new Uint8Array(fs.readFileSync(file))]), 'My Book.epub');
      form.append('targetLanguage', fields.targetLanguage ?? 'Spanish');
      for (const [k, v] of Object.entries(fields)) if (k !== 'targetLanguage') form.append(k, v);
      const r = await request('/api/projects', { method: 'POST', body: form });
      if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async ws(query, anonymous = false) {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?${query}`, { headers: anonymous ? {} : { cookie }, origin: base });
      const messages: Record<string, unknown>[] = [];
      socket.on('message', (d) => messages.push(JSON.parse(d.toString())));
      const closed = new Promise<number>((r) => socket.on('close', (code) => r(code)));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
        socket.once('close', () => resolve());
      });
      return { socket, messages, closed };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
