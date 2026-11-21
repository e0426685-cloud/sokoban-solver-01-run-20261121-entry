// Sokoban push-optimal solver (original work).
//
// Idea: a generated level is a hallway with one to four rooms off it, and a
// box pushed out of its room can never come back, so every box stays in its
// room and the level's push optimum is the sum of the rooms' optima. The
// program therefore splits each level into rooms (the connected components
// left after removing the hallway row the player starts on), solves every
// room on its own with a push-based A* (one step costs one push, the
// heuristic is the cheapest assignment of boxes to goals by Manhattan
// distance, which no push sequence can beat), and stitches the rooms
// together with plain walks along the hallway. A room is only accepted when
// the player can walk back out of it afterwards, except for the last room
// solved, where the player may finish inside. Everything is decided by
// fixed expansion budgets, never by the clock, so two runs write the same
// bytes.
//
// The entry point is main.ts at the repository root: Node 22 runs
// `node /bot/main.ts`, reading /input/<id>/level.txt and writing
// /output/<id>/solution.txt for each of the five instances.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (counts of expanded states, not seconds): the search
// stops at the same place on every run, so the output is deterministic.
const EXPANSION_CAP = 400_000;
const EXPANSION_CAP_RETRY = 1_600_000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

type Cell = number; // y * w + x

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: Set<Cell>;
  boxes: Cell[];
  player: Cell;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals = new Set<Cell>();
  const boxes: Cell[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

const xs = (lv: Level, c: Cell): number => c % lv.w;
const ys = (lv: Level, c: Cell): number => Math.floor(c / lv.w);
const manhattan = (lv: Level, a: Cell, b: Cell): number =>
  Math.abs(xs(lv, a) - xs(lv, b)) + Math.abs(ys(lv, a) - ys(lv, b));

/** Flood fill from `from` over `area` cells, treating `blocked` as walls. */
function flood(
  lv: Level,
  area: Set<Cell>,
  from: Cell,
  blocked: Set<Cell>,
): { parent: Map<Cell, Cell>; step: Map<Cell, string> } {
  const parent = new Map<Cell, Cell>();
  const step = new Map<Cell, string>();
  const queue: Cell[] = [from];
  parent.set(from, -1);
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    for (const d of DIRS) {
      const n = c + d.dy * lv.w + d.dx;
      if (!area.has(n) || blocked.has(n) || parent.has(n)) continue;
      parent.set(n, c);
      step.set(n, d.ch);
      queue.push(n);
    }
  }
  return { parent, step };
}

/** The walk from `from` to `to` over `area` avoiding `blocked`, or null. */
function walkPath(
  lv: Level,
  area: Set<Cell>,
  from: Cell,
  to: Cell,
  blocked: Set<Cell>,
): string | null {
  if (from === to) return '';
  const { parent, step } = flood(lv, area, from, blocked);
  if (!parent.has(to)) return null;
  let out = '';
  for (let c = to; c !== from; c = parent.get(c)!) out = step.get(c)! + out;
  return out;
}

/** Cells from which a goal can still be reached by pushing (other boxes and
 *  the player's reach ignored, so this only ever prunes truly dead boxes). */
function liveCells(
  lv: Level,
  boxCells: Set<Cell>,
  standCells: Set<Cell>,
  goals: Cell[],
): Set<Cell> {
  const live = new Set<Cell>(goals);
  const queue = [...goals];
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    for (const d of DIRS) {
      const p = c - d.dy * lv.w - d.dx; // box pushed from p lands on c
      const stand = p - d.dy * lv.w - d.dx; // where the player must stand
      if (!boxCells.has(p) || !standCells.has(stand) || live.has(p)) continue;
      live.add(p);
      queue.push(p);
    }
  }
  return live;
}

interface RoomResult {
  moves: string;
  pushes: number;
  endPlayer: Cell;
  exitOk: boolean;
  expansions: number;
}

/**
 * Push-optimal A* for one room. `boxCells` are the cells a box may occupy
 * (the room itself); `area` is where the player may walk (room + entry
 * cell). The player starts on `entry`. With `requireExit`, a solved state
 * only counts when the player can still walk back to `entry`.
 */
