import fs from 'node:fs';
import path from 'node:path';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryContext, QueryFn, QueryParams } from '../../src/sdk.js';

/**
 * A stand-in for the Agent SDK with no Claude behind it.
 *
 * Three kinds of query come through the app's one door (src/sdk.ts):
 * - an engine step: a string prompt and the agent's prompt as the system
 *   prompt. The fake works out which agent and mode it is, writes the files
 *   that agent would write (or misbehaves as scripted), and ends with a
 *   result carrying usage;
 * - the assistant: a streaming prompt with the lexis MCP tools, answered by
 *   a chat scenario;
 * - an account probe (readAccount): only initializationResult() is read.
 */

export type Mode = 'metadata' | 'style' | 'charter' | 'summarize' | 'lexicon' | 'glossary' | 'translate' | 'refine' | 'audit' | 'scan' | 'fix' | 'critique' | 'final' | 'verify' | 'verify-fix' | 'package';

export interface Behavior {
  /** What a report should say instead of the clean default. */
  status?: 'INCOMPLETE' | 'ISSUES_FOUND';
  /** How to misbehave. 'nothing' writes no file; 'garbage' writes an unusable one; 'hang' never answers (until aborted). */
  fault?: 'nothing' | 'garbage' | 'error' | 'transient' | 'limit' | 'auth' | 'hang' | 'max-turns' | 'plain-text';
  message?: string;
  resetsAt?: number;
  delayMs?: number;
}

export interface FakeCall {
  agent: string;
  mode: Mode;
  chapter?: string;
  prompt: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
}

/** What the fake did, for assertions. */
export const fake = {
  calls: [] as FakeCall[],
  /** Scripted behaviours, consumed one per call, keyed `mode` or `mode:chapterKey`. */
  script: new Map<string, Behavior[]>(),
  /** Behaviour for every call of a mode (after the script is used up). */
  always: new Map<string, Behavior>(),
  /** Milliseconds each step takes unless scripted; a little, so the scheduler interleaves. */
  delayMs: 8,
  active: 0,
  maxActive: 0,
  reset(): void {
    this.calls = [];
    this.script.clear();
    this.always.clear();
    this.delayMs = 8;
    this.active = 0;
    this.maxActive = 0;
  },
  /** Queue behaviours for a mode (optionally one chapter), used in order. */
  on(key: string, ...behaviors: Behavior[]): void {
    this.script.set(key, [...(this.script.get(key) ?? []), ...behaviors]);
  },
};

