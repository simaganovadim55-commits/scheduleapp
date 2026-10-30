// Забирает расписание из РУЗ (ruz.guz.ru) и сохраняет в data/*.json для GitHub Pages.
// Запуск: node scripts/fetch.mjs        (Node 18+)
// Переменные окружения: RUZ_BASE — адрес сайта (по умолчанию https://ruz.guz.ru)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = (process.env.RUZ_BASE || cfg.base || 'https://ruz.guz.ru').replace(/\/$/, '');
const WEEKS_BACK = cfg.weeksBack ?? 1;
const WEEKS_AHEAD = cfg.weeksAhead ?? 8;

const pad = n => String(n).padStart(2, '0');
const ruzDate = d => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
const isoDate = s => String(s).slice(0, 10).replace(/\./g, '-');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function resolveGroup(g) {
  if (typeof g === 'object' && g.id) return { id: String(g.id), name: g.name || String(g.id) };
  const name = typeof g === 'object' ? g.name : g;
  const res = await get(`/api/search?term=${encodeURIComponent(name)}&type=group`);
  const list = Array.isArray(res) ? res : res.data || [];
  const norm = s => String(s || '').trim().toLowerCase();
  const hit = list.find(x => norm(x.label ?? x.name) === norm(name)) || list[0];
  if (!hit) throw new Error(`группа «${name}» не найдена`);
  return { id: String(hit.id), name: hit.label ?? hit.name ?? name };
}

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

await fs.mkdir(path.join(DATA, 'schedule'), { recursive: true });
const groupsOut = [];
let ok = 0, changed = 0;

for (const g of cfg.groups) {
  try {
    const grp = await resolveGroup(g);
    groupsOut.push(grp);
    const raw = await get(`/api/schedule/group/${grp.id}?start=${ruzDate(start)}&finish=${ruzDate(finish)}&lng=1`);
    const lessons = (Array.isArray(raw) ? raw : raw.data || []).map(lesson)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const file = path.join(DATA, 'schedule', `${grp.id}.json`);
    let old = null;
    try { old = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
    if (old && JSON.stringify(old.lessons) === JSON.stringify(lessons)) {
      console.log(`= ${grp.name}: без изменений (${lessons.length} пар)`);
    } else {
      await fs.writeFile(file, JSON.stringify({ group: grp, updated: new Date().toISOString(), lessons }, null, 1));
      console.log(`✓ ${grp.name}: обновлено (${lessons.length} пар)`);
      changed++;
    }
    ok++;
  } catch (e) {
    console.error(`✗ ${typeof g === 'object' ? g.name || g.id : g}: ${e.message} — оставляю старые данные`);
    // если группу раньше уже находили — оставляем её в списке
    try {
      const prev = JSON.parse(await fs.readFile(path.join(DATA, 'groups.json'), 'utf8'));
      const name = typeof g === 'object' ? g.name : g;
      const p = prev.find(x => x.name === name || x.id === String(g.id));
      if (p) groupsOut.push(p);
    } catch {}
  }
  await sleep(500);
}

if (groupsOut.length) await fs.writeFile(path.join(DATA, 'groups.json'), JSON.stringify(groupsOut, null, 1));
console.log(`Готово: ${ok}/${cfg.groups.length} групп, изменилось ${changed}`);
if (ok === 0) process.exit(1);
