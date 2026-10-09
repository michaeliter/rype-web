// Headless end-to-end tests: start the Range-capable dev server, drive the page
// through its ?demo= hook in headless Chrome, and check counts and SHA-256 of the
// outputs against native-tool truth recorded in test/cases.json.
//   node test/run.mjs [case-name-filter]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/cases.json'), 'utf8'));
const filter = process.argv[2] || '';
const chrome = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn('node', ['serve.mjs', String(port), '.'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((r) => setTimeout(r, 500));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readIds = (text) => text.split('\n').filter((l, i) => i % 4 === 0 && l).map((l) => l.slice(1).split(/\s/)[0].replace(/\/[12]$/, ''));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--js-flags=--max-old-space-size=8192'] });
let failed = 0, ran = 0;
try {
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    const missing = (c.requires || []).filter((f) => !fs.existsSync(path.join(root, f)));
    if (missing.length) { console.log(`SKIP ${c.name}: missing ${missing.join(', ')}`); continue; }
    ran++;
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/web/index.html?demo=1&${c.query}&v=${Date.now()}`);
    await page.waitForFunction('window.__result || window.__error', { timeout: (c.timeoutSec || 300) * 1000, polling: 500 });
    const r = await page.evaluate(async () => {
      if (window.__error) return { error: String(window.__error) };
      const files = [];
      for (const f of window.__files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
        files.push({ name: f.name, size: f.size, sha256: hash, text: f.size < 50e6 && !/\.gz$/.test(f.name) ? new TextDecoder().decode(buf) : null });
      }
      return { ...window.__result, files, log: window.__log || [] };
    });
    await page.close();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const problems = [];
    if (r.error) problems.push(`error: ${r.error}`);
    else {
      const e = c.expect || {};
      for (const k of ['total', 'affected', 'rypeRemoved', 'mmRemoved']) if (e[k] != null && r[k] !== e[k]) problems.push(`${k}: got ${r[k]}, want ${e[k]}`);
      if (e.files) e.files.forEach((ef, i) => {
        const f = r.files[i];
        if (!f) return problems.push(`file ${i} missing`);
        if (ef.name && f.name !== ef.name) problems.push(`file ${i} name: ${f.name} != ${ef.name}`);
        if (ef.size != null && f.size !== ef.size) problems.push(`${f.name} size: ${f.size} != ${ef.size}`);
        if (ef.sha256 && f.sha256 !== ef.sha256) problems.push(`${f.name} sha256: ${f.sha256.slice(0, 12)} != ${ef.sha256.slice(0, 12)}`);
        if (ef.sha256_of) { const want = sha256(fs.readFileSync(path.join(root, ef.sha256_of))); if (f.sha256 !== want) problems.push(`${f.name} differs from ${ef.sha256_of}`); }
        if (ef.ids_equal_complement_of) { // output read ids == all input ids minus the listed truth sets
          const all = readIds(fs.readFileSync(path.join(root, ef.ids_equal_complement_of.input), 'utf8'));
          const drop = new Set(ef.ids_equal_complement_of.truth.flatMap((t) => fs.readFileSync(path.join(root, t), 'utf8').split('\n').filter(Boolean)));
          const want = all.filter((id) => !drop.has(id)), got = f.text ? readIds(f.text) : [];
          if (want.length !== got.length || want.some((id, j) => id !== got[j])) problems.push(`${f.name}: read ids differ (${got.length} vs ${want.length} expected)`);
        }
      });
      if (e.log_includes && !r.log.some((l) => l.includes(e.log_includes))) problems.push(`log lacks "${e.log_includes}"`);
    }
    if (problems.length) { failed++;
      const dump = path.join(root, 'scratch/test-out', c.name); fs.mkdirSync(dump, { recursive: true });
      for (const f of r.files || []) if (f.text) fs.writeFileSync(path.join(dump, f.name), f.text);
      problems.push(`outputs saved under scratch/test-out/${c.name}`); console.log(`FAIL ${c.name} (${secs}s)\n  ` + problems.join('\n  ') + `\n  result: total=${r.total} affected=${r.affected} rype=${r.rypeRemoved} mm=${r.mmRemoved} files=${(r.files || []).map((f) => `${f.name}:${f.size}B${f.text ? '/' + readIds(f.text).length + 'rec' : ''}`).join(' ')}` + (logs.length ? '\n  console: ' + logs.slice(-5).join(' | ') : '')); }
    else console.log(`ok   ${c.name} (${secs}s) total=${r.total} removed=${r.affected}`);
  }
} finally {
  await browser.close(); server.kill();
}
console.log(`${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
