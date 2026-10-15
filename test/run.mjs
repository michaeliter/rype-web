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
import { readIds } from './util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(path.resolve(root, process.env.CASES || 'test/cases.json'), 'utf8')); // CASES=test/perf-cascade.json for perf runs
const filter = process.argv[2] || '';
const chrome = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('no Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }

const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn('node', ['serve.mjs', String(port), '.'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((r) => setTimeout(r, 500));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 0, args: ['--no-sandbox', '--js-flags=--max-old-space-size=8192'] });
let failed = 0, ran = 0;
try {
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    const missing = (c.requires || []).filter((f) => !fs.existsSync(path.resolve(root, f.replace(/^~/, process.env.HOME))));
    if (missing.length) { console.log(`SKIP ${c.name}: missing ${missing.join(', ')}`); continue; }
    ran++;
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    const t0 = Date.now();
    const demo = c.uploads ? 'manual' : '1';
    await page.goto(`http://localhost:${port}/web/index.html?demo=${demo}&${c.query}&v=${Date.now()}`);
    if (c.uploads) { // real disk-backed Files via the pickers, as a user would (paths may be absolute)
      const abs = (f) => path.resolve(root, f.replace(/^~/, process.env.HOME));
      for (const [id, files] of Object.entries(c.uploads)) {
        const el = await page.$('#' + id); await el.uploadFile(...[].concat(files).map(abs));
        await el.evaluate((e) => e.dispatchEvent(new Event('change', { bubbles: true }))); // a webkitdirectory input gets no change event from DOM.setFileInputFiles
      }
      if (c.clear) { // the × beside a picker empties it without a reload; re-upload afterwards
        const el = await page.$('#' + c.clear);
        await page.click(`button[data-clear=${c.clear}]`);
        const n = await el.evaluate((e) => e.files.length); if (n) logs.push(`clear: #${c.clear} still has ${n} file(s)`);
        await el.uploadFile(...[].concat(c.uploads[c.clear]).map(abs)); await el.evaluate((e) => e.dispatchEvent(new Event('change', { bubbles: true })));
      }
      await page.evaluate(() => window.__start());
      const idxStatus = await page.evaluate(() => document.getElementById('idxStatus').textContent);
      logs.push('index status after upload: ' + idxStatus);
    }
    if (c.cancel) { // cancel mid-run, then start again: the rerun must produce the full, correct result
      // true: after the first progress message, so batches are really in flight; string: once
      // a stage whose name starts with it reports progress, e.g. "minimap2" (stages are named "minimap2 parts 1,2 of 5"). ('Running…' is shown before the run is even posted.)
      await page.waitForFunction((w) => { const p = window.__progress; return !!window.__error || (!!p && (w === true ? p.total > 0 : (p.stage || '').startsWith(w))); }, { timeout: 600000 }, c.cancel);
      const st = await page.evaluate(async () => { const early = !!window.__result; await window.__cancel(); return { early, status: document.getElementById('runStatus').textContent, cancelHidden: document.getElementById('cancel').hidden, runDisabled: document.getElementById('run').disabled }; });
      if (st.early) logs.push('cancel: run already finished before cancel');
      if (st.status !== 'Cancelled.' || !st.cancelHidden || !st.runDisabled) logs.push('cancel: unexpected UI state ' + JSON.stringify(st));
      await page.evaluate(() => { window.__result = null; window.__start(); });
    }
    try {
      await page.waitForFunction('window.__result || window.__error', { timeout: (c.timeoutSec || 300) * 1000, polling: 500 });
      if (c.rerun) { // a second job in the same page: the worker must bring back what it released after a two-pass run
        await page.evaluate(() => { window.__result = null; window.__start(); });
        await page.waitForFunction('window.__result || window.__error', { timeout: (c.timeoutSec || 300) * 1000, polling: 500 });
      }
    }
    catch (e) { const st = await page.evaluate(() => [document.getElementById('idxStatus').textContent, document.getElementById('runStatus').textContent].join(' | ')); failed++; console.log(`FAIL ${c.name}: timed out; status: ${st}; console: ${logs.slice(-5).join(' | ')}`); await page.close(); continue; }
    const r = await page.evaluate(async (check) => { // hash only when the case checks outputs: a multi-GB file cannot be read whole
      if (window.__error) return { error: String(window.__error) };
      const files = [];
      for (const f of window.__files) {
        if (!check) { files.push({ name: f.name, size: f.size }); continue; }
        const buf = new Uint8Array(await f.arrayBuffer());
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
        files.push({ name: f.name, size: f.size, sha256: hash, text: f.size < 50e6 && !/\.gz$/.test(f.name) ? new TextDecoder().decode(buf) : null });
      }
      return { ...window.__result, phases: window.__phases, files, log: window.__log || [] };
    }, !!(c.expect && c.expect.files));
    await page.close();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const problems = [];
    if (r.error) problems.push(`error: ${r.error}`);
    else {
      const e = c.expect || {};
      for (const k of ['total', 'affected', 'rypeRemoved', 'mmRemoved', 'readType', 'threshold']) if (e[k] != null && r[k] !== e[k]) problems.push(`${k}: got ${r[k]}, want ${e[k]}`);
      if (e.files) e.files.forEach((ef, i) => {
        const f = r.files[i];
        if (!f) return problems.push(`file ${i} missing`);
        if (ef.name && f.name !== ef.name) problems.push(`file ${i} name: ${f.name} != ${ef.name}`);
        if (ef.size != null && f.size !== ef.size) problems.push(`${f.name} size: ${f.size} != ${ef.size}`);
        if (ef.sha256 && f.sha256 !== ef.sha256) problems.push(`${f.name} sha256: ${f.sha256.slice(0, 12)} != ${ef.sha256.slice(0, 12)}`);
        if (ef.sha256_of) { const want = sha256(fs.readFileSync(path.join(root, ef.sha256_of))); if (f.sha256 !== want) problems.push(`${f.name} differs from ${ef.sha256_of}`); }
        if (ef.ids_equal) { // output read ids (in order) == the listed file's lines
          const want = fs.readFileSync(path.resolve(root, ef.ids_equal.replace(/^~/, process.env.HOME)), 'utf8').split('\n').filter(Boolean), got = f.text ? readIds(f.text) : [];
          if (want.length !== got.length || want.some((id, j) => id !== got[j])) problems.push(`${f.name}: read ids differ (${got.length} vs ${want.length} expected): got ${got.slice(0, 3)}`);
        }
        if (ef.ids_equal_complement_of) { // output read ids == all input ids minus the listed truth sets
          const all = readIds(fs.readFileSync(path.join(root, ef.ids_equal_complement_of.input), 'utf8'));
          const drop = new Set(ef.ids_equal_complement_of.truth.flatMap((t) => fs.readFileSync(path.join(root, t), 'utf8').split('\n').filter(Boolean)));
          const want = all.filter((id) => !drop.has(id)), got = f.text ? readIds(f.text) : [];
          if (want.length !== got.length || want.some((id, j) => id !== got[j])) problems.push(`${f.name}: read ids differ (${got.length} vs ${want.length} expected)`);
        }
      });
      if (r.hist) { // the report's histogram must account for every record, and its bins at/above the threshold are exactly rype's removals
        const sum = r.hist.reduce((a, b) => a + b, 0), above = r.hist.reduce((a, n, b) => a + (b >= 1 && (b - 1) / 100 >= r.threshold - 1e-9 ? n : 0), 0), rype = r.rypeRemoved ?? r.affected;
        if (sum !== r.total) problems.push(`hist sums to ${sum}, total ${r.total}`);
        if (above !== rype) problems.push(`hist bins >= threshold hold ${above}, rype removed ${rype}`);
        if (r.histMm) { // minimap2's removals are attributed to the bins rype kept, and only those
          const mmSum = r.histMm.reduce((a, b) => a + b, 0), inRemoved = r.histMm.reduce((a, n, b) => a + (b >= 1 && (b - 1) / 100 >= r.threshold - 1e-9 ? n : 0), 0);
          if (mmSum !== r.mmRemoved) problems.push(`histMm sums to ${mmSum}, minimap2 removed ${r.mmRemoved}`);
          if (inRemoved) problems.push(`histMm attributes ${inRemoved} minimap2 removals to bins rype already removed`);
        }
      }
      if (e.log_includes && !r.log.some((l) => l.includes(e.log_includes))) problems.push(`log lacks "${e.log_includes}"`);
      for (const l of logs) if (/^(cancel|clear):/.test(l)) problems.push(l);
    }
    if (problems.length) { failed++;
      const dump = path.join(root, 'scratch/test-out', c.name); fs.mkdirSync(dump, { recursive: true });
      for (const f of r.files || []) if (f.text) fs.writeFileSync(path.join(dump, f.name), f.text);
      problems.push(`outputs saved under scratch/test-out/${c.name}`); console.log(`FAIL ${c.name} (${secs}s)\n  ` + problems.join('\n  ') + `\n  result: total=${r.total} affected=${r.affected} rype=${r.rypeRemoved} mm=${r.mmRemoved} files=${(r.files || []).map((f) => `${f.name}:${f.size}B${f.text ? '/' + readIds(f.text).length + 'rec' : ''}`).join(' ')}` + (logs.length ? '\n  console: ' + logs.slice(-5).join(' | ') : '')); }
    else console.log(`ok   ${c.name} (${secs}s) total=${r.total} removed=${r.affected}` + (r.rypeRemoved != null ? ` (rype ${r.rypeRemoved}, minimap2 ${r.mmRemoved})` : '') + ` elapsed=${(r.elapsedMs / 1000).toFixed(1)}s` + (r.phases ? ` phases=${JSON.stringify(r.phases)}` : ''));
  }
} finally {
  await browser.close(); server.kill();
}
console.log(`${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