function solveRoom(
  lv: Level,
  boxCells: Set<Cell>,
  area: Set<Cell>,
  entry: Cell,
  startBoxes: Cell[],
  roomGoals: Cell[],
  requireExit: boolean,
  expansionCap: number,
): RoomResult | null {
  const n = startBoxes.length;
  if (n === 0) return { moves: '', pushes: 0, endPlayer: entry, exitOk: true, expansions: 0 };
  const goalSet = new Set(roomGoals);
  const live = liveCells(lv, boxCells, area, roomGoals);
  if (startBoxes.some((b) => !live.has(b))) return null;

  // Cheapest assignment of boxes to distinct goals, by Manhattan distance.
  // Every push moves one box one square, so it can lower this by at most
  // one: the value never overestimates the pushes still needed.
  const distToGoal = new Map<Cell, number[]>();
  for (const c of boxCells) {
    distToGoal.set(c, roomGoals.map((g) => manhattan(lv, c, g)));
  }
  const heuristic = (boxes: Cell[]): number => {
    // Brute-force assignment (n <= 4 in a room, n small in the fallback).
    const used = new Array<boolean>(n).fill(false);
    let best = Infinity;
    const rec = (i: number, acc: number): void => {
      if (acc >= best) return;
      if (i === n) {
        best = acc;
        return;
      }
      const row = distToGoal.get(boxes[i]!)!;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        used[j] = true;
        rec(i + 1, acc + row[j]!);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  // State key: boxes sorted, then the player, packed base 64 (cells < 64
  // apart in local numbering are not assumed; global ids are < 256 here, so
  // use a string key built from sorted boxes + player instead).
  const keyOf = (player: Cell, boxes: Cell[]): string =>
    player + ':' + boxes.join(',');

  interface Node {
    player: Cell;
    boxes: Cell[];
    g: number;
    parent: number;
    seg: string;
  }
  const nodes: Node[] = [
    { player: entry, boxes: [...startBoxes].sort((a, b) => a - b), g: 0, parent: -1, seg: '' },
  ];
  const bestG = new Map<string, number>([[keyOf(entry, nodes[0]!.boxes), 0]]);
  // Binary heap of [f, -g, order, nodeIdx]; ties break towards deeper
  // states first, then insertion order, so the run is deterministic.
  const heap: [number, number, number, number][] = [];
  let order = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([heuristic(nodes[0]!.boxes), 0, order++, 0]);

  const solved = (boxes: Cell[]): boolean => boxes.every((b) => goalSet.has(b));
  const canExit = (player: Cell, boxes: Cell[]): boolean => {
    if (player === entry) return true;
    const blocked = new Set(boxes);
    return flood(lv, area, player, blocked).parent.has(entry);
  };

  let expansions = 0;
  while (heap.length > 0) {
    const [, , , idx] = heapPop();
    const node = nodes[idx]!;
    if (bestG.get(keyOf(node.player, node.boxes)) !== node.g) continue; // stale
    if (solved(node.boxes)) {
      if (!requireExit || canExit(node.player, node.boxes)) {
        let moves = '';
        for (let t = idx; t > 0; t = nodes[t]!.parent) moves = nodes[t]!.seg + moves;
        let endPlayer = node.player;
        if (requireExit && endPlayer !== entry) {
          // Walk back out to the door so the next room starts from the
          // hallway; the exit walk pushes nothing.
          const exitWalk = walkPath(lv, area, endPlayer, entry, new Set(node.boxes));
          if (exitWalk === null) return null; // cannot happen: canExit said yes
          moves += exitWalk;
          endPlayer = entry;
        }
        return {
          moves,
          pushes: node.g,
          endPlayer,
          exitOk: true,
          expansions,
        };
      }
      // Solved but the player is trapped inside: keep looking for a
      // solved state that can still walk out.
    }
    if (expansions >= expansionCap) return null;
    expansions++;
    const blocked = new Set(node.boxes);
    const { parent, step } = flood(lv, area, node.player, blocked);
    const pathTo = (target: Cell): string | null => {
      if (!parent.has(target)) return null;
      let out = '';
      for (let c = target; c !== node.player; c = parent.get(c)!) out = step.get(c)! + out;
      return out;
    };
    for (let bi = 0; bi < n; bi++) {
      const b = node.boxes[bi]!;
      for (const d of DIRS) {
        const dest = b + d.dy * lv.w + d.dx;
        if (!boxCells.has(dest) || blocked.has(dest)) continue;
        const stand = b - d.dy * lv.w - d.dx;
        if (!area.has(stand)) continue;
        const walk = pathTo(stand);
        if (walk === null) continue;
        const nextBoxes = node.boxes.slice();
        nextBoxes[bi] = dest;
        nextBoxes.sort((a, b2) => a - b2);
        if (nextBoxes.some((x) => !live.has(x))) continue;
        const g = node.g + 1;
        const k = keyOf(b, nextBoxes);
        const seen = bestG.get(k);
        if (seen !== undefined && seen <= g) continue;
        bestG.set(k, g);
        const t = nodes.length;
        nodes.push({ player: b, boxes: nextBoxes, g, parent: idx, seg: walk + d.ch });
        heapPush([g + heuristic(nextBoxes), -g, order++, t]);
      }
    }
  }
  return null;
}

interface Room {
  cells: Set<Cell>;
  boxes: Cell[];
  goals: Cell[];
  door: Cell;
  entry: Cell; // hallway cell next to the door
}

/** Split a level into hallway + rooms, or return null to use the fallback. */
function decompose(lv: Level): Room[] | null {
  const hallwayRow = ys(lv, lv.player);
  const floor = (c: Cell): boolean => !lv.wall[c];
  const seen = new Set<Cell>();
  const rooms: Room[] = [];
  const boxRoom = new Map<Cell, number>();
  const goalRoom = new Map<Cell, number>();
  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      const c = y * lv.w + x;
      if (y === hallwayRow || !floor(c) || seen.has(c)) continue;
      // One connected component of non-hallway floor.
      const cells = new Set<Cell>();
      const queue: Cell[] = [c];
      seen.add(c);
      cells.add(c);
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head]!;
        for (const d of DIRS) {
          const n = cur + d.dy * lv.w + d.dx;
          const ny = ys(lv, n);
          if (ny === hallwayRow || !floor(n) || seen.has(n)) continue;
          seen.add(n);
          cells.add(n);
          queue.push(n);
        }
      }
      // The door: the component cell next to a hallway floor cell.
      const doors: Cell[] = [];
      for (const cell of cells) {
        for (const d of DIRS) {
          const n = cell + d.dy * lv.w + d.dx;
          if (ys(lv, n) === hallwayRow && floor(n)) doors.push(cell);
        }
      }
      if (doors.length !== 1) return null;
      const door = doors[0]!;
      const entry = door + (ys(lv, door) < hallwayRow ? lv.w : -lv.w);
      const boxes = lv.boxes.filter((b) => cells.has(b));
      const goals = [...lv.goals].filter((g) => cells.has(g));
      if (boxes.length === 0 || boxes.length !== goals.length) return null;
      const idx = rooms.length;
      boxes.forEach((b) => boxRoom.set(b, idx));
      goals.forEach((g) => goalRoom.set(g, idx));
      rooms.push({ cells, boxes, goals, door, entry });
    }
  }
  // Every box and goal must sit in exactly one room.
  if (lv.boxes.some((b) => !boxRoom.has(b))) return null;
  if ([...lv.goals].some((g) => !goalRoom.has(g))) return null;
  if (rooms.length === 0) return null;
  return rooms;
}

