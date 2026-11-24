#!/usr/bin/env node
import { appendFileSync, writeFileSync, lstatSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'hutong236/hulane-opencode';
const TOTAL = 28;
export function codeOf(issue) {
  const match = /^\[WB-(\d{3})\]/.exec(issue.title ?? '');
  const n = Number(match?.[1]);
  return n >= 1 && n <= TOTAL ? n : null;
}
export function dependencies(issue) {
  const section = /^##\s*(?:前置依赖|依赖)\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/m.exec(issue.body ?? '')?.[1] ?? '';
  return [...section.matchAll(/WB-(\d{3})/g)].map(x => Number(x[1]));
}
export function selectWork(issues, prs, runs) {
  const tasks = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const number = codeOf(issue);
    if (number === null) continue;
    if (tasks.has(number)) throw new Error(`Duplicate WB-${String(number).padStart(3, '0')} issue`);
    tasks.set(number, issue);
  }
  const missing = Array.from({ length: TOTAL }, (_, i) => i + 1).filter(n => !tasks.has(n));
  if (missing.length) throw new Error(`Missing Workbench issues: ${missing.join(',')}`);
  const pending = [];
  for (const [id, issue] of [...tasks].sort((a,b) => a[0]-b[0])) {
    if (issue.state !== 'open') continue;
    const blocked = dependencies(issue).filter(n => tasks.get(n)?.state !== 'closed');
    if (blocked.length) { pending.push(`WB-${id}: blocked by ${blocked.join(',')}`); continue; }
    const code = `WB-${String(id).padStart(3,'0')}`;
    const related = prs.filter(pr => pr.state === 'open' && (pr.title?.includes(code) || pr.body?.includes(code)));
    if (related.length > 1) { pending.push(`${code}: multiple open PRs`); continue; }
    if (related.length === 1) {
      const pr = related[0];
      const safeBranch = new RegExp(`^(?:feat|autodev)/${code}-[a-z0-9-]+$`).test(pr.head?.ref ?? '');
      if (pr.head?.repo?.full_name !== REPO || !safeBranch) {
        pending.push(`${code}: PR #${pr.number} is not a trusted task branch`); continue;
      }
      const checks = runs.filter(r => r.head_sha === pr.head.sha && /^(Hulane OpenCode CI|Workbench CI)/.test(r.name));
      if (checks.some(c => ['in_progress','queued','waiting'].includes(c.status))) {
        pending.push(`${code}: CI pending for PR #${pr.number}`); continue;
      }
      if (checks.length && checks.every(c => c.conclusion === 'success')) {
        pending.push(`${code}: PR #${pr.number} awaiting review`); continue;
      }
      return { mode:'repair',id,code,issue,branch:pr.head.ref,pr:pr.number,reason:'Failed or missing CI' };
    }
    return { mode:'new',id,code,issue,branch:`feat/${code}-autodev`,pr:0,reason:'Dependencies closed' };
  }
  return { mode:'wait',reason:pending.slice(0,8).join('; ')||'All 28 issues closed' };
}
async function gh(path) {
  if (!process.env.GH_TOKEN) throw new Error('Missing read-only GH_TOKEN');
  const response = await fetch(`https://api.github.com${path}`, {
    headers:{ Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28' },
    signal:AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: HTTP ${response.status}`);
  return response.json();
}
async function pages(path) {
  const result=[];
  for (let p=1;p<=10;p++) {
    const rows=await gh(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);
    if (!Array.isArray(rows)) throw new Error('Unexpected GitHub response');
    result.push(...rows);
    if (rows.length<100) return result;
  }
  throw new Error('GitHub pagination limit reached');
}
function output(name,value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`${name}=${value}\n`);
}
function summary(msg) {
  console.log(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`${msg}\n`);
}
async function select() {
  if (REPO!=='hutong236/hulane-opencode') throw new Error('Wrong repository');
  const [issues,prs,runs]=await Promise.all([
    pages(`/repos/${REPO}/issues?state=all`),
    pages(`/repos/${REPO}/pulls?state=open`),
    gh(`/repos/${REPO}/actions/runs?per_page=100`),
  ]);
  const choice=selectWork(issues,prs,runs.workflow_runs??[]);
  output('action',choice.mode);
  if (choice.mode==='wait') { summary(`No safe task selected: ${choice.reason}`); return; }
  writeFileSync(`${process.env.RUNNER_TEMP||'/tmp'}/workbench-autodev-issue.md`,
    `# ${choice.code}: ${choice.issue.title}\n\nSource: ${choice.issue.html_url}\n\n${choice.issue.body||''}\n`);
  for (const key of ['code','branch','pr']) output(key,choice[key]);
  output('issue',choice.issue.number);
  summary(`Selected ${choice.code}: ${choice.mode} on ${choice.branch}; PR=${choice.pr||'new'}. ${choice.reason}`);
}
export function changedFiles() {
  const modified=execFileSync('git',['diff','--name-only','-z','HEAD'],{encoding:'utf8'}).split('\0');
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0');
  return [...new Set([...modified,...untracked].filter(Boolean))];
}
export function validatePaths(paths) {
  if (paths.length>30) throw new Error('More than 30 changed files: manual review required');
  for (const path of paths) {
    if (!(path.startsWith('workbench/')||path==='docs/SESSION_HANDOFF.md')) throw new Error(`Denied edit: ${path}`);
    if (/(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|(?:secret|credential|private.?key)/i.test(path))
      throw new Error(`Secret-like file path is not permitted: ${path}`);
    if (existsSync(path)&&lstatSync(path).isSymbolicLink()) throw new Error(`Symlink edit denied: ${path}`);
  }
  return true;
}
const PROTECTED_SCRIPTS=/^(?:test(?::[a-z0-9-]+)?|lint|typecheck|build)$/;
// Files that decide how the change is judged. Only tracked ones count: a new package brings its own configuration.
const isProtectedFile=path=>/(^|\/)tsconfig[^/]*\.json$/.test(path)||[
  'workbench/playwright.config.ts','workbench/scripts/lint.mjs','workbench/.gitignore'].includes(path);
/** An autonomous change may add or edit files, never remove the checks that judge it. */
export function validateNoWeakening({deleted=[],scripts=[],protectedFiles=[]}={}) {
  if (deleted.length) throw new Error(`Deleting files is not permitted: ${deleted.join(', ')}`);
  if (scripts.length) throw new Error(`Test, lint, typecheck and build scripts may not change: ${scripts.join(', ')}`);
  if (protectedFiles.length) throw new Error(`Test configuration may not change: ${protectedFiles.join(', ')}`);
  return true;
}
/** Protected scripts that a committed manifest defined and the change removed or redefined; a new script weakens nothing. */
export function weakenedScripts(before,after) {
  return Object.keys(before??{}).filter(name=>PROTECTED_SCRIPTS.test(name)&&JSON.stringify(before[name])!==JSON.stringify(after?.[name]));
}
const scriptsOf=(path,source)=>{
  try { return JSON.parse(source).scripts??{}; }
  catch { throw new Error(`Package manifest is not valid JSON: ${path}`); }
};
const committed=path=>{
  try { return execFileSync('git',['show',`HEAD:${path}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']}); }
  catch { return null; }
};
const gitLines=args=>execFileSync('git',args,{encoding:'utf8'}).split('\0').filter(Boolean);
function verify() {
  const files=changedFiles();
  validatePaths(files);
  const size=files.reduce((n,f)=>n+(existsSync(f)?lstatSync(f).size:0),0);
  if (size>1200000) throw new Error('Modified payload exceeds 1.2MB');
  validateNoWeakening({
    deleted:gitLines(['diff','--name-only','--diff-filter=D','-z','HEAD']),
    scripts:files.filter(f=>/(^|\/)package\.json$/.test(f)).flatMap(f=>{
      const before=committed(f);
      return before===null?[]:weakenedScripts(scriptsOf(f,before),scriptsOf(f,readFileSync(f,'utf8')));
    }),
    protectedFiles:files.filter(f=>isProtectedFile(f)&&committed(f)!==null),
  });
  output('changed',files.length?'true':'false');
  summary(`Change scope valid: ${files.length} files; ${size} bytes; no deletion, test script or test configuration change; ${files.join(', ')}`);
}
if (process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) {
  (process.argv[2]==='select'?select():process.argv[2]==='verify'?Promise.resolve(verify()):Promise.reject(new Error('usage: select|verify')))
    .catch(e=>{console.error(e);process.exitCode=1});
}
