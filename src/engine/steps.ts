import fs from 'node:fs';
import path from 'node:path';
import { validateEpubDir } from '../epub.js';
import type { Chapter, ProjectMeta } from '../types.js';

/**
 * What each agent is asked, and what counts as having done it.
 *
 * Every task prompt is a template: the agent's own prompt (agents/*.md) is the
 * system prompt and says how to do the job; this names the exact files for
 * this chapter, carries the project's instructions and the chapter's note,
 * and spells out the harness contract. The same stage on two chapters is
 * asked for the same way.
 */

/** Everything a prompt or a check may need to know about the project. */
export interface StepContext {
  workspace: string;
  meta: ProjectMeta;
  chapters: Chapter[];
  /** Paths inside the EPUB, relative to original/ and final/. */
  opfPath: string;
  navPath?: string;
  ncxPath?: string;
  maxLoopRounds: number;
  /** Set when this book inherited its notes from an earlier book in its series. */
  inherited?: { fromName: string; files: string[]; glossaryEntries: number };
}

/** Where a chapter's files live. `key` is the agents' `<original file>`. */
export function chapterPaths(c: Chapter) {
  return {
    source: `original/${c.path}`,
    draft: `draft/${c.path}`,
    final: `final/${c.path}`,
    summary: `notes/${c.key}.summary.txt`,
    challenges: `notes/${c.key}.challenges.md`,
    lexicon: `notes/${c.key}.lexicon.json`,
    omission: `notes/${c.key}.omission_report.md`,
    stray: `notes/${c.key}.stray_report.json`,
    critique: `critique/${c.key}.critique.md`,
    finalCheck: `critique/${c.key}.final_check.md`,
  };
}

/** The agent invocations a stage is made of. */
export type RunMode =
  | 'metadata'
  | 'style'
  | 'charter'
  | 'summarize'
  | 'lexicon'
  | 'glossary'
  | 'translate'
  | 'refine'
  | 'audit'
  | 'scan'
  | 'fix'
  | 'critique'
  | 'final'
  | 'verify'
  | 'verify-fix'
  | 'package';

export const MODE_AGENT: Record<RunMode, string> = {
  metadata: 'metadata-generator',
  style: 'style-analyzer',
  charter: 'critique-charter-generator',
  summarize: 'narrative-summarizer',
  lexicon: 'local-lexicographer',
  glossary: 'glossary-manager',
  translate: 'primary-translator',
  refine: 'primary-translator',
  audit: 'omission-detector',
  scan: 'stray-phrase-detector',
  fix: 'stray-phrase-fixer',
  critique: 'native-critique',
  final: 'final-translator',
  verify: 'native-critique',
  'verify-fix': 'final-translator',
  package: 'ebook-packager',
};

const CONTRACT = `# Harness contract
- Write only the files named in this task, at exactly these paths (relative to the project root, which is your working directory). Do not create other files and do not touch anything under original/.
- Nobody is watching this session: do not ask questions or wait for confirmation. Make reasonable choices and finish the job.
- When the files are written, reply with one or two lines saying what you did.`;

function header(ctx: StepContext, c?: Chapter): string {
  const lines = [`# Project`, `- Translating into: ${ctx.meta.targetLanguage}`];
  lines.push(`- Instructions from the user: ${ctx.meta.context?.trim() ? ctx.meta.context.trim() : '(none)'}`);
  if (ctx.meta.series) {
    lines.push(`- This book is part ${ctx.meta.seriesIndex ?? '?'} of the series "${ctx.meta.series}".${ctx.inherited ? ` The glossary includes ${ctx.inherited.glossaryEntries} terms established in "${ctx.inherited.fromName}": they are settled; use them as they are.` : ''}`);
  }
  if (c) {
    const included = ctx.chapters.filter((x) => !x.excluded);
    const pos = included.findIndex((x) => x.key === c.key) + 1;
    lines.push(`- This section: ${pos} of ${included.length} — "${c.title}" (${c.words} words), key \`${c.key}\``);
    if (c.note?.trim()) lines.push(`- Note from the user about this section: ${c.note.trim()}`);
  }
  return lines.join('\n');
}

