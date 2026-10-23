import fs from 'node:fs';
import path from 'node:path';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryContext, QueryFn, QueryParams } from '../../src/sdk.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/** What a scripted run can do: wait for the user, emit SDK messages, call lexis tools. */
export interface Script {
  params: QueryParams;
  cwd: string;
  /** The next user message the app pushed into the session, or null once the session closes. */
  next(): Promise<string | null>;
  emit(message: { readonly type: string }): void;
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  interrupted: boolean;
}

export type Scenario = (s: Script) => Promise<void>;

/** Every query the fake has been asked to run, for assertions. */
export const calls: QueryParams[] = [];

/**
 * A Query that plays a scenario instead of starting Claude Code. Messages the
 * scenario emits come out of the async iterator in order; the scenario ends
 * the run by returning (or throwing, which the app sees as an SDK failure).
 */
export function fakeQuery(scenario: Scenario, initAccount?: () => Record<string, unknown> | null): QueryFn {
  return (params: QueryParams, context: QueryContext): Query => {
    calls.push(params);
    const out: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    const poke = () => {
      wake?.();
      wake = null;
    };

    const input =
      typeof params.prompt === 'string'
        ? (async function* () {
            yield { type: 'user', message: { role: 'user', content: params.prompt } } as unknown as SDKUserMessage;
          })()
        : (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();

    const script: Script = {
      params,
      cwd: params.options?.cwd ?? process.cwd(),
      interrupted: false,
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
        return (await def.handler(args as never, {})) as ToolResult;
      },
    };

    // Only the orchestrator's queries carry a scenario; account probes just initialize.
    const run = params.options?.agents ? scenario(script) : Promise.resolve();
    run
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
      async interrupt() {
        script.interrupted = true;
      },
      async initializationResult() {
        return { account: initAccount?.() ?? undefined };
      },
    };
    return iterator as unknown as Query;
  };
}

// ---------- message builders ----------

let counter = 0;
const id = (p: string) => `${p}_${++counter}`;

export const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId }) as const;

export function say(text: string, opts: { parent?: string | null; model?: string; usage?: Record<string, number> } = {}) {
  return {
    type: 'assistant',
    parent_tool_use_id: opts.parent ?? null,
    message: {
      id: id('msg'),
      model: opts.model ?? 'claude-sonnet-5-5',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: opts.usage,
    },
  } as const;
}

export function toolUse(name: string, input: Record<string, unknown>, opts: { parent?: string | null; toolId?: string } = {}) {
  const toolId = opts.toolId ?? id('toolu');
  return {
    toolId,
    message: {
      type: 'assistant',
      parent_tool_use_id: opts.parent ?? null,
      message: { id: id('msg'), model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] },
    } as const,
  };
}

export const toolResult = (toolId: string) =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }] },
  }) as const;

export function result(modelUsage: Record<string, { in: number; out: number; cost: number }> = {}) {
  const usage: Record<string, unknown> = {};
  for (const [m, u] of Object.entries(modelUsage)) {
    usage[m] = { inputTokens: u.in, outputTokens: u.out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: u.cost, webSearchRequests: 0, contextWindow: 1_000_000 };
  }
  return { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 3, result: 'ok', modelUsage: usage, total_cost_usd: 0 } as const;
}

// ---------- the scenario the integration and browser tests share ----------

/**
 * A miniature translation: preparation, one chapter of extraction and
 * production (writing real files into the workspace), the review gate, then
 * packaging. Later messages get a short reply; "revise" instructions loop
 * back through the gate; a message containing "explode" fails the run.
 */
export const pipelineScenario: Scenario = async (s) => {
  const first = await s.next();
  if (first === null) return;
  s.emit(init('fake-session-1'));
  await respond(s, first);
  for (;;) {
    const text = await s.next();
    if (text === null) return;
    await respond(s, text);
  }
};

async function respond(s: Script, text: string): Promise<void> {
  if (text.includes('explode')) throw new Error('simulated SDK failure');
  if (!text.startsWith('Begin the translation')) {
    s.emit(say(`Noted: ${text.slice(0, 80)}`));
    s.emit(result({ 'claude-sonnet-5-5': { in: 100, out: 20, cost: 0.01 } }));
    return;
  }
  const ws = s.cwd;
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), body);
  };

  s.emit(say('Starting the pipeline.'));
  await s.tool('report_progress', { phase: 'preparation', state: 'started' });
  const disbind = toolUse('Task', { subagent_type: 'ebook-disbinder', description: 'Extract the EPUB' });
  s.emit(disbind.message);
  s.emit(say('Extracted 1 chapter.', { parent: disbind.toolId, usage: { input_tokens: 1000, output_tokens: 200 } }));
  s.emit(toolUse('Bash', { command: 'unzip -qq source.epub -d original' }, { parent: disbind.toolId }).message);
  write('original/OEBPS/chapter1.xhtml', '<html><body><p>Hello world.</p></body></html>');
  s.emit(toolResult(disbind.toolId));
  await s.tool('report_progress', { phase: 'preparation', state: 'completed' });
  await s.tool('save_version', { label: 'after preparation' });

  for (const phase of ['initialization', 'extraction']) {
    await s.tool('report_progress', { phase, state: 'started' });
    await s.tool('report_progress', { phase, chapter: 'chapter1.xhtml', state: 'completed' });
    await s.tool('report_progress', { phase, state: 'completed' });
  }
  write('notes/master_glossary.json', JSON.stringify({ terms: [{ source: 'world', target: 'mundo' }] }, null, 2));

  await s.tool('report_progress', { phase: 'production', state: 'started' });
  const translate = toolUse('Task', { subagent_type: 'primary-translator', description: 'Draft chapter1' });
  s.emit(translate.message);
  s.emit(say('Drafted.', { parent: translate.toolId, model: 'claude-opus-5-5', usage: { input_tokens: 4000, output_tokens: 1500 } }));
  write('draft/chapter1.xhtml', '<html><body><p>Hola mundo.</p></body></html>');
  write('final/chapter1.xhtml', '<html><body><p>¡Hola, mundo!</p></body></html>');
  s.emit(toolResult(translate.toolId));
  await s.tool('report_progress', { phase: 'production', chapter: 'chapter1.xhtml', state: 'completed' });
  await s.tool('report_progress', { phase: 'production', state: 'completed' });
  await s.tool('save_version', { label: 'all chapters finalized' });

  await s.tool('report_progress', { phase: 'review', state: 'started' });
  let answer = (await s.tool('request_review', { summary: '1 chapter translated. Glossary: 1 term.' })).content[0].text;
  while (answer.startsWith('REVISION')) {
    write('final/chapter1.xhtml', '<html><body><p>¡Hola, mundo! (revised)</p></body></html>');
    await s.tool('save_version', { label: 'applied revision' });
    answer = (await s.tool('request_review', { summary: 'Revision applied.' })).content[0].text;
  }
  await s.tool('report_progress', { phase: 'review', state: 'completed' });

  await s.tool('report_progress', { phase: 'packaging', state: 'started' });
  fs.copyFileSync(path.join(ws, 'source.epub'), path.join(ws, 'translated_book.epub'));
  await s.tool('save_version', { label: 'packaged epub' });
  await s.tool('mark_complete', { epub_path: 'translated_book.epub', summary: 'Done: 1 chapter.' });
  s.emit(say('The translated EPUB is ready.'));
  s.emit(
    result({
      'claude-sonnet-5-5': { in: 2000, out: 400, cost: 0.02 },
      'claude-opus-5-5': { in: 4000, out: 1500, cost: 0.05 },
    }),
  );
}
