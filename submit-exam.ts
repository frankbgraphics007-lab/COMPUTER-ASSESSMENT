// Supabase Edge Function: submit-exam
// Grades an exam ON THE SERVER (the answers never reach the student's browser) and saves the result.
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function -> name it exactly: submit-exam

const SB = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const rest = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  const t = await r.text();           // empty body is normal after an insert
  return t ? JSON.parse(t) : null;
};

// ---------- marking (same rules as the exam page) ----------
const clean = (s: any) => (s == null ? '' : String(s)).trim().toLowerCase().replace(/\s+/g, ' ');
const pv = (s: any, b: number) => { s = clean(s).replace(/ /g, ''); if (!s) return NaN; for (const c of s) if (isNaN(parseInt(c, b))) return NaN; return parseInt(s, b); };
const nz = (s: any) => clean(s).replace(/[, ]/g, '');
const eq = (x: any, y: any) => clean(x) === clean(y) || (nz(x) !== '' && nz(y) !== '' && isFinite(+nz(x)) && isFinite(+nz(y)) && +nz(x) === +nz(y));

function grade(q: any, a: any) {
  a = Array.isArray(a) ? a : [];
  let e = 0, g = '', c = '';
  const m = q.marks;
  switch (q.type) {
    case 'mcq': e = a[0] != null && a[0] == q.answer ? m : 0; g = a[0] != null ? q.options[a[0]] : ''; c = q.options[q.answer]; break;
    case 'tf': e = a[0] == String(q.answer) ? m : 0; g = a[0] ? (a[0] == 'true' ? 'True' : 'False') : ''; c = q.answer ? 'True' : 'False'; break;
    case 'fill': { let k = 0; q.answers.forEach((x: any, i: number) => { if ([].concat(x).some((y: any) => eq(y, a[i]))) k++; }); e = m * k / q.answers.length; g = a.filter(Boolean).join(' | '); c = q.answers.map((x: any) => [].concat(x)[0]).join(' | '); break; }
    case 'match': { let k = 0; q.pairs.forEach((p: any, i: number) => { if (a[i] === p[1]) k++; }); e = m * k / q.pairs.length; g = q.pairs.map((p: any, i: number) => `${p[0]} → ${a[i] || '?'}`).join('; '); c = q.pairs.map((p: any) => `${p[0]} → ${p[1]}`).join('; '); break; }
    case 'convert': { const x = pv(q.value, q.from), y = pv(a[0], q.to), L = clean(a[0]).replace(/ /g, '').length; e = (x === y && (!q.bits || L == q.bits)) ? m : 0; g = a[0] || ''; c = x.toString(q.to).toUpperCase().padStart(q.bits || 0, '0'); break; }
    case 'multi': { const cor = new Set(q.answers), sel = q.options.map((_: any, i: number) => i).filter((i: number) => a[i] == '1'), hit = sel.filter((i: number) => cor.has(i)).length; e = m * Math.max(0, hit - (sel.length - hit)) / cor.size; g = sel.map((i: number) => q.options[i]).join('; '); c = q.answers.map((i: number) => q.options[i]).join('; '); break; }
    case 'order': { let k = 0; const arr: string[] = []; q.items.forEach((x: any, i: number) => { if (+a[i] === q.correct.indexOf(x) + 1) k++; if (a[i]) arr[+a[i] - 1] = (arr[+a[i] - 1] ? arr[+a[i] - 1] + ' / ' : '') + x; }); e = m * k / q.items.length; g = arr.filter(Boolean).join(' → '); c = q.correct.join(' → '); break; }
    case 'sort': { let k = 0; q.items.forEach((x: any, i: number) => { if (a[i] === x.g) k++; }); e = m * k / q.items.length; g = q.items.map((x: any, i: number) => `${x.t} → ${a[i] || '?'}`).join('; '); c = q.items.map((x: any) => `${x.t} → ${x.g}`).join('; '); break; }
    case 'binadd': { const s = pv(q.a, 2) + pv(q.b, 2); e = pv(a[0], 2) === s ? m : 0; g = a[0] || ''; c = s.toString(2); break; }
    default: { e = [].concat(q.answer).some((y: any) => q.tol != null ? (nz(a[0]) !== '' && isFinite(+nz(a[0])) && Math.abs(+nz(a[0]) - +nz(y)) <= q.tol + 1e-9) : q.exact ? clean(y).replace(/ /g, '') === clean(a[0]).replace(/ /g, '') : eq(y, a[0])) ? m : 0; g = a[0] || ''; c = [].concat(q.answer)[0]; }
  }
  return { id: q.id, e: Math.round(e * 100) / 100, g: String(g), c: String(c) };
}
const gl = (p: number) => p >= 75 ? 'A' : p >= 60 ? 'B' : p >= 50 ? 'C' : p >= 40 ? 'D' : 'F';