const XHTML_RULE = `The source is an XHTML document: keep every tag, attribute, id and class exactly as it is and translate only the human-readable text (including title and alt attributes). The output must be a complete XHTML document that opens in a reader.`;

/** When a book continues a series, the initialization agents refresh the earlier book's document instead of starting over. */
function refresh(ctx: StepContext, rel: string, what: string): string[] {
  if (!ctx.inherited?.files.includes(rel)) return [];
  return [
    `This book continues the series: \`${rel}\` already exists, produced for "${ctx.inherited.fromName}". Read it first. Keep every decision it established (languages and dialect, audience, register, conventions, transliteration choices, watchlist entries${what ? `, ${what}` : ''}) unless this book plainly contradicts it; update only what is specific to this book. Overwrite the file with the refreshed version.`,
  ];
}

/** The task prompt for one agent invocation. `hint` carries why the previous attempt was rejected. */
export function taskPrompt(ctx: StepContext, mode: RunMode, c: Chapter | undefined, opts: { round?: number; hint?: string } = {}): string {
  const p = c ? chapterPaths(c) : undefined;
  const parts = [header(ctx, c), ''];
  const included = ctx.chapters.filter((x) => !x.excluded);
  const sample = included
    .filter((x) => x.words >= 300)
    .slice(0, 3)
    .map((x) => `original/${x.path}`);
  switch (mode) {
    case 'metadata':
      parts.push(
        `# Task`,
        `Write \`notes/metadata.json\` as your instructions describe. The reading order and titles are in \`notes/contents.json\` (${included.length} documents to translate).`,
        `Narrative to sample: ${sample.join(', ') || 'the files listed in notes/contents.json'}.`,
        `The user's instructions above are the "user-provided project description": honour them when choosing the target dialect, audience and register.`,
        ...refresh(ctx, 'notes/metadata.json', 'linguistic guidance'),
      );
      break;
    case 'style':
      parts.push(`# Task`, `Write \`notes/style_guide.md\`. Read \`notes/metadata.json\` and \`notes/contents.json\` first; sample narrative from: ${sample.join(', ') || 'the files in notes/contents.json'}.`, ...refresh(ctx, 'notes/style_guide.md', "the author's voice"));
      break;
    case 'charter':
      parts.push(`# Task`, `Write \`notes/critique_charter.md\` from \`notes/metadata.json\`, \`notes/style_guide.md\` and \`notes/contents.json\`.`, ...refresh(ctx, 'notes/critique_charter.md', ''));
      break;
    case 'summarize':
      parts.push(`# Task`, `Section file: \`${p!.source}\`. Write \`${p!.summary}\` and \`${p!.challenges}\`. The reading order is in \`notes/contents.json\`.`);
      break;
    case 'lexicon':
      parts.push(`# Task`, `Section file: \`${p!.source}\`. Write \`${p!.lexicon}\` (a strict JSON array). The locale is in \`notes/metadata.json\`.`);
      break;
    case 'glossary':
      parts.push(
        `# Task`,
        `Merge this section's lexicon \`${p!.lexicon}\` (source text: \`${p!.source}\`) into the master glossary \`notes/master_glossary.json\`, which already exists (it may be an empty array) and must stay a strict JSON array. Overwrite it in place. The locale is in \`notes/metadata.json\`.`,
      );
      break;
    case 'translate':
      parts.push(
        `# Task`,
        `Translate \`${p!.source}\` and write the draft to \`${p!.draft}\`. This is the initial draft: no omission report exists yet.`,
        `Context files: \`${p!.summary}\`, \`${p!.challenges}\`, \`notes/master_glossary.json\`, \`notes/contents.json\`, \`notes/style_guide.md\`, \`notes/metadata.json\`.`,
        XHTML_RULE,
      );
      break;
    case 'refine':
      parts.push(
        `# Task`,
        `The omission audit of \`${p!.draft}\` found missing content: see \`${p!.omission}\` (round ${opts.round ?? 1} of ${ctx.maxLoopRounds}). Update \`${p!.draft}\` in place, inserting every segment the report lists where it belongs; keep everything that is already correct.`,
        `Source: \`${p!.source}\`. Context files: \`${p!.summary}\`, \`${p!.challenges}\`, \`notes/master_glossary.json\`, \`notes/style_guide.md\`, \`notes/metadata.json\`.`,
        XHTML_RULE,
      );
      break;
    case 'audit':
      parts.push(`# Task`, `Compare \`${p!.source}\` with the draft \`${p!.draft}\` and write \`${p!.omission}\`, ending with the STATUS line your instructions require.`);
      break;
    case 'scan':
      parts.push(
        `# Task`,
        `Scan the draft \`${p!.draft}\` for text left in the source language and write \`${p!.stray}\` (strict JSON). Languages are in \`notes/metadata.json\`. Use the Grep tool for script-based scans (it supports Unicode classes such as \\p{Latin} and \\p{Han}).`,
      );
      break;
    case 'fix':
      parts.push(
        `# Task`,
        `Fix the stray phrases listed in \`${p!.stray}\` (round ${opts.round ?? 1} of ${ctx.maxLoopRounds}) in the draft \`${p!.draft}\`, overwriting it. Source: \`${p!.source}\`; context: \`notes/master_glossary.json\`, \`notes/style_guide.md\`, \`notes/metadata.json\`, \`notes/contents.json\`, \`${p!.summary}\`, \`${p!.challenges}\`.`,
        XHTML_RULE,
      );
      break;
    case 'critique':
      parts.push(
        `# Task`,
        `Critique the draft \`${p!.draft}\` (source: \`${p!.source}\`) and write \`${p!.critique}\`. Your charter is \`notes/critique_charter.md\`; the audience profile is \`notes/metadata.json\`; support: \`notes/style_guide.md\`, \`notes/master_glossary.json\`.`,
      );
      break;
    case 'final':
      parts.push(
        `# Task`,
        `Produce the final translation \`${p!.final}\` from the source \`${p!.source}\`, the draft \`${p!.draft}\` and the critique \`${p!.critique}\`. Support: \`notes/master_glossary.json\`, \`notes/style_guide.md\`, \`notes/metadata.json\`, \`notes/contents.json\`, \`${p!.summary}\`, \`${p!.challenges}\`.`,
        XHTML_RULE,
      );
      break;
    case 'verify':
      parts.push(
        `# Task`,
        `VERIFY the finalized translation: read \`${p!.final}\` (not the draft) and the earlier critique \`${p!.critique}\`, cross-check against \`${p!.source}\`, and write \`${p!.finalCheck}\` ending with exactly \`STATUS: PASS\` or \`STATUS: ISSUES_FOUND\` as its final line. This is a gate, not a second full critique.`,
      );
      break;
    case 'verify-fix':
      parts.push(
        `# Task`,
        `Verification fixes: apply the final-check report \`${p!.finalCheck}\` to \`${p!.final}\`, updating it in place. Address every issue the report lists and change nothing else. Source: \`${p!.source}\`; support: \`notes/master_glossary.json\`, \`notes/style_guide.md\`, \`notes/metadata.json\`.`,
        XHTML_RULE,
      );
      break;
    case 'package': {
      const finals = included.map((x) => `final/${x.path}`);
      parts.push(
        `# Task`,
        `The harness has already mirrored \`original/\` into \`final/\`: every asset and every untranslated document is in place, and the translated sections are at ${finals.slice(0, 6).join(', ')}${finals.length > 6 ? ` and ${finals.length - 6} more` : ''}. The harness zips \`final/\` into the EPUB afterwards and applies any custom cover itself.`,
        `Your job, inside \`final/\` only:`,
        `1. Localize the package document \`final/${ctx.opfPath}\`: \`<dc:title>\`, \`<dc:creator>\`, \`<dc:description>\`, and set \`<dc:language>\` and every \`xml:lang\` to the target locale from \`notes/metadata.json\`.`,
        ctx.navPath ? `2. Translate the navigation labels in \`final/${ctx.navPath}\`${ctx.ncxPath ? ` and \`final/${ctx.ncxPath}\`` : ''} so they match the translated headings in the sections exactly; update their language attributes.` : `2. There is no navigation document${ctx.ncxPath ? `; translate the \`<navLabel>\` texts in \`final/${ctx.ncxPath}\`` : ''}.`,
        `3. Audit internal links and references so they still resolve within \`final/\`.`,
        `Do not zip, do not create translated_book.epub, do not run shell commands, and do not edit anything under \`original/\`.`,
      );
      break;
    }
  }
  if (opts.hint) parts.push('', `# Previous attempt`, `The previous attempt was rejected: ${opts.hint}. Correct this.`);
  parts.push('', CONTRACT);
  return parts.join('\n');
}

