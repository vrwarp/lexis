/**
 * Workspace-rooted file tools as AI SDK tool()s — the port of the Agent SDK's
 * Read/Write/Edit/Glob/Grep/Bash toolset, which open-agent does not have (its
 * tools operate on docs/embeddings/web/sandboxes, not a project directory).
 *
 * Contracts (jail, uniqueness, truncation caps) are identical to the other
 * lexis harnesses so the shared agent prompts behave identically.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tool, type Tool } from 'ai';
import { z } from 'zod';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_OBSERVATION_CHARS = 200_000;
const MAX_BASH_CHARS = 30_000;
const MAX_GREP_MATCHES = 200;

/** Resolve a model-supplied path safely inside the workspace. */
function jail(workspace: string, rel: string): string {
  const abs = path.resolve(workspace, rel);
  const root = path.resolve(workspace);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  if (path.relative(root, abs).split(path.sep).includes('.git')) {
    throw new Error('The .git directory is managed by the harness and is off-limits.');
  }
  return abs;
}

function cap(text: string, limit = MAX_OBSERVATION_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n… (output truncated at ${limit} characters)`;
}

function* walkFiles(root: string, dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(root, abs);
    else if (entry.isFile()) yield abs;
  }
}

/** Minimal glob matcher supporting *, ** and ? — enough for the pipeline's patterns. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function buildFileTools(workspace: string, names: string[]): Record<string, Tool> {
  const all: Record<string, Tool> = {
    read_file: tool({
      description:
        `Read a text file from the workspace. Returns line-numbered content. Reads up to ${MAX_READ_LINES} ` +
        'lines from `offset`; for longer files call again with a larger offset.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the project root'),
        offset: z.number().int().optional().describe('1-based line number to start from (default 1)'),
        limit: z.number().int().optional().describe(`Maximum lines to read (default ${MAX_READ_LINES})`),
      }),
      execute: async ({ path: rel, offset, limit }) => {
        const file = jail(workspace, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `Error: file not found: ${rel}`;
        const start = Math.max(1, offset ?? 1);
        const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const window = lines.slice(start - 1, start - 1 + count).map((line, i) => {
          const text = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + ' … (line truncated)' : line;
          return `${start + i}\t${text}`;
        });
        let body = window.join('\n') || '(empty file)';
        if (start - 1 + count < lines.length) {
          body += `\n… (file has ${lines.length} lines; continue with offset=${start + count})`;
        }
        return cap(body);
      },
    }),

    write_file: tool({
      description:
        'Write a text file in the workspace, creating parent directories and overwriting any existing file. ' +
        'The content is written exactly as given.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the project root'),
        content: z.string().describe('Full file content to write'),
      }),
      execute: async ({ path: rel, content }) => {
        const file = jail(workspace, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        return `Wrote ${content.length} characters to ${rel}`;
      },
    }),

    edit_file: tool({
      description:
        'Replace an exact string in a file. `old_string` must match the file contents exactly and be unique ' +
        'unless `replace_all` is true. Prefer this over write_file for targeted fixes in large files.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the project root'),
        old_string: z.string().describe('Exact text to replace (must be unique unless replace_all)'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
      }),
      execute: async ({ path: rel, old_string, new_string, replace_all }) => {
        const file = jail(workspace, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `Error: file not found: ${rel}`;
        const text = fs.readFileSync(file, 'utf8');
        const occurrences = text.split(old_string).length - 1;
        if (occurrences === 0) {
          return 'Error: old_string not found in the file. Read the file and retry with the exact text.';
        }
        if (occurrences > 1 && !replace_all) {
          return `Error: old_string occurs ${occurrences} times; provide more surrounding context to make it unique, or set replace_all=true.`;
        }
        fs.writeFileSync(file, text.replaceAll(old_string, new_string), 'utf8');
        return `Replaced ${replace_all ? occurrences : 1} occurrence(s) in ${rel}`;
      },
    }),

    glob: tool({
      description: 'Find files matching a glob pattern (e.g. "original/**/*.xhtml"). Returns sorted relative paths.',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern relative to the project root'),
        path: z.string().optional().describe('Subdirectory to search in (default project root)'),
      }),
      execute: async ({ pattern, path: sub }) => {
        const base = jail(workspace, sub ?? '.');
        if (!fs.existsSync(base)) return 'No files matched.';
        const regex = globToRegExp(pattern);
        const matches: string[] = [];
        for (const abs of walkFiles(base, base)) {
          const rel = path.relative(base, abs).split(path.sep).join('/');
          if (regex.test(rel)) matches.push(path.relative(workspace, abs).split(path.sep).join('/'));
        }
        return matches.length ? cap(matches.sort().join('\n')) : 'No files matched.';
      },
    }),

    grep: tool({
      description:
        'Search file contents with a regular expression. Returns `path:line: text` matches ' +
        `(capped at ${MAX_GREP_MATCHES}). Useful for locating text and for script-mismatch scans ` +
        '(e.g. pattern [A-Za-z]{3,} to find Latin-script strays, or [一-鿿] for Han characters).',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression, searched per line'),
        path: z.string().optional().describe('File or directory to search (default project root)'),
        glob: z.string().optional().describe('Only search files matching this glob (e.g. "*.xhtml")'),
        max_matches: z.number().int().optional().describe(`Cap on reported matches (default ${MAX_GREP_MATCHES})`),
      }),
      execute: async ({ pattern, path: sub, glob: fileGlob, max_matches }) => {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'u');
        } catch (e) {
          return `Error: invalid regular expression: ${e}`;
        }
        const target = jail(workspace, sub ?? '.');
        if (!fs.existsSync(target)) return 'No matches found.';
        const capMatches = Math.min(max_matches ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES);
        const fileRegex = fileGlob ? globToRegExp(fileGlob) : undefined;
        const files = fs.statSync(target).isFile() ? [target] : [...walkFiles(target, target)];
        const out: string[] = [];
        for (const file of files) {
          if (fileRegex && !fileRegex.test(path.basename(file))) continue;
          let text: string;
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              let snippet = lines[i].trim();
              if (snippet.length > 400) snippet = snippet.slice(0, 400) + ' …';
              out.push(`${path.relative(workspace, file)}:${i + 1}: ${snippet}`);
              if (out.length >= capMatches) {
                out.push(`… (stopped at ${capMatches} matches)`);
                return cap(out.join('\n'));
              }
            }
          }
        }
        return out.length ? cap(out.join('\n')) : 'No matches found.';
      },
    }),

    bash: tool({
      description:
        'Run a shell command with the project root as the working directory. Use for EPUB zip/unzip work ' +
        'and quick checks (ls, wc, file). Returns stdout+stderr and the exit code.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().int().optional().describe('Timeout in seconds (default 120, max 600)'),
      }),
      execute: ({ command, timeout }) =>
        new Promise<string>(resolve => {
          execFile(
            'bash',
            ['-lc', command],
            { cwd: workspace, timeout: Math.min(timeout ?? 120, 600) * 1000, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
                resolve('Error: command timed out.');
                return;
              }
              const code = error ? ((error as { code?: number | string }).code ?? 1) : 0;
              let output = (stdout || '') + (stderr ? `\n${stderr}` : '');
              output = output.trim() || '(no output)';
              if (output.length > MAX_BASH_CHARS) {
                output = output.slice(0, MAX_BASH_CHARS) + `\n… (output truncated at ${MAX_BASH_CHARS} characters)`;
              }
              resolve(`exit code: ${code}\n${output}`);
            },
          );
        }),
    }),
  };

  const unknown = names.filter(n => !(n in all));
  if (unknown.length) throw new Error(`Unknown tool(s) in agent definition: ${unknown.join(', ')}`);
  return Object.fromEntries(names.map(n => [n, all[n]]));
}
