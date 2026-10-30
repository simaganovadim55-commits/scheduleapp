// Забирает из РУЗ (ruz.guz.ru) список всех групп и их расписание и сохраняет в data/*.json.
// GitHub Actions запускает его каждые 3 часа и публикует data/ вместе с сайтом (в git не коммитится).
// Запуск: node scripts/fetch.mjs        (Node 18+)
// Переменные окружения:
//   RUZ_BASE   — адрес сайта вуза (по умолчанию из config.json)
//   PAGES_URL  — адрес опубликованного сайта: если вуз не ответил по группе, берём её прошлую копию оттуда
//   ONLY_CONFIG=1 — выгружать только группы из config.json (быстро, для проверки)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = (process.env.RUZ_BASE || cfg.base || 'https://ruz.guz.ru').replace(/\/$/, '');
const PAGES = (process.env.PAGES_URL || '').replace(/\/$/, '');
const ALL = cfg.allGroups !== false && process.env.ONLY_CONFIG !== '1';
const WEEKS_BACK = cfg.weeksBack ?? 1;
const WEEKS_AHEAD = cfg.weeksAhead ?? 8;
const PARALLEL = cfg.parallel ?? 4;

const pad = n => String(n).padStart(2, '0');
const ruzDate = d => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
const isoDate = s => String(s).slice(0, 10).replace(/\./g, '-');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').trim().toLowerCase();
const listOf = res => (Array.isArray(res) ? res : (res && (res.data || res.items)) || []);

