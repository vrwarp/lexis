/**
 * Smoke tests for the lexis open-agent harness — no API keys needed.
 * A scripted LanguageModelV2 mock drives the orchestrator end-to-end:
 * progress -> subagent -> version -> review gate -> approve -> mark_complete.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';

process.env.LEXIS_OA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-oa-test-'));

const failures: string[] = [];
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${condition || !detail ? '' : ' — ' + detail}`);
  if (!condition) failures.push(name);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Imports AFTER env setup (module-load-time config).
const { createProject } = await import('../src/projects.js');
const { buildFileTools } = await import('../src/fs-tools.js');
const { PromptRegistry } = await import('../src/prompts.js');
const { ModelFactory } = await import('../src/config.js');
const { OrchestratorSession } = await import('../src/orchestrator.js');
const { saveVersion, listVersions, revertToVersion } = await import('../src/versioning.js');
const { replaceCover } = await import('../src/epub.js');
const { orchestratorPrompt } = await import('../src/prompt.js');

// ---------- fixtures ----------

function makeEpub(dest: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-src-'));
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip');
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'META-INF', 'container.xml'),
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  fs.mkdirSync(path.join(dir, 'OEBPS', 'images'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'OEBPS', 'content.opf'),
    '<?xml version="1.0"?><package><metadata><meta name="cover" content="cov"/></metadata><manifest><item id="cov" href="images/cover.jpg" media-type="image/jpeg"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest></package>',
  );
  const noise = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(crypto.getRandomValues(new Uint8Array(4000))), Buffer.from([0xff, 0xd9])]);
  fs.writeFileSync(path.join(dir, 'OEBPS', 'images', 'cover.jpg'), noise);
  fs.writeFileSync(path.join(dir, 'OEBPS', 'ch1.xhtml'), '<html><body><p>Hello world.</p></body></html>');
  fs.rmSync(dest, { force: true });
  execFileSync('zip', ['-0Xq', dest, 'mimetype'], { cwd: dir });
  execFileSync('zip', ['-rgq', dest, '.', '-x', 'mimetype'], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

const epubPath = path.join(os.tmpdir(), `lexis-oa-fixture-${Date.now()}.epub`);
makeEpub(epubPath);

const project = createProject({
  name: 'test-book',
  targetLanguage: 'French',
  context: 'test context',
  epubBuffer: fs.readFileSync(epubPath),
  epubFilename: 'test.epub',
});
check('project created with git repo', fs.existsSync(path.join(project.workspace, '.git')));
check('orchestrator prompt renders', orchestratorPrompt(project.meta).includes('Lexis Orchestrator'));

// ---------- prompt registry ----------

const registry = new PromptRegistry();
check('14 agent definitions load', registry.names().length === 14, registry.names().join(','));
check(
  'tiers assigned per LESSONS',
  [
    'primary_translator',
    'final_translator',
    'native_critique',
    'critique_charter_generator',
    'metadata_generator',
    'style_analyzer',
  ].every(n => registry.get(n).tier === 'translation') &&
    registry.get('omission_detector').tier === 'mechanical',
);
check('mustache render works', registry.finish('style_analyzer').includes('Style Analyzer'));

// ---------- file tools ----------

const ws = project.workspace;
const tools = buildFileTools(ws, ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash']);
const run = async (name: string, input: unknown): Promise<string> =>
  (await (tools[name] as any).execute(input, { toolCallId: 't', messages: [] })) as string;

check('write_file', (await run('write_file', { path: 'notes/a.txt', content: 'alpha\nbeta\ngamma\n' })).includes('Wrote'));
check('read_file numbers lines', (await run('read_file', { path: 'notes/a.txt' })).includes('2\tbeta'));
let jailHit = false;
try {
  await run('read_file', { path: '../../../etc/passwd' });
} catch {
  jailHit = true;
}
check('path jail blocks escape', jailHit);
let gitHit = false;
try {
  await run('write_file', { path: '.git/hooks/x', content: 'nope' });
} catch {
  gitHit = true;
}
check('path jail blocks .git', gitHit);
check('edit_file uniqueness contract', (await run('edit_file', { path: 'notes/a.txt', old_string: 'a', new_string: 'X' })).includes('occurs'));
check('edit_file replace', (await run('edit_file', { path: 'notes/a.txt', old_string: 'beta', new_string: 'BETA' })).includes('Replaced 1'));
check('glob finds', (await run('glob', { pattern: 'notes/**/*.txt' })).includes('notes/a.txt'));
check('glob single star', (await run('glob', { pattern: '*.epub' })).includes('source.epub'));
check('grep finds', (await run('grep', { pattern: 'BETA' })).includes('notes/a.txt:2'));
check('bash runs in workspace', (await run('bash', { command: 'ls' })).includes('source.epub'));

// ---------- versioning ----------

const v1 = await saveVersion(project, 'with notes');
check('save_version commits', v1 !== null && v1!.label === 'with notes');
fs.writeFileSync(path.join(ws, 'notes', 'a.txt'), 'changed');
await saveVersion(project, 'changed a.txt');
await revertToVersion(project, v1!.id);
check('revert restores content', fs.readFileSync(path.join(ws, 'notes', 'a.txt'), 'utf8').startsWith('alpha'));
check('revert is non-destructive', (await listVersions(project)).some(v => v.label.startsWith('revert to')));

// ---------- deterministic cover replacement ----------