/** The files an invocation reads and the files it writes, for the trace (inputs snapshotted before, outputs after). */
export function filesOf(ctx: StepContext, mode: RunMode, c?: Chapter): { inputs: string[]; outputs: string[] } {
  const p = c ? chapterPaths(c) : undefined;
  const notes = ['notes/master_glossary.json', 'notes/contents.json', 'notes/style_guide.md', 'notes/metadata.json'];
  const included = ctx.chapters.filter((x) => !x.excluded);
  const sample = included.filter((x) => x.words >= 300).slice(0, 3).map((x) => `original/${x.path}`);
  switch (mode) {
    case 'metadata':
      return { inputs: ['notes/contents.json', 'notes/metadata.json', ...sample], outputs: ['notes/metadata.json'] };
    case 'style':
      return { inputs: ['notes/contents.json', 'notes/metadata.json', 'notes/style_guide.md', ...sample], outputs: ['notes/style_guide.md'] };
    case 'charter':
      return { inputs: ['notes/contents.json', 'notes/metadata.json', 'notes/style_guide.md', 'notes/critique_charter.md'], outputs: ['notes/critique_charter.md'] };
    case 'summarize':
      return { inputs: [p!.source, 'notes/contents.json'], outputs: [p!.summary, p!.challenges] };
    case 'lexicon':
      return { inputs: [p!.source, 'notes/metadata.json'], outputs: [p!.lexicon] };
    case 'glossary':
      return { inputs: [p!.source, p!.lexicon, 'notes/master_glossary.json', 'notes/metadata.json'], outputs: ['notes/master_glossary.json'] };
    case 'translate':
      return { inputs: [p!.source, p!.summary, p!.challenges, ...notes], outputs: [p!.draft] };
    case 'refine':
      return { inputs: [p!.source, p!.draft, p!.omission, p!.summary, p!.challenges, ...notes], outputs: [p!.draft] };
    case 'audit':
      return { inputs: [p!.source, p!.draft], outputs: [p!.omission] };
    case 'scan':
      return { inputs: [p!.draft, 'notes/metadata.json'], outputs: [p!.stray] };
    case 'fix':
      return { inputs: [p!.source, p!.draft, p!.stray, p!.summary, p!.challenges, ...notes], outputs: [p!.draft] };
    case 'critique':
      return { inputs: [p!.source, p!.draft, 'notes/critique_charter.md', ...notes], outputs: [p!.critique] };
    case 'final':
      return { inputs: [p!.source, p!.draft, p!.critique, p!.summary, p!.challenges, ...notes], outputs: [p!.final] };
    case 'verify':
      return { inputs: [p!.source, p!.final, p!.critique, 'notes/critique_charter.md', 'notes/metadata.json'], outputs: [p!.finalCheck] };
    case 'verify-fix':
      return { inputs: [p!.source, p!.final, p!.finalCheck, ...notes], outputs: [p!.final] };
    case 'package': {
      const nav = [ctx.navPath, ctx.ncxPath].filter((x): x is string => Boolean(x)).map((x) => `final/${x}`);
      return { inputs: [`final/${ctx.opfPath}`, ...nav, 'notes/metadata.json'], outputs: [`final/${ctx.opfPath}`, ...nav] };
    }
  }
}