async function get(p, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(BASE + p, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (schedule-miniapp)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${p}: ${e.message}`);
      await sleep(2000 * i);
    }
  }
}

/* ---------- список групп ---------- */
const toGroup = x => ({ id: String(x.id ?? x.groupOid ?? x.oid ?? ''), name: String(x.label ?? x.name ?? x.title ?? '').trim(), desc: String(x.description ?? x.faculty ?? '').trim() });
const search = async term => listOf(await get(`/api/search?term=${encodeURIComponent(term)}&type=group`)).map(toGroup).filter(g => g.id && g.name);

// API поиска может обрезать выдачу (например, до 50 строк). Тогда уточняем запрос
// следующим символом из найденных названий, пока выдача не станет неполной.
async function crawl() {
  const found = new Map(), seen = new Set();
  let requests = 0;
  const run = async term => {
    if (seen.has(term) || requests >= 2500) return null;
    seen.add(term); requests++;
    try { const r = await search(term); r.forEach(g => found.set(g.id, g)); await sleep(120); return r; }
    catch (e) { console.error(`  поиск «${term}»: ${e.message}`); return null; }
  };
  const letters = [...'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ0123456789'];
  let seeds = letters;
  let results = [];
  for (const t of seeds) results.push([t, await run(t)]);
  if (!found.size) { // поиск по одной букве не работает — пробуем годы набора и пары букв
    seeds = [];
    for (let y = 15; y <= 30; y++) seeds.push(`.${y}.`, String(y));
    for (const a of letters.slice(0, 28)) seeds.push(a + '.', '.' + a);
    for (const t of seeds) results.push([t, await run(t)]);
  }
  const lens = results.map(([, r]) => (r ? r.length : 0));
  const max = Math.max(0, ...lens);
  const cap = max >= 10 && lens.filter(n => n === max).length >= 3 ? max : Infinity;
  console.log(`Поиск: ${found.size} групп после ${requests} запросов${cap < Infinity ? `, выдача обрезается до ${cap} — уточняю` : ''}`);
  if (cap < Infinity) {
    const queue = results.filter(([, r]) => r && r.length >= cap).map(([t]) => t);
    while (queue.length && requests < 2500) {
      const t = queue.shift(), k = norm(t);
      const next = new Set();
      for (const g of found.values()) {
        const n = norm(g.name), i = n.indexOf(k);
        if (i >= 0 && i + k.length < n.length) next.add(g.name.slice(i, i + k.length + 1));
      }
      for (const nt of next) {
        if (nt.length > 14) continue;
        const r = await run(nt);
        if (r && r.length >= cap) queue.push(nt);
      }
    }
    console.log(`Поиск: ${found.size} групп после ${requests} запросов`);
  }
  return [...found.values()];
}

async function directory() {
  // если у сайта есть справочник групп целиком — берём его
  for (const p of ['/api/dictionary/groups', '/api/groups']) {
    try {
      const list = listOf(await get(p, 1)).map(toGroup).filter(g => g.id && g.name);
      if (list.length > 20) { console.log(`Справочник ${p}: ${list.length} групп`); return list; }
    } catch {}
  }
  return crawl();
}

async function resolveGroup(g, known) {
  if (typeof g === 'object' && g.id) return { id: String(g.id), name: g.name || String(g.id), desc: '' };
  const name = typeof g === 'object' ? g.name : g;
  const hit = known.find(x => norm(x.name) === norm(name)) ||
    (await search(name)).find(x => norm(x.name) === norm(name));
  if (!hit) throw new Error(`группа «${name}» не найдена`);
  return hit;
}

/* ---------- расписание ---------- */
const lesson = x => ({
  date: isoDate(x.date),
  start: x.beginLesson,
  end: x.endLesson,
  title: x.discipline || x.disciplineName || '',
  kind: x.kindOfWork || '',
  room: x.auditorium || '',
  building: x.building || '',
  teacher: x.lecturer_title || x.lecturer || '',
  subgroup: x.subGroup || '',
  stream: x.stream || '',
  note: x.note || x.comment || '',
});

const today = new Date();
const mon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
const start = new Date(mon); start.setDate(start.getDate() - 7 * WEEKS_BACK);
const finish = new Date(mon); finish.setDate(finish.getDate() + 7 * WEEKS_AHEAD - 1);

async function previous(id) {
  const file = path.join(DATA, 'schedule', `${id}.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  if (!PAGES) return null;
  try {
    const r = await fetch(`${PAGES}/data/schedule/${encodeURIComponent(id)}.json`, { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

await fs.mkdir(path.join(DATA, 'schedule'), { recursive: true });

let groups = [];
if (ALL) {
  try { groups = await directory(); } catch (e) { console.error(`✗ список групп: ${e.message}`); }
}
// группы из config.json выгружаем всегда и первыми
const pinned = [];
for (const g of cfg.groups || []) {
  try { pinned.push(await resolveGroup(g, groups)); }
  catch (e) { console.error(`✗ ${typeof g === 'object' ? g.name || g.id : g}: ${e.message}`); }
}
const byId = new Map();
for (const g of [...pinned, ...groups]) if (!byId.has(g.id)) byId.set(g.id, g);
let all = [...byId.values()];
if (!all.length && PAGES) { // сайт вуза не отвечает вовсе — берём прошлый список групп с опубликованного сайта
  try {
    const r = await fetch(`${PAGES}/data/groups.json`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) all = (await r.json()).map(g => ({ desc: '', ...g }));
    console.log(`Сайт вуза недоступен — беру прошлый список: ${all.length} групп`);
  } catch {}
}
console.log(`Выгружаю расписание: ${all.length} групп, по ${PARALLEL} параллельно`);

const out = [];
let ok = 0, old = 0, failed = 0;
let next = 0;
async function worker() {
  while (next < all.length) {
    const grp = all[next++];
    try {
      const raw = await get(`/api/schedule/group/${encodeURIComponent(grp.id)}?start=${ruzDate(start)}&finish=${ruzDate(finish)}&lng=1`);
      const lessons = listOf(raw).map(lesson).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      await fs.writeFile(path.join(DATA, 'schedule', `${grp.id}.json`),
        JSON.stringify({ group: { id: grp.id, name: grp.name }, updated: new Date().toISOString(), lessons }));
      out.push(grp); ok++;
    } catch (e) {
      const prev = await previous(grp.id);
      if (prev) {
        await fs.writeFile(path.join(DATA, 'schedule', `${grp.id}.json`), JSON.stringify(prev));
        out.push(grp); old++;
      } else failed++;
      console.error(`✗ ${grp.name}: ${e.message}${prev ? ' — оставляю прошлую копию' : ''}`);
    }
    if ((ok + old + failed) % 100 === 0) console.log(`  …${ok + old + failed}/${all.length}`);
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));

out.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
if (out.length) await fs.writeFile(path.join(DATA, 'groups.json'), JSON.stringify(out.map(({ id, name, desc }) => (desc ? { id, name, desc } : { id, name }))));
console.log(`Готово: свежих ${ok}, прошлых копий ${old}, не удалось ${failed} из ${all.length}`);
if (!out.length) process.exit(1);
