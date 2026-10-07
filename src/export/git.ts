import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}
export async function bundleMain(repo: string, output: string): Promise<string> {
  await git(repo, ['bundle', 'create', output, 'refs/heads/main']);
  const heads = await git(repo, ['bundle', 'list-heads', output, 'refs/heads/main']);
  const sha = heads.trim().split(' ')[0];
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Bundle does not contain main');
  return sha;
}