// ---------- checking what an agent wrote ----------

export interface Check {
  ok: boolean;
  /** Why the output was rejected; also the hint the retry gets. */
  problem?: string;
  /** Something to record without rejecting. */
  warning?: string;
  /** The status a report declares, for loop decisions. */
  status?: 'COMPLETE' | 'INCOMPLETE' | 'CLEAN' | 'ISSUES_FOUND' | 'PASS';
}

const ok = (extra: Partial<Check> = {}): Check => ({ ok: true, ...extra });
const bad = (problem: string): Check => ({ ok: false, problem });

function read(ws: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(ws, rel), 'utf8');
  } catch {
    return null;
  }
}

function json(text: string): unknown | undefined {
  try {
    return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    return undefined;
  }
}

/** The last non-empty line of a report, which is where the agents put their STATUS. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function nonEmpty(ws: string, rel: string, min: number, what: string): Check {
  const t = read(ws, rel);
  if (t === null) return bad(`${what} \`${rel}\` was not written`);
  if (t.trim().length < min) return bad(`${what} \`${rel}\` is empty or far too short`);
  return ok();
}

/** A translated document must still be the same kind of document as its source. */
function translatedDocument(ws: string, source: string, out: string): Check {
  const o = read(ws, out);
  if (o === null) return bad(`the translation \`${out}\` was not written`);
  const s = read(ws, source) ?? '';
  if (o.trim().length < 20) return bad(`the translation \`${out}\` is empty`);
  if (/<html\b/i.test(s) && !/<html\b/i.test(o)) return bad(`\`${out}\` lost the XHTML structure of the source: it must be a complete XHTML document with the source's tags intact, text translated`);
  if (/<body\b/i.test(s) && !/<body\b/i.test(o)) return bad(`\`${out}\` has no <body>: keep the source's XHTML structure and translate only the text`);
  if (/```/.test(o.slice(0, 200))) return bad(`\`${out}\` starts with a markdown code fence; the file must contain only the document itself`);
  const ratio = o.length / Math.max(1, s.length);
  if (ratio < 0.2) return ok({ warning: `the translation is only ${Math.round(ratio * 100)}% of the source's size` });
  return ok();
}