const view = (row: any, reveal: boolean) => ({
  raw: row.raw, pen: row.pen, total: row.total, pct: row.pct, grade: row.grade, tabs: row.tabs, secs: row.secs, reveal,
  R: (row.detail || []).map((r: any) => reveal ? r : { id: r.id, g: r.g }),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, msg: 'POST only' }, 405);
  try {
    const b = await req.json();
    const aid = String(b.aid || '').slice(0, 80);
    const s = b.student || {};
    const name = String(s.name || '').trim().slice(0, 120), cand = String(s.cand || '').trim().slice(0, 120), cls = String(s.cls || '').trim().slice(0, 120);
    if (!aid || !name || !cand || !cls) return json({ ok: false, fatal: true, msg: 'Missing student details.' }, 400);
    if (JSON.stringify(b.answers || {}).length > 80000) return json({ ok: false, fatal: true, msg: 'Answers too large.' }, 400);

    const q1 = (x: string) => encodeURIComponent(x);
    // Roster check: when a roster exists, only ACTIVE listed students may submit.
    const anyRoster = await rest('roster?select=id&limit=1');
    if (anyRoster && anyRoster.length) {
      const ok = await rest(`roster?active=eq.true&name=ilike.${q1(name.replace(/[%_*]/g, '').replace(/\s+/g, ' '))}&select=id&limit=1`);
      if (!ok || !ok.length) return json({ ok: false, fatal: true, msg: 'Your name is not on the class list. Tell your teacher.' }, 403);
    }
    const keyRows = await rest(`exam_keys?aid=eq.${q1(aid)}&select=data`);
    if (!keyRows.length) return json({ ok: false, fatal: true, msg: 'This exam was not found. Tell your teacher.' }, 404);
    const [metaRows, setRows] = await Promise.all([
      rest(`assessments?id=eq.${q1(aid)}&select=meta`),
      rest(`settings?key=eq.reveal&select=value`),
    ]);
    const reveal = !!(setRows[0] && setRows[0].value === true);
    const meta = (metaRows[0] && metaRows[0].meta) || {};
    const EX = keyRows[0].data;

    const skey = [name, cand, cls].map((x) => x.toLowerCase().replace(/\s+/g, ' ')).join('|');

    // Already submitted? (page reloaded, or the first reply was lost) -> return the stored result.
    const done = await rest(`results?aid=eq.${q1(aid)}&skey=eq.${q1(skey)}&select=raw,pen,total,pct,grade,tabs,secs,detail`);
    if (done.length) return json({ ok: true, info: view(done[0], reveal), dup: true });

    // mark
    let n = 0, TOTAL = 0; const Q: any[] = [];
    EX.sections.forEach((sec: any, si: number) => sec.questions.forEach((q: any, qi: number) => { q.id = `q${si}_${qi}`; q.n = ++n; TOTAL += q.marks; Q.push(q); }));
    const answers = b.answers || {};
    const R = Q.map((q) => grade(q, answers[q.id]));
    const secs = EX.sections.map((sec: any) => [
      sec.name,
      Math.round(sec.questions.reduce((t: number, q: any) => t + R.find((r) => r.id == q.id)!.e, 0) * 100) / 100,
      sec.questions.reduce((t: number, q: any) => t + q.marks, 0),
    ]);
    const raw = Math.round(R.reduce((t, r) => t + r.e, 0) * 100) / 100;
    const pen = Math.min(Math.max(0, +b.pen || 0), raw);
    const tabs = Math.min(Math.max(0, Math.floor(+b.tabs || 0)), 1000);
    const total = Math.max(0, Math.round((raw - pen) * 100) / 100);
    const pct = Math.round(total / TOTAL * 100);
    const row = {
      aid, title: meta.title || EX.title || '', year: meta.year || null, skey, name, cand, cls,
      raw, pen, total, max_marks: TOTAL, pct, grade: gl(pct), tabs, secs, detail: R,
      log: (Array.isArray(b.log) ? b.log : []).slice(-40).map((x: any) => String(x).slice(0, 200)),
    };
    const ins = await rest('results?on_conflict=aid,skey', {
      method: 'POST', body: JSON.stringify(row),
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    });
    return json({ ok: true, info: view(row, reveal) });
  } catch (e) {
    return json({ ok: false, msg: 'Server busy, retrying.' }, 500);
  }
});
