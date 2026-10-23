// Downloads daily price history for every stock listed in index.html and writes
// it to data/<symbol>.json, so the site can load real charts from its own
// origin instead of going through slow, unreliable public CORS proxies.
// Run by the Pages workflow (Node 20+, no dependencies): node scripts/fetch-data.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const OUT = 'data';
const FRESH_MS = 6 * 864e5;           // re-download files older than this
const START = Date.UTC(2010, 0, 1) / 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The stock list lives in index.html (const MKT={...};) — read it from there.
const html = readFileSync('index.html', 'utf8');
const src = html.match(/const MKT=(\{[\s\S]*?\n\});/);
if (!src) throw new Error('MKT not found in index.html');
const MKT = vm.runInNewContext('(' + src[1] + ')');

const ySym = (t, mk) => mk === 'kos' ? t + '.KS' : mk === 'kosd' ? t + '.KQ' : t;
const fileOf = sym => `${OUT}/${sym}.json`;

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return r;
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}

// Yahoo chart API → [{t:'YYYY-MM-DD',o,h,l,c,v}] (prices are split-adjusted)
async function yahoo(sym) {
  const p2 = Math.floor(Date.now() / 1000);
  for (const host of ['query2', 'query1']) {
    const r = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${START}&period2=${p2}&interval=1d`);
    if (!r) continue;
    try {
      const res = (await r.json()).chart.result[0];
      const q = res.indicators.quote[0], ts = res.timestamp || [], off = (res.meta && res.meta.gmtoffset) || 0;
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null || !(x > 0))) continue;
        const t = new Date((ts[i] + off) * 1000).toISOString().slice(0, 10);
        const row = { t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: (q.volume && q.volume[i]) || 0 };
        if (rows.length && rows[rows.length - 1].t === t) rows[rows.length - 1] = row; else rows.push(row);
      }
      if (rows.length > 100) return rows;
    } catch { /* try next host */ }
  }
  return null;
}

// Naver chart (Korean stocks, adjusted prices) → same row format
async function naver(code) {
  const r = await get(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=5000&requestType=0`);
  if (!r) return null;
  const xml = new TextDecoder('euc-kr').decode(await r.arrayBuffer());
  const rows = [];
  for (const m of xml.matchAll(/data="(\d{8})\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)"/g)) {
    const t = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
    if (t < '2010-01-01') continue;
    const [o, h, l, c, v] = m.slice(2).map(Number);
    if (o > 0 && h > 0 && l > 0 && c > 0) rows.push({ t, o, h, l, c, v });
  }
  return rows.length > 100 ? rows : null;
}

// Compact file: rows of [days since previous row, open, high, low, close, volume],
// prices as integers scaled by k (cents for USD, won for KRW).
function encode(sym, rows, k) {
  const day = t => Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) / 864e5;
  let prev = day(rows[0].t);
  const r = rows.map(x => { const d = day(x.t), dd = d - prev; prev = d;
    return [dd, Math.round(x.o * k), Math.round(x.h * k), Math.round(x.l * k), Math.round(x.c * k), Math.round(x.v)]; });
  return JSON.stringify({ v: 1, sym, u: Date.now(), d0: rows[0].t, k, r });
}

mkdirSync(OUT, { recursive: true });
const manifest = {};
let fetched = 0, kept = 0, failed = [];
for (const [mk, m] of Object.entries(MKT)) {
  manifest[mk] = [];
  const kr = mk === 'kos' || mk === 'kosd';
  for (const s of m.s) {
    const sym = ySym(s.t, mk), f = fileOf(sym);
    if (existsSync(f)) {
      try { if (Date.now() - JSON.parse(readFileSync(f, 'utf8')).u < FRESH_MS) { manifest[mk].push(s.t); kept++; continue; } } catch {}
    }
    let rows = await yahoo(sym);
    // some codes in the lists sit on the other Korean exchange; Naver needs no suffix at all
    if (!rows && kr) rows = await yahoo(ySym(s.t, mk === 'kos' ? 'kosd' : 'kos'));
    if (!rows && kr) rows = await naver(s.t);
    if (rows) { writeFileSync(f, encode(sym, rows, kr ? 1 : 100)); manifest[mk].push(s.t); fetched++; }
    else if (existsSync(f)) { manifest[mk].push(s.t); kept++; }   // keep an older copy rather than nothing
    else failed.push(sym);
    await sleep(250);
  }
}
writeFileSync(`${OUT}/index.json`, JSON.stringify({ u: Date.now(), ...manifest }));
console.log(`downloaded ${fetched}, kept ${kept}, failed ${failed.length}${failed.length ? ': ' + failed.join(' ') : ''}`);
