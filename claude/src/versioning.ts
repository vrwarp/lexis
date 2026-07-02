import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from './projects.js';
import type { VersionInfo } from './types.js';

const execFileAsync = promisify(execFile);

async function git(project: Project, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: project.workspace,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

const AUTO_PREFIX = 'auto: ';

/**
 * Snapshot the whole workspace (original/, notes/, draft/, critique/, final/,
 * translated_book.epub) as a git commit. Returns null when nothing changed.
 */
export async function saveVersion(
  project: Project,
  label: string,
  auto = false,
): Promise<VersionInfo | null> {
  await git(project, 'add', '-A');
  const status = await git(project, 'status', '--porcelain');
  if (!status) return null;
  const message = (auto ? AUTO_PREFIX : '') + label;
  await git(project, 'commit', '-qm', message);
  const version = (await listVersions(project))[0];
  project.emit('version', 'orchestrator', { version: version as unknown as Record<string, unknown> });
  return version;
}

export async function listVersions(project: Project): Promise<VersionInfo[]> {
  const raw = await git(project, 'log', '--format=%H%x1f%s%x1f%cI');
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [id, subject, date] = line.split('\x1f');
    const auto = subject.startsWith(AUTO_PREFIX);
    return { id, label: auto ? subject.slice(AUTO_PREFIX.length) : subject, date, auto };
  });
}

/**
 * Restore the workspace to a previous version. The revert itself is recorded
 * as a new version, so nothing is ever lost and a revert can be reverted.
 */
export async function revertToVersion(project: Project, versionId: string): Promise<VersionInfo> {
  const versions = await listVersions(project);
  const target = versions.find((v) => v.id === versionId || v.id.startsWith(versionId));
  if (!target) throw new Error(`Unknown version: ${versionId}`);
  // Snapshot any un-committed work first so the revert is non-destructive.
  await saveVersion(project, 'snapshot before revert', true);
  // Make the working tree exactly match the target commit (checkout -- . alone
  // would leave behind files added after the target).
  await git(project, 'rm', '-rq', '--ignore-unmatch', '.');
  await git(project, 'checkout', target.id, '--', '.');
  const version = await saveVersion(project, `revert to ${target.id.slice(0, 8)} (${target.label})`);
  if (!version) {
    // workspace already matched the target; still surface a marker
    return target;
  }
  return version;
}