const builtEpub = path.join(ws, 'translated_book.epub');
makeEpub(builtEpub);
const newCover = path.join(ws, 'cover_override.png');
fs.writeFileSync(newCover, Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), Buffer.from(crypto.getRandomValues(new Uint8Array(3000)))]));
await replaceCover(builtEpub, newCover);
const zipList = execFileSync('unzip', ['-l', builtEpub]).toString();
check('cover replaced epub still a zip', zipList.includes('OEBPS/images/cover.jpg'));
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-oa-verify-'));
execFileSync('unzip', ['-qq', builtEpub, '-d', extracted]);
check('cover bytes replaced', fs.readFileSync(path.join(extracted, 'OEBPS/images/cover.jpg')).subarray(0, 4).toString('binary') === '\x89PNG');
check('opf media-type updated', fs.readFileSync(path.join(extracted, 'OEBPS/content.opf'), 'utf8').includes('media-type="image/png"'));
check('epub size plausible for mark_complete', fs.statSync(builtEpub).size >= 1024);

// ---------- mock-model end-to-end orchestrator run ----------

type Content = Record<string, unknown>;
const text = (t: string): Content => ({ type: 'text', text: t });
const call = (name: string, input: unknown, id: string): Content => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});

class MockModel {
  readonly specificationVersion = 'v2';
  readonly provider = 'mock';
  readonly supportedUrls = {};
  private step = 0;
  constructor(
    readonly modelId: string,
    private script: (step: number) => Content[],
  ) {}
  async doStream(_options: unknown) {
    const content = this.script(this.step++);
    const parts: Record<string, unknown>[] = [{ type: 'stream-start', warnings: [] }];
    let id = 0;
    for (const c of content) {
      if (c.type === 'text') {
        const tid = String(id++);
        parts.push({ type: 'text-start', id: tid });
        parts.push({ type: 'text-delta', id: tid, delta: c.text });
        parts.push({ type: 'text-end', id: tid });
      } else if (c.type === 'tool-call') {
        parts.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input });
      }
    }
    const finishReason = content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop';
    parts.push({ type: 'finish', finishReason, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    return { stream: simulateReadableStream({ chunks: parts as never }) };
  }
}

const orchScript = (step: number): Content[] =>
  [
    [text('Starting initialization.'), call('report_progress', { phase: 'initialization', state: 'started' }, 'c1')],
    [call('toc_verifier', { task: 'Verify the reading order in notes/contents.json.' }, 'c2')],
    [call('save_version', { label: 'after initialization' }, 'c3')],
    [call('request_review', { summary: '1 chapter drafted; ready to package?' }, 'c4')],
    [call('mark_complete', { epub_path: 'translated_book.epub', summary: 'done' }, 'c5')],
    [text('Pipeline finished; EPUB is ready to download.')],
  ][Math.min(step, 5)];

const subScript = (step: number): Content[] =>
  step % 2 === 0
    ? [text('Checking workspace.'), call('bash', { command: 'ls' }, `s${step}`)]
    : [text('notes/contents.json reading order verified.')];

class MockFactory extends ModelFactory {
  constructor() {
    super({ tiers: { translation: {}, mechanical: {}, orchestrator: {} }, pricing: {} });
  }
  override resolve(tier: string, agentName?: string) {
    const isOrch = agentName === 'orchestrator';
    return {
      model: new MockModel(isOrch ? 'mock/orchestrator' : 'mock/subagent', isOrch ? orchScript : subScript) as never,
      modelId: isOrch ? 'mock/orchestrator' : 'mock/subagent',
      settings: {},
    };
  }
}

const session = new OrchestratorSession(project, new MockFactory(), registry);
session.send('Begin the translation of source.epub into French.');

const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !session.awaitingReview) await sleep(50);
check('review gate reached (status awaiting_review)', session.awaitingReview && project.meta.status === 'awaiting_review');

// Queue a mid-run message while blocked at the gate — prepareStep must inject it.
session.send('Mid-run note: keep the title untranslated.');
await sleep(100);
check('review resolved', session.resolveReview('approve'));
while (Date.now() < deadline && !['completed', 'error'].includes(project.meta.status)) await sleep(50);
check('project completed', project.meta.status === 'completed', `status=${project.meta.status} err=${project.meta.lastError ?? ''}`);
check('outputPath recorded', project.meta.outputPath === 'translated_book.epub');

const events = project.readEvents();
const types = new Set(events.map(e => e.type));
for (const expected of ['user_message', 'progress', 'task_start', 'task_end', 'version', 'review_request', 'review_response', 'agent_text', 'usage', 'status']) {
  check(`event emitted: ${expected}`, types.has(expected as never));
}
check('subagent attributed events', events.some(e => e.agent === 'toc_verifier'));
check('tool_use from subagent bash', events.some(e => e.type === 'tool_use' && (e.data as { tool?: string }).tool === 'bash'));
check('progress done emitted', events.some(e => e.type === 'progress' && (e.data as { phase?: string }).phase === 'done'));
const usage = project.meta.usage;
check(
  'usage tracked per model',
  !!usage && usage.byModel['mock/orchestrator']?.inputTokens > 0 && usage.byModel['mock/subagent']?.inputTokens > 0,
  JSON.stringify(usage?.byModel ?? {}),
);
check('history persisted', fs.existsSync(project.historyFile) && JSON.parse(fs.readFileSync(project.historyFile, 'utf8')).length >= 6);
check('mid-run message in history', fs.readFileSync(project.historyFile, 'utf8').includes('Mid-run message'));

// ---------- history restore into a fresh session ----------

const restored = new OrchestratorSession(project, new MockFactory(), registry);
check('history restored on new session', (restored as unknown as { history: unknown[] }).history.length >= 6);

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
process.exit(0);