/** Replay moves on the level; true when legal and every box ends on a goal. */
function verify(lv: Level, moves: string): boolean {
  const boxes = new Set(lv.boxes);
  let player = lv.player;
  for (const ch of moves) {
    const d = DIRS.find((x) => x.ch === ch);
    if (!d) return false;
    const next = player + d.dy * lv.w + d.dx;
    if (lv.wall[next]) return false;
    if (boxes.has(next)) {
      const beyond = next + d.dy * lv.w + d.dx;
      if (lv.wall[beyond] || boxes.has(beyond)) return false;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  return [...boxes].every((b) => lv.goals.has(b));
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = decompose(lv);
  if (rooms !== null) {
    // Solve every room on its own; the player starts each one standing in
    // the hallway at its door.
    const solved: { room: Room; res: RoomResult }[] = [];
    const exitHard: Room[] = [];
    for (const room of rooms) {
      const area = new Set(room.cells);
      area.add(room.entry);
      let res = solveRoom(lv, room.cells, area, room.entry, room.boxes, room.goals, true, EXPANSION_CAP);
      if (res === null) {
        res = solveRoom(lv, room.cells, area, room.entry, room.boxes, room.goals, true, EXPANSION_CAP_RETRY);
      }
      if (res === null) {
        const plain = solveRoom(lv, room.cells, area, room.entry, room.boxes, room.goals, false, EXPANSION_CAP_RETRY);
        if (plain === null) return '';
        exitHard.push(room);
        solved.push({ room, res: plain });
      } else {
        solved.push({ room, res });
      }
    }
    // At most one room may trap the player; it goes last.
    if (exitHard.length > 1) return '';
    const ordered = solved.slice().sort((a, b) => {
      const aHard = exitHard.includes(a.room) ? 1 : 0;
      const bHard = exitHard.includes(b.room) ? 1 : 0;
      if (aHard !== bHard) return aHard - bHard;
      return a.room.door - b.room.door;
    });
    // Stitch together with walks along the hallway row.
    const hallwayRow = ys(lv, lv.player);
    const hallway = new Set<Cell>();
    for (let x = 0; x < lv.w; x++) {
      const c = hallwayRow * lv.w + x;
      if (!lv.wall[c]) hallway.add(c);
    }
    let moves = '';
    let player = lv.player;
    for (const { room, res } of ordered) {
      const walk = walkPath(lv, hallway, player, room.entry, new Set());
      if (walk === null) return '';
      moves += walk + res.moves;
      player = res.endPlayer;
    }
    return verify(lv, moves) ? moves : '';
  }
  // Fallback: no clean split (unexpected shape) — solve the whole level as
  // one room, player starting where the level puts them.
  const allFloor = new Set<Cell>();
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) allFloor.add(i);
  const res = solveRoom(
    lv,
    allFloor,
    allFloor,
    lv.player,
    lv.boxes,
    [...lv.goals],
    false,
    EXPANSION_CAP_RETRY,
  );
  if (res === null) return '';
  return verify(lv, res.moves) ? res.moves : '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
