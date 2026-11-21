// Push-optimal Sokoban solver. A level is a hallway with rooms off it; a box
// pushed out of its room never comes back, so each room is solved alone with
// a push-based A* (cost = pushes; heuristic = cheapest box-to-goal assignment
// by Manhattan distance, plus dead-cell pruning) and the rooms are stitched
// together with hallway walks. Fixed expansion budgets only, never the clock,
// so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const CAP = 400_000, CAP2 = 1_600_000;
const D = [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']] as const;
type C = number;
interface L { w: number; h: number; wl: Uint8Array; gl: Set<C>; bx: C[]; pl: C }
function parse(t: string): L {
  const r = t.split('\n').filter(x => x.length);
  const w = Math.max(...r.map(x => x.length)), h = r.length, wl = new Uint8Array(w * h).fill(1);
  const gl = new Set<C>(), bx: C[] = [];
  let pl = -1;
  r.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const c = row[x]!, i = y * w + x; if (c === '#') continue; wl[i] = 0; if ('.*+'.includes(c)) gl.add(i); if ('$*'.includes(c)) bx.push(i); if ('@+'.includes(c)) pl = i; } });
  bx.sort((a, b) => a - b);
  return { w, h, wl, gl, bx, pl };
}
const X = (l: L, c: C) => c % l.w, Y = (l: L, c: C) => (c / l.w) | 0;
const mh = (l: L, a: C, b: C) => Math.abs(X(l, a) - X(l, b)) + Math.abs(Y(l, a) - Y(l, b));
// Flood fill from `f` over `area` avoiding `bl`; returns parent/step maps.
function fl(l: L, area: Set<C>, f: C, bl: Set<C>) {
  const pa = new Map<C, C>(), st = new Map<C, string>(), q: C[] = [f];
  pa.set(f, -1);
  for (let h = 0; h < q.length; h++) { const c = q[h]!; for (const [dx, dy, ch] of D) { const n = c + dy * l.w + dx; if (!area.has(n) || bl.has(n) || pa.has(n)) continue; pa.set(n, c); st.set(n, ch); q.push(n); } }
  return { pa, st };
}
const path = (l: L, area: Set<C>, f: C, t: C, bl: Set<C>): string | null => {
  if (f === t) return '';
  const { pa, st } = fl(l, area, f, bl);
  if (!pa.has(t)) return null;
  let o = '';
  for (let c = t; c !== f; c = pa.get(c)!) o = st.get(c)! + o;
  return o;
};
// Cells from which a goal is still reachable by pushing (other boxes and the
// player ignored, so this only prunes truly dead boxes).
function live(l: L, cells: Set<C>, area: Set<C>, goals: C[]): Set<C> {
  const s = new Set<C>(goals), q = [...goals];
  for (let h = 0; h < q.length; h++) { const c = q[h]!; for (const [dx, dy] of D) { const p = c - dy * l.w - dx, st = p - dy * l.w - dx; if (!cells.has(p) || !area.has(st) || s.has(p)) continue; s.add(p); q.push(p); } }
  return s;
}
interface R { m: string; p: number; e: C; x: boolean }
function room(l: L, cells: Set<C>, area: Set<C>, en: C, sb: C[], gl: C[], needExit: boolean, cap: number): R | null {
  const n = sb.length;
  if (!n) return { m: '', p: 0, e: en, x: true };
  const gs = new Set(gl), lv = live(l, cells, area, gl);
  if (sb.some(b => !lv.has(b))) return null;
  const dt = new Map<C, number[]>();
  for (const c of cells) dt.set(c, gl.map(g => mh(l, c, g)));
  const he = (b: C[]): number => {
    const u = new Array<boolean>(n).fill(false);
    let best = Infinity;
    const rec = (i: number, a: number): void => {
      if (a >= best) return;
      if (i === n) { best = a; return; }
      const row = dt.get(b[i]!)!;
      for (let j = 0; j < n; j++) { if (u[j]) continue; u[j] = true; rec(i + 1, a + row[j]!); u[j] = false; }
    };
    rec(0, 0);
    return best;
  };
  const key = (p: C, b: C[]) => p + ':' + b.join(',');
  interface N { p: C; b: C[]; g: number; par: number; s: string }
  const ns: N[] = [{ p: en, b: [...sb].sort((a, b) => a - b), g: 0, par: -1, s: '' }];
  const bg = new Map<string, number>([[key(en, ns[0]!.b), 0]]);
  const hp: [number, number, number, number][] = [];
  let ord = 0;
  const lt = (a: [number, number, number, number], b: [number, number, number, number]) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const push = (e: [number, number, number, number]) => { let i = hp.length; hp.push(e); while (i > 0) { const p = (i - 1) >> 1; if (!lt(hp[i]!, hp[p]!)) break; [hp[i], hp[p]] = [hp[p]!, hp[i]!]; i = p; } };
  const pop = (): [number, number, number, number] => {
    const t = hp[0]!, z = hp.pop()!;
    if (hp.length) { hp[0] = z; for (let i = 0; ;) { let c = 2 * i + 1; if (c >= hp.length) break; if (c + 1 < hp.length && lt(hp[c + 1]!, hp[c]!)) c++; if (!lt(hp[c]!, hp[i]!)) break; [hp[i], hp[c]] = [hp[c]!, hp[i]!]; i = c; } }
    return t;
  };
  push([he(ns[0]!.b), 0, ord++, 0]);
  const done = (b: C[]) => b.every(x => gs.has(x));
  const exit = (p: C, b: C[]) => p === en || fl(l, area, p, new Set(b)).pa.has(en);
  let ex = 0;
  while (hp.length) {
    const [, , , ix] = pop(), nd = ns[ix]!;
    if (bg.get(key(nd.p, nd.b)) !== nd.g) continue;
    if (done(nd.b)) {
      if (!needExit || exit(nd.p, nd.b)) {
        let m = '';
        for (let t = ix; t > 0; t = ns[t]!.par) m = ns[t]!.s + m;
        let e = nd.p;
        if (needExit && e !== en) { const w = path(l, area, e, en, new Set(nd.b)); if (w === null) return null; m += w; e = en; }
        return { m, p: nd.g, e, x: true };
      }
    }
    if (ex >= cap) return null;
    ex++;
    const bl = new Set(nd.b), { pa, st } = fl(l, area, nd.p, bl);
    const to = (t: C): string | null => {
      if (!pa.has(t)) return null;
      let o = '';
      for (let c = t; c !== nd.p; c = pa.get(c)!) o = st.get(c)! + o;
      return o;
    };
    for (let bi = 0; bi < n; bi++) {
      const b = nd.b[bi]!;
      for (const [dx, dy, ch] of D) {
        const de = b + dy * l.w + dx;
        if (!cells.has(de) || bl.has(de)) continue;
        const sd = b - dy * l.w - dx;
        if (!area.has(sd)) continue;
        const w = to(sd);
        if (w === null) continue;
        const nb = nd.b.slice();
        nb[bi] = de;
        nb.sort((a, b) => a - b);
        if (nb.some(x => !lv.has(x))) continue;
        const g = nd.g + 1, k = key(b, nb), s = bg.get(k);
        if (s !== undefined && s <= g) continue;
        bg.set(k, g);
        const t = ns.length;
        ns.push({ p: b, b: nb, g, par: ix, s: w + ch });
        push([g + he(nb), -g, ord++, t]);
      }
    }
  }
  return null;
}
function solve(t: string): string {
  const l = parse(t), hr = Y(l, l.pl);
  // Rooms: connected components left after removing the hallway row.
  const seen = new Set<C>(), rooms: { c: Set<C>; b: C[]; g: C[]; e: C }[] = [];
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
    const c = y * l.w + x;
    if (y === hr || l.wl[c] || seen.has(c)) continue;
    const cells = new Set<C>(), q: C[] = [c];
    seen.add(c); cells.add(c);
    for (let h = 0; h < q.length; h++) { const u = q[h]!; for (const [dx, dy] of D) { const n = u + dy * l.w + dx; if (Y(l, n) === hr || l.wl[n] || seen.has(n)) continue; seen.add(n); cells.add(n); q.push(n); } }
    const dr: C[] = [];
    for (const u of cells) for (const [dx, dy] of D) { const n = u + dy * l.w + dx; if (Y(l, n) === hr && !l.wl[n]) dr.push(u); }
    if (dr.length !== 1) return '';
    const b = l.bx.filter(v => cells.has(v)), g = [...l.gl].filter(v => cells.has(v));
    if (!b.length || b.length !== g.length) return '';
    rooms.push({ c: cells, b, g, e: dr[0]! + (Y(l, dr[0]!) < hr ? l.w : -l.w) });
  }
  if (!rooms.length || l.bx.some(b => !rooms.some(r => r.c.has(b))) || [...l.gl].some(g => !rooms.some(r => r.c.has(g)))) return '';
  const done: { r: (typeof rooms)[number]; s: R }[] = [];
  const hard: (typeof rooms)[number][] = [];
  for (const r of rooms) {
    const area = new Set(r.c);
    area.add(r.e);
    let s = room(l, r.c, area, r.e, r.b, r.g, true, CAP) ?? room(l, r.c, area, r.e, r.b, r.g, true, CAP2);
    if (s === null) {
      const p = room(l, r.c, area, r.e, r.b, r.g, false, CAP2);
      if (p === null) return '';
      hard.push(r);
      done.push({ r, s: p });
    } else done.push({ r, s });
  }
  if (hard.length > 1) return '';
  done.sort((a, b) => (+hard.includes(a.r) - +hard.includes(b.r)) || (a.r.e - b.r.e));
  const hw = new Set<C>();
  for (let x = 0; x < l.w; x++) { const c = hr * l.w + x; if (!l.wl[c]) hw.add(c); }
  let m = '', pl = l.pl;
  for (const { r, s } of done) {
    const w = path(l, hw, pl, r.e, new Set());
    if (w === null) return '';
    m += w + s.m;
    pl = s.e;
  }
  return m;
}
for (const id of readdirSync(I).sort()) {
  const m = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${m}\n`);
}