export function checkOutput(ctx: StepContext, mode: RunMode, c?: Chapter, before: { glossaryEntries?: number } = {}): Check {
  const ws = ctx.workspace;
  const p = c ? chapterPaths(c) : undefined;
  switch (mode) {
    case 'metadata': {
      const t = read(ws, 'notes/metadata.json');
      if (t === null) return bad('`notes/metadata.json` was not written');
      const v = json(t) as Record<string, unknown> | undefined;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('`notes/metadata.json` is not a JSON object');
      if (!v.target_language) return bad('`notes/metadata.json` has no `target_language`');
      return ok();
    }
    case 'style':
      return nonEmpty(ws, 'notes/style_guide.md', 200, 'the style guide');
    case 'charter':
      return nonEmpty(ws, 'notes/critique_charter.md', 200, 'the charter');
    case 'summarize': {
      const a = nonEmpty(ws, p!.summary, 50, 'the summary');
      if (!a.ok) return a;
      return nonEmpty(ws, p!.challenges, 20, 'the challenges report');
    }
    case 'lexicon': {
      const t = read(ws, p!.lexicon);
      if (t === null) return bad(`\`${p!.lexicon}\` was not written`);
      if (!Array.isArray(json(t))) return bad(`\`${p!.lexicon}\` is not a strict JSON array`);
      return ok();
    }
    case 'glossary': {
      const t = read(ws, 'notes/master_glossary.json');
      if (t === null) return bad('`notes/master_glossary.json` is missing');
      const v = json(t);
      if (!Array.isArray(v)) return bad('`notes/master_glossary.json` is not a strict JSON array');
      if (before.glossaryEntries !== undefined && v.length < before.glossaryEntries) {
        return ok({ warning: `the glossary shrank from ${before.glossaryEntries} to ${v.length} entries` });
      }
      return ok();
    }
    case 'translate':
    case 'refine':
    case 'fix':
      return translatedDocument(ws, p!.source, p!.draft);
    case 'audit': {
      const t = read(ws, p!.omission);
      if (t === null) return bad(`\`${p!.omission}\` was not written`);
      if (lastLine(t) === 'STATUS: COMPLETE') return ok({ status: 'COMPLETE' });
      if (/^STATUS:\s*INCOMPLETE/m.test(t)) return ok({ status: 'INCOMPLETE' });
      return bad(`\`${p!.omission}\` carries no STATUS line (it must end with \`STATUS: COMPLETE\` or start with \`STATUS: INCOMPLETE\`)`);
    }
    case 'scan': {
      const t = read(ws, p!.stray);
      if (t === null) return bad(`\`${p!.stray}\` was not written`);
      const v = json(t) as { status?: string; stray_phrases?: unknown[] } | undefined;
      if (!v || typeof v !== 'object') return bad(`\`${p!.stray}\` is not strict JSON`);
      if (v.status === 'CLEAN') return ok({ status: 'CLEAN' });
      if (v.status === 'ISSUES_FOUND') return ok({ status: 'ISSUES_FOUND' });
      return bad(`\`${p!.stray}\` has no "status" of CLEAN or ISSUES_FOUND`);
    }
    case 'critique':
      return nonEmpty(ws, p!.critique, 50, 'the critique');
    case 'final':
    case 'verify-fix':
      return translatedDocument(ws, p!.source, p!.final);
    case 'verify': {
      const t = read(ws, p!.finalCheck);
      if (t === null) return bad(`\`${p!.finalCheck}\` was not written`);
      const last = lastLine(t).replace(/[`*]/g, '');
      if (last === 'STATUS: PASS') return ok({ status: 'PASS' });
      if (last === 'STATUS: ISSUES_FOUND') return ok({ status: 'ISSUES_FOUND' });
      return bad(`\`${p!.finalCheck}\` must end with \`STATUS: PASS\` or \`STATUS: ISSUES_FOUND\` as its final line`);
    }
    case 'package': {
      const problems = validateEpubDir(path.join(ws, 'final'));
      return problems.length ? bad(`final/ is not a valid EPUB layout: ${problems.slice(0, 3).join('; ')}`) : ok();
    }
  }
}

/** Does the file a done step produced still exist? Used to re-validate state after a restart or a revert. */
export function outputsExist(ctx: StepContext, stage: string, c?: Chapter): boolean {
  const ws = ctx.workspace;
  const has = (rel: string) => fs.existsSync(path.join(ws, rel));
  const p = c ? chapterPaths(c) : undefined;
  switch (stage) {
    case 'prepare':
      return has('original/META-INF/container.xml') && has('notes/contents.json');
    case 'metadata':
      return has('notes/metadata.json');
    case 'style':
      return has('notes/style_guide.md');
    case 'charter':
      return has('notes/critique_charter.md');
    case 'summarize':
      return has(p!.summary) && has(p!.challenges);
    case 'lexicon':
      return has(p!.lexicon);
    case 'glossary':
      return has('notes/master_glossary.json');
    case 'draft':
    case 'stray':
      return has(p!.draft);
    case 'critique':
      return has(p!.critique);
    case 'final':
      return has(p!.final);
    case 'verify':
      return has(p!.final) && has(p!.finalCheck);
    case 'package':
      return has('translated_book.epub');
    default:
      return true;
  }
}

/** Files a stage writes, removed before it is re-run from scratch so the agents start clean. */
export function outputsOf(stage: string, c: Chapter): string[] {
  const p = chapterPaths(c);
  switch (stage) {
    case 'summarize':
      return [p.summary, p.challenges];
    case 'lexicon':
      return [p.lexicon];
    case 'draft':
      return [p.draft, p.omission, p.stray];
    case 'stray':
      return [p.stray];
    case 'critique':
      return [p.critique];
    case 'final':
      return [p.final, p.finalCheck];
    case 'verify':
      return [p.finalCheck];
    default:
      return [];
  }
}