const MODE_RULES: [RegExp, Mode][] = [
  [/Write `notes\/metadata\.json`/, 'metadata'],
  [/Write `notes\/style_guide\.md`/, 'style'],
  [/Write `notes\/critique_charter\.md`/, 'charter'],
  [/\.summary\.txt` and `notes\//, 'summarize'],
  [/Write `notes\/[^`]+\.lexicon\.json`/, 'lexicon'],
  [/Merge this section's lexicon/, 'glossary'],
  [/^Translate `original\//m, 'translate'],
  [/The omission audit of/, 'refine'],
  [/^Compare `original\//m, 'audit'],
  [/^Scan the draft/m, 'scan'],
  [/^Fix the stray phrases/m, 'fix'],
  [/^Critique the draft/m, 'critique'],
  [/^Produce the final translation/m, 'final'],
  [/^VERIFY the finalized/m, 'verify'],
  [/^Verification fixes/m, 'verify-fix'],
  [/mirrored `original\/` into `final\/`/, 'package'],
];

export function modeOf(prompt: string): Mode {
  for (const [re, mode] of MODE_RULES) if (re.test(prompt)) return mode;
  throw new Error(`fake sdk: cannot tell what this task is:\n${prompt.slice(0, 300)}`);
}

const chapterOf = (prompt: string) => prompt.match(/key `([^`]+)`/)?.[1];
const pathsOf = (prompt: string, dir: string) => [...prompt.matchAll(new RegExp('`(' + dir + '/[^`]+)`', 'g'))].map((m) => m[1]);
const firstPath = (prompt: string, re: RegExp) => prompt.match(re)?.[1];

/** A "translation": the same XHTML with every text run replaced by target-language text. */
export function fakeTranslate(xhtml: string, marker: string): string {
  return xhtml.replace(/>([^<>]*[A-Za-z][^<>]*)</g, (_m, text: string) => `>${marker} ${text.trim().length}<`);
}

function write(cwd: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), body);
}

/** Do what the real agent would do, in the crudest possible way. */
function act(cwd: string, mode: Mode, prompt: string, b: Behavior): void {
  if (b.fault === 'nothing') return;
  const garbage = b.fault === 'garbage';
  const plain = b.fault === 'plain-text';
  const read = (rel: string) => fs.readFileSync(path.join(cwd, rel), 'utf8');
  switch (mode) {
    case 'metadata': {
      const target = prompt.match(/Translating into: (.+)/)?.[1] ?? 'Spanish';
      write(cwd, 'notes/metadata.json', garbage ? '{"oops": ' : JSON.stringify({ source_language: 'English', target_language: target, target_audience: 'general', linguistic_guidance: 'Keep it natural.', register_guidance: 'Plain.', translationese_watchlist: [] }, null, 2));
      return;
    }
    case 'style':
      write(cwd, 'notes/style_guide.md', garbage ? 'x' : `# Style guide\n\n${'The author writes plainly. '.repeat(20)}`);
      return;
    case 'charter':
      write(cwd, 'notes/critique_charter.md', garbage ? 'x' : `# Charter\n\n${'Judge as a native editor would. '.repeat(20)}`);
      return;
    case 'summarize': {
      const [summary, challenges] = pathsOf(prompt, 'notes');
      write(cwd, summary, garbage ? '' : `Chapter summary: ${'things happen. '.repeat(10)}`);
      write(cwd, challenges, `# Linguistic Challenges\n\n## Challenge 1: Pun\n- **Original Text:** "..."\n`);
      return;
    }
    case 'lexicon': {
      const [lexicon] = pathsOf(prompt, 'notes').filter((p) => p.endsWith('.lexicon.json'));
      write(cwd, lexicon, garbage ? '{"not": "an array"}' : JSON.stringify([{ term: 'world', example_sentence: 'Hello world.', usage_notes: 'the planet', category: 'proper_noun' }], null, 2));
      return;
    }
    case 'glossary': {
      const existing = JSON.parse(read('notes/master_glossary.json')) as unknown[];
      const ch = chapterOf(prompt) ?? '?';
      write(cwd, 'notes/master_glossary.json', garbage ? '[' : JSON.stringify([...existing, { term: `term-${ch}`, translation: `término-${ch}`, example_sentence: '', usage_notes: '', sections: [ch], category: 'proper_noun' }], null, 2));
      return;
    }
    case 'translate':
    case 'refine':
    case 'fix': {
      const source = firstPath(prompt, /`(original\/[^`]+)`/)!;
      const draft = firstPath(prompt, /`(draft\/[^`]+)`/)!;
      const body = mode === 'translate' ? fakeTranslate(read(source), 'ES') : read(draft).replace('</body>', `<p>ES ${mode}</p></body>`);
      write(cwd, draft, plain ? 'Hola mundo (texto plano, sin XHTML)' : body);
      return;
    }
    case 'audit': {
      const report = firstPath(prompt, /`(notes\/[^`]+\.omission_report\.md)`/)!;
      if (garbage) return write(cwd, report, '<scratchpad>1. ok</scratchpad>\nNo status here.');
      write(cwd, report, b.status === 'INCOMPLETE' ? 'STATUS: INCOMPLETE\n\n## Omission 1\n**Original Text Missed:** "a line"\n' : '<scratchpad>\n1. [Source Para 1] aligns with [Draft Para 1]\n</scratchpad>\n\nSTATUS: COMPLETE\n');
      return;
    }
    case 'scan': {
      const report = firstPath(prompt, /`(notes\/[^`]+\.stray_report\.json)`/)!;
      if (garbage) return write(cwd, report, 'not json');
      write(cwd, report, b.status === 'ISSUES_FOUND' ? JSON.stringify({ status: 'ISSUES_FOUND', stray_phrases: [{ original_phrase: 'Hello', draft_location_context: '…', suggested_fix_context: 'Hola' }] }) : '{"status": "CLEAN", "stray_phrases": []}');
      return;
    }
    case 'critique': {
      const critique = firstPath(prompt, /`(critique\/[^`]+\.critique\.md)`/)!;
      write(cwd, critique, garbage ? '' : `# Critique\n\n> original line\n- Suggestion: ${'rephrase it. '.repeat(10)}`);
      return;
    }
    case 'final':
    case 'verify-fix': {
      const draft = firstPath(prompt, /`(draft\/[^`]+)`/);
      const final = firstPath(prompt, /`(final\/[^`]+)`/)!;
      const base = mode === 'final' ? read(draft!) : read(final);
      write(cwd, final, plain ? 'texto plano' : base.replace('</body>', `<p>ES ${mode}</p></body>`));
      return;
    }
    case 'verify': {
      const report = firstPath(prompt, /`(critique\/[^`]+\.final_check\.md)`/)!;
      if (garbage) return write(cwd, report, 'Looks fine to me.');
      write(cwd, report, `# Final check\n\n${b.status === 'ISSUES_FOUND' ? 'One register break remains.\n\nSTATUS: ISSUES_FOUND' : 'All must-fix issues resolved.\n\nSTATUS: PASS'}\n`);
      return;
    }
    case 'package': {
      const opf = firstPath(prompt, /`final\/([^`]+\.opf)`/);
      if (opf && fs.existsSync(path.join(cwd, 'final', opf))) {
        const abs = path.join(cwd, 'final', opf);
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/<dc:language>[^<]*<\/dc:language>/, '<dc:language>es</dc:language>'));
      }
      if (garbage) fs.rmSync(path.join(cwd, 'final', 'mimetype'), { force: true });
      return;
    }
  }
}

function usageFor(model: string, mode: Mode) {
  const heavy = ['translate', 'refine', 'critique', 'final', 'verify', 'verify-fix', 'metadata', 'style', 'charter'].includes(mode);
  const u = { inputTokens: heavy ? 4000 : 1000, outputTokens: heavy ? 1500 : 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: heavy ? 0.05 : 0.01, contextWindow: 1_000_000, maxOutputTokens: 128_000 };
  return { [model]: u };
}

let counter = 0;
const id = (p: string) => `${p}_${++counter}`;

/** The messages one fake step yields. */
async function* stepMessages(params: QueryParams, call: FakeCall, b: Behavior, abort?: AbortSignal): AsyncGenerator<SDKMessage> {
  const model = params.options?.model ?? 'claude-sonnet-5-5';
  const cwd = params.options?.cwd ?? process.cwd();
  yield { type: 'system', subtype: 'init', session_id: id('sess'), model } as unknown as SDKMessage;
  if (b.fault === 'hang') {
    await new Promise<void>((_, reject) => {
      if (abort?.aborted) return reject(new Error('aborted'));
      abort?.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    });
  }
  const delay = b.delayMs ?? fake.delayMs;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, delay);
    abort?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('This operation was aborted'));
      },
      { once: true },
    );
  });
  if (b.fault === 'auth') {
    yield { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: { id: id('msg'), model, role: 'assistant', content: [] } } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: delay, num_turns: 1, errors: [b.message ?? 'Not logged in'], modelUsage: {}, total_cost_usd: 0 } as unknown as SDKMessage;
    return;
  }
  if (b.fault === 'limit') {
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: b.resetsAt ?? Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: delay, num_turns: 1, errors: [b.message ?? "You've hit your usage limit"], modelUsage: {}, total_cost_usd: 0 } as unknown as SDKMessage;
    return;
  }
  if (b.fault === 'transient') {
    yield { type: 'assistant', error: 'overloaded', parent_tool_use_id: null, message: { id: id('msg'), model, role: 'assistant', content: [] } } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: delay, num_turns: 1, errors: [b.message ?? 'API Error: 529 overloaded'], modelUsage: {}, total_cost_usd: 0 } as unknown as SDKMessage;
    return;
  }
  if (b.fault === 'error') {
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: delay, num_turns: 1, errors: [b.message ?? 'something broke'], modelUsage: usageFor(model, call.mode), total_cost_usd: 0.01 } as unknown as SDKMessage;
    return;
  }
  // What the agent says and does, for the feed.
  yield {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: id('msg'), model, role: 'assistant', content: [{ type: 'tool_use', id: id('toolu'), name: 'Read', input: { file_path: 'notes/contents.json' } }], usage: { input_tokens: 1000, output_tokens: 50 } },
  } as unknown as SDKMessage;
  act(cwd, call.mode, call.prompt, b);
  yield {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: id('msg'), model, role: 'assistant', content: [{ type: 'text', text: `Done: ${call.mode}${call.chapter ? ` for ${call.chapter}` : ''}.` }], usage: { input_tokens: 500, output_tokens: 150 } },
  } as unknown as SDKMessage;
  if (b.fault === 'max-turns') {
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: delay, num_turns: 80, errors: [], modelUsage: usageFor(model, call.mode), total_cost_usd: 0.05 } as unknown as SDKMessage;
    return;
  }
  yield { type: 'result', subtype: 'success', is_error: false, duration_ms: delay, num_turns: 3, result: `Done: ${call.mode}.`, modelUsage: usageFor(model, call.mode), total_cost_usd: 0.05 } as unknown as SDKMessage;
}

function behaviorFor(mode: Mode, chapter?: string): Behavior {
  for (const key of [chapter ? `${mode}:${chapter}` : '', mode]) {
    if (!key) continue;
    const queue = fake.script.get(key);
    if (queue?.length) return queue.shift()!;
  }
  for (const key of [chapter ? `${mode}:${chapter}` : '', mode]) {
    if (key && fake.always.has(key)) return fake.always.get(key)!;
  }
  return {};
}

/** Which agent a step's system prompt belongs to, by comparing with the loaded definitions. */
async function agentOf(systemPrompt: unknown): Promise<string> {
  const { loadAgents } = await import('../../src/agents.js');
  const text = typeof systemPrompt === 'string' ? systemPrompt : (systemPrompt as { prompt?: string })?.prompt;
  for (const [name, def] of Object.entries(loadAgents())) if (def.prompt === text) return name;
  return 'unknown';
}

function trackedStep(params: QueryParams): Query {
  const prompt = params.prompt as string;
  const mode = modeOf(prompt);
  const chapter = chapterOf(prompt);
  const call: FakeCall = { agent: '?', mode, chapter, prompt, model: params.options?.model, startedAt: Date.now() };
  fake.calls.push(call);
  const behavior = behaviorFor(mode, chapter);
  const abort = params.options?.abortController?.signal;
  let inner: AsyncGenerator<SDKMessage> | null = null;
  const iterator = {
    async next(): Promise<IteratorResult<SDKMessage>> {
      if (!inner) {
        call.agent = await agentOf(params.options?.systemPrompt);
        fake.active++;
        fake.maxActive = Math.max(fake.maxActive, fake.active);
        inner = stepMessages(params, call, behavior, abort);
      }
      try {
        const r = await inner.next();
        if (r.done) finish();
        return r;
      } catch (e) {
        finish();
        throw e;
      }
    },
    async return() {
      finish();
      return { value: undefined, done: true as const };
    },
    async throw(e: unknown) {
      finish();
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt() {},
    async initializationResult() {
      return {};
    },
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    fake.active--;
    call.endedAt = Date.now();
  };
  return iterator as unknown as Query;
}

// ---------- the assistant ----------

export interface ChatScript {
  /** The next user message the app pushed into the session, or null once the session closes. */
  next(): Promise<string | null>;
  emit(message: { readonly type: string }): void;
  tool(name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[] }>;
}
export type ChatScenario = (s: ChatScript) => Promise<void>;

export const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId }) as const;
export function say(text: string, model = 'claude-sonnet-5-5') {
  return { type: 'assistant', parent_tool_use_id: null, message: { id: id('msg'), model, role: 'assistant', content: [{ type: 'text', text }] } } as const;
}
export function result(cost = 0.01) {
  return { type: 'result', subtype: 'success', is_error: false, duration_ms: 50, num_turns: 1, result: 'ok', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost, webSearchRequests: 0, contextWindow: 1_000_000 } }, total_cost_usd: cost } as const;
}

/**
 * The default chat: acknowledge each message; a few phrases drive the engine
 * through the lexis tools so tests can see the assistant steering; "explode"
 * fails the session.
 */
export const defaultChat: ChatScenario = async (s) => {
  let cost = 0;
  for (;;) {
    const text = await s.next();
    if (text === null) return;
    s.emit(init('assistant-session-1'));
    if (text.includes('explode')) throw new Error('simulated SDK failure');
    const rerun = text.match(/^rerun (\S+) from (draft|critique|final): (.+)$/);
    if (rerun) {
      const r = await s.tool('rerun_chapters', { chapters: [rerun[1]], from: rerun[2], note: rerun[3] });
      s.emit(say(r.content[0].text));
    } else if (text.startsWith('status')) {
      const r = await s.tool('pipeline_status', {});
      s.emit(say(r.content[0].text));
    } else if (text.startsWith('pause')) {
      const r = await s.tool('pause_run', {});
      s.emit(say(r.content[0].text));
    } else {
      s.emit(say(`Noted: ${text.slice(0, 80)}`));
    }
    cost += 0.01;
    s.emit(result(cost));
  }
};

function chatQuery(params: QueryParams, context: QueryContext, scenario: ChatScenario): Query {
  const out: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  const poke = () => {
    wake?.();
    wake = null;
  };
  const input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
  const script: ChatScript = {
    async next() {
      const r = await input.next();
      if (r.done) return null;
      const content = r.value.message.content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    },
    emit(message) {
      out.push(message as unknown as SDKMessage);
      poke();
    },
    async tool(name, args) {
      const def = context.tools.find((t) => t.name === name);
      if (!def) throw new Error(`no lexis tool ${name}`);
      return (await def.handler(args as never, {})) as { content: { type: string; text: string }[] };
    },
  };
  scenario(script)
    .catch((e) => (failure = e))
    .finally(() => {
      finished = true;
      poke();
    });
  const iterator = {
    async next(): Promise<IteratorResult<SDKMessage>> {
      for (;;) {
        if (out.length) return { value: out.shift()!, done: false };
        if (failure) {
          const e = failure;
          failure = null;
          throw e;
        }
        if (finished) return { value: undefined, done: true };
        await new Promise<void>((r) => (wake = r));
      }
    },
    async return() {
      finished = true;
      return { value: undefined, done: true as const };
    },
    async throw(e: unknown) {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async interrupt() {},
    async initializationResult() {
      return {};
    },
  };
  return iterator as unknown as Query;
}

/** The fake `sdk.query`. */
export function fakeQuery(chat: ChatScenario = defaultChat, initAccount?: () => Record<string, unknown> | null): QueryFn {
  return (params, context) => {
    if (typeof params.prompt === 'string') return trackedStep(params);
    if (params.options?.mcpServers) return chatQuery(params, context, chat);
    // An account probe: nothing is ever read from the stream.
    const probe = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        await new Promise(() => {});
        return { value: undefined, done: true };
      },
      async return() {
        return { value: undefined, done: true as const };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt() {},
      async initializationResult() {
        return { account: initAccount?.() ?? undefined };
      },
    };
    return probe as unknown as Query;
  };
}

/** Wait until the engine's run reaches a state (or any of several). */
export async function untilRun(engine: { runState: string }, states: string | string[], ms = 15_000): Promise<void> {
  const want = Array.isArray(states) ? states : [states];
  const end = Date.now() + ms;
  while (!want.includes(engine.runState)) {
    if (Date.now() > end) throw new Error(`run is ${engine.runState}, not ${want.join('/')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
