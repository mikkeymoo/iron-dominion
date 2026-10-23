import { CHUNK, CHUNKS, MAP, ROAD, S, TILES, type World } from '../layers.ts';
import { Heap, IntHeap } from './heap.ts';

// Road graph derived from the road layer (nothing here is saved or hashed except the graphEpoch scalar).
//
// Tile level: adjacency is implicit. A tile may step in direction d when its road word has the connectivity bit and the
// neighbour has a road class. Step cost between neighbours a and b is tileCost(a) + tileCost(b) (symmetric, integer).
//
// Cluster level (HPA*): clusters are the 16x16 chunks. An entrance is a road tile on a cluster border whose neighbour
// across the border is also a road. Within a run of consecutive crossings along one border only every
// ENTRANCE_SPACING-th crossing and the run's last one become entrances, which keeps a fully paved cluster at ~20
// entrances instead of 60. Each cluster stores the exact intra-cluster shortest cost between every pair of its entrances.
// Crossing edges between clusters are not stored: they are read from the road bits at query time.
//
// Components: every cluster labels its road tiles into local components (flood fill). A union-find over
// (cluster, local label) joined across border crossings gives global components; the root is the smallest node index,
// so ids depend only on the road layer. Cost of the global pass: O(entrances + local components), a few thousand
// operations on a dense map, run once per sync that changed anything.

if (MAP !== 256 || CHUNK !== 16) throw new Error('roads: tile and cluster index math assumes a 256 map with 16 tile clusters');
export const SHIFT = 8;
export const XM = MAP - 1;
export const CSHIFT = 4;
export const NCL = CHUNKS * CHUNKS;
export const INF = 0x3fffffff;
export const ENTRANCE_SPACING = 4;

/** Cost of entering/leaving a tile by road class (street, avenue, highway; reserved classes cost like a street). */
export const CLASS_COST = [0, 30, 20, 12, 30, 30, 30, 30] as const;
export const SLOPE_COST = 15;
export const BRIDGE_COST = 6;
export const MIN_TILE_COST = 12;
/** Admissible and consistent: every step costs at least two tiles of the cheapest road. */
export const STEP_LOWER_BOUND = 2 * MIN_TILE_COST;

export const tileCost = (r: number): number =>
  CLASS_COST[r & ROAD.CLASS_MASK]! + ((r & ROAD.SLOPE) !== 0 ? SLOPE_COST : 0) + ((r & ROAD.BRIDGE) !== 0 ? BRIDGE_COST : 0);

export const clusterOf = (t: number): number => ((t >> SHIFT) >> CSHIFT) * CHUNKS + ((t & XM) >> CSHIFT);
export const heuristic = (t: number, goal: number): number =>
  STEP_LOWER_BOUND * (Math.abs((t & XM) - (goal & XM)) + Math.abs((t >> SHIFT) - (goal >> SHIFT)));

const BIT = [ROAD.N, ROAD.E, ROAD.S, ROAD.W] as const;
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
const OPP = [2, 3, 0, 1] as const;
const LOCAL_OFF = [-CHUNK, 1, CHUNK, -1] as const;
const EMPTY = new Int32Array(0);

/** Tile reached by stepping in direction d (0 N, 1 E, 2 S, 3 W), or -1 when the road word forbids it. */
export function neighbor(road: Uint16Array, t: number, d: number): number {
  if ((road[t]! & BIT[d]!) === 0) return -1;
  const x = (t & XM) + DX[d]!, y = (t >> SHIFT) + DY[d]!;
  if (x < 0 || y < 0 || x >= MAP || y >= MAP) return -1;
  const n = (y << SHIFT) | x;
  return (road[n]! & ROAD.CLASS_MASK) === 0 ? -1 : n;
}

export interface TilePath { tiles: Int32Array; cost: number }

export class RoadNet {
  readonly world: World;
  readonly road: Uint16Array;
  readonly ent: Int32Array[] = new Array<Int32Array>(NCL);
  /** Per cluster: n*n symmetric matrix of intra-cluster costs between its n entrances (INF when disconnected inside the cluster). */
  readonly cost: Int32Array[] = new Array<Int32Array>(NCL);
  /** Index of a border tile in its cluster's entrance list, else -1. */
  readonly entIdx = new Int16Array(TILES).fill(-1);
  /** Local component label (1-based) of a road tile inside its cluster, 0 for no road. */
  readonly local = new Uint16Array(TILES);
  readonly nLocal = new Uint16Array(NCL);
  /** graphEpoch value at which each cluster last changed; a path planned at epoch e is stale where this exceeds e. */
  readonly clusterEpoch = new Int32Array(NCL);
  readonly compRoot = new Int32Array(NCL * 256);
  /** Scratch queue for roadFlow so a call allocates nothing. */
  readonly flowQueue = new Int32Array(TILES);
  private readonly own =new Uint8Array(NCL);
  private readonly touch = new Uint8Array(NCL);
  /** Clusters rebuilt by the most recent sync that changed anything, ascending. */
  lastRebuilt: number[] = [];

  private readonly shadow = new Uint16Array(TILES);
  private readonly road32: Uint32Array;
  private readonly shadow32: Uint32Array;
  private readonly uf = new Int32Array(NCL * 256);
  private readonly lAdj = new Uint8Array(CHUNK * CHUNK);
  private readonly lCost = new Uint8Array(CHUNK * CHUNK);
  private readonly lDist = new Int32Array(CHUNK * CHUNK);
  private readonly lEnt = new Int16Array(CHUNK * CHUNK);
  private readonly lLabel = new Uint16Array(CHUNK * CHUNK);
  private readonly lStack = new Int32Array(CHUNK * CHUNK);
  private readonly lHeap = new IntHeap(CHUNK * CHUNK * 4 + 1);

  readonly dist = new Int32Array(TILES + 1);
  readonly par = new Int32Array(TILES + 1);
  readonly stamp = new Uint32Array(TILES + 1);
  private stampNow = 0;
  readonly heap = new Heap();

  private constructor(world: World) {
    this.world = world;
    this.road = world.road;
    this.road32 = new Uint32Array(world.road.buffer, world.road.byteOffset, TILES >> 1);
    this.shadow32 = new Uint32Array(this.shadow.buffer);
    this.ent.fill(new Int32Array(0));
    this.cost.fill(new Int32Array(0));
  }

  /** Full build from the current road layer. Does not touch graphEpoch. */
  static build(world: World): RoadNet {
    const net = new RoadNet(world);
    net.shadow.set(world.road);
    const epoch = world.scalars[S.graphEpoch]!;
    for (let c = 0; c < NCL; c++) { net.rebuildCluster(c); net.clusterEpoch[c] = epoch; }
    net.computeComponents();
    return net;
  }

  /** The committed graphEpoch scalar. */
  get epoch(): number { return this.world.scalars[S.graphEpoch]!; }

  /**
   * Compare the road layer with the copy taken at the last sync and rebuild only the clusters that contain a changed tile
   * or share a border with one, then commit one graphEpoch bump to world state. Idempotent: a second call with no road
   * change does nothing. Returns true if it rebuilt. Cost with no change: one pass over 32k words.
   */
  sync(): boolean {
    const a = this.road32, b = this.shadow32, road = this.road, shadow = this.shadow;
    const own = this.own, touch = this.touch;
    let any = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      for (let t = i << 1; t <= (i << 1) + 1; t++) {
        if (road[t] === shadow[t]) continue;
        any = true;
        const c = clusterOf(t), x = t & XM, y = t >> SHIFT, lx = x & (CHUNK - 1), ly = y & (CHUNK - 1);
        own[c] = 1;
        if (ly === 0 && y > 0) touch[c - CHUNKS] = 1;
        if (ly === CHUNK - 1 && y < MAP - 1) touch[c + CHUNKS] = 1;
        if (lx === 0 && x > 0) touch[c - 1] = 1;
        if (lx === CHUNK - 1 && x < MAP - 1) touch[c + 1] = 1;
      }
    }
    if (!any) return false;
    const label = ++this.world.scalars[S.graphEpoch]!;
    const rebuilt: number[] = [];
    for (let c = 0; c < NCL; c++) {
      if (!own[c] && !touch[c]) continue;
      const changed = this.rebuildCluster(c);
      if (own[c] || changed) this.clusterEpoch[c] = label;
      rebuilt.push(c);
    }
    own.fill(0);
    touch.fill(0);
    shadow.set(road);
    this.computeComponents();
    this.lastRebuilt = rebuilt;
    return true;
  }

  nextStamp(): number {
    if (this.stampNow === 0xffffffff) { this.stamp.fill(0); this.stampNow = 0; }
    return ++this.stampNow;
  }

  isRoad(t: number): boolean { return t >= 0 && t < TILES && (this.road[t]! & ROAD.CLASS_MASK) !== 0; }

  /** Canonical component id of a road tile (smallest member node index), -1 when the tile has no road. */
  componentOf(t: number): number {
    if (!this.isRoad(t)) return -1;
    return this.compRoot[(clusterOf(t) << 8) + this.local[t]! - 1]!;
  }

  /** O(1): both tiles are roads and joined by some road path. */
  connected(a: number, b: number): boolean {
    const ca = this.componentOf(a);
    return ca >= 0 && ca === this.componentOf(b);
  }

  /** Entrance node on the other side of a crossing, or -1. Requires t to be an entrance. */
  crossing(t: number, d: number): number {
    const n = neighbor(this.road, t, d);
    if (n < 0 || clusterOf(n) === clusterOf(t) || this.entIdx[n]! < 0) return -1;
    return n;
  }

  /**
   * Shortest paths from `src` inside cluster `c` only, into `dist`/`stamp` (valid where stamp equals the returned value).
   * Stops early once every entrance with index >= lo has been settled.
   */
  dijkstra(src: number, c: number, lo: number): number {
    const road = this.road, dist = this.dist, stamp = this.stamp, heap = this.heap, entIdx = this.entIdx;
    const st = this.nextStamp();
    dist[src] = 0; stamp[src] = st;
    let left = this.ent[c]!.length - lo;
    if (left <= 0) return st;
    heap.clear();
    heap.push(0, 0, src);
    while (heap.pop()) {
      const g = heap.g, t = heap.id;
      if (g > dist[t]!) continue;
      if (entIdx[t]! >= lo && --left === 0) break;
      const tc = tileCost(road[t]!);
      for (let d = 0; d < 4; d++) {
        const n = neighbor(road, t, d);
        if (n < 0 || clusterOf(n) !== c) continue;
        const ng = g + tc + tileCost(road[n]!);
        if (stamp[n] !== st || ng < dist[n]!) { dist[n] = ng; stamp[n] = st; heap.push(ng, ng, n); }
      }
    }
    return st;
  }

  /** Tile-level A* over the whole road layer, or confined to cluster `lim` when lim >= 0. Ties break on (f, g, tile id). */
  tileAStar(from: number, to: number, lim = -1): TilePath | null {
    const road = this.road;
    if (!this.isRoad(from) || !this.isRoad(to)) return null;
    const dist = this.dist, par = this.par, stamp = this.stamp, heap = this.heap;
    const st = this.nextStamp();
    heap.clear();
    dist[from] = 0; par[from] = -1; stamp[from] = st;
    heap.push(heuristic(from, to), 0, from);
    while (heap.pop()) {
      const g = heap.g, t = heap.id;
      if (g > dist[t]!) continue;
      if (t === to) {
        let len = 1;
        for (let p = t; par[p] !== -1; p = par[p]!) len++;
        const tiles = new Int32Array(len);
        for (let p = t, i = len - 1; i >= 0; p = par[p]!, i--) tiles[i] = p;
        return { tiles, cost: g };
      }
      const tc = tileCost(road[t]!);
      for (let d = 0; d < 4; d++) {
        const n = neighbor(road, t, d);
        if (n < 0 || (lim >= 0 && clusterOf(n) !== lim)) continue;
        const ng = g + tc + tileCost(road[n]!);
        if (stamp[n] !== st || ng < dist[n]!) {
          dist[n] = ng; par[n] = t; stamp[n] = st;
          heap.push(ng + heuristic(n, to), ng, n);
        }
      }
    }
    return null;
  }

  /** Rebuild one cluster's local components, entrances and intra-cluster edges. Returns true if entrances or edge costs changed. */
  private rebuildCluster(c: number): boolean {
    const road = this.road, local = this.local, entIdx = this.entIdx;
    const x0 = (c % CHUNKS) << CSHIFT, y0 = ((c / CHUNKS) | 0) << CSHIFT;
    const oldEnt = this.ent[c]!, oldCost = this.cost[c]!;
    for (let i = 0; i < oldEnt.length; i++) entIdx[oldEnt[i]!] = -1;

    // Cluster-local copy of the graph (256 cells): step cost per tile (0 = no road) and a 4-bit mask of allowed in-cluster steps.
    const adj = this.lAdj, tcl = this.lCost, ld = this.lDist, eLoc = this.lEnt, lab = this.lLabel, stack = this.lStack;
    let roads = 0;
    for (let li = 0; li < CHUNK * CHUNK; li++) {
      const t = ((y0 + (li >> CSHIFT)) << SHIFT) | (x0 + (li & (CHUNK - 1))), r = road[t]!;
      tcl[li] = (r & ROAD.CLASS_MASK) === 0 ? 0 : tileCost(r);
      if (tcl[li] !== 0) roads++;
      local[t] = 0;
      lab[li] = 0;
      eLoc[li] = -1;
    }
    if (roads === 0) {
      this.nLocal[c] = 0;
      this.ent[c] = EMPTY;
      this.cost[c] = EMPTY;
      return oldEnt.length !== 0;
    }
    for (let li = 0; li < CHUNK * CHUNK; li++) {
      let a = 0;
      if (tcl[li] !== 0) {
        const r = road[((y0 + (li >> CSHIFT)) << SHIFT) | (x0 + (li & (CHUNK - 1)))]!, lx = li & (CHUNK - 1), ly = li >> CSHIFT;
        if ((r & ROAD.N) !== 0 && ly > 0 && tcl[li - CHUNK] !== 0) a |= 1;
        if ((r & ROAD.E) !== 0 && lx < CHUNK - 1 && tcl[li + 1] !== 0) a |= 2;
        if ((r & ROAD.S) !== 0 && ly < CHUNK - 1 && tcl[li + CHUNK] !== 0) a |= 4;
        if ((r & ROAD.W) !== 0 && lx > 0 && tcl[li - 1] !== 0) a |= 8;
      }
      adj[li] = a;
    }
    let label = 0;
    for (let s = 0; s < CHUNK * CHUNK; s++) {
      if (tcl[s] === 0 || lab[s] !== 0) continue;
      label++;
      lab[s] = label;
      let sp = 0;
      stack[sp++] = s;
      while (sp > 0) {
        const u = stack[--sp]!;
        local[((y0 + (u >> CSHIFT)) << SHIFT) | (x0 + (u & (CHUNK - 1)))] = label;
        const a = adj[u]!;
        for (let d = 0; d < 4; d++) {
          if ((a & (1 << d)) === 0) continue;
          const n = u + LOCAL_OFF[d]!;
          if (lab[n] === 0) { lab[n] = label; stack[sp++] = n; }
        }
      }
    }
    this.nLocal[c] = label;

    const found: number[] = [];
    const cx = c % CHUNKS, cy = (c / CHUNKS) | 0;
    for (let d = 0; d < 4; d++) {
      if ((d === 0 && cy === 0) || (d === 2 && cy === CHUNKS - 1) || (d === 3 && cx === 0) || (d === 1 && cx === CHUNKS - 1)) continue;
      let run = 0, last = -1;
      for (let i = 0; i < CHUNK; i++) {
        const t = d === 0 ? (y0 << SHIFT) | (x0 + i) : d === 2 ? ((y0 + CHUNK - 1) << SHIFT) | (x0 + i)
          : d === 3 ? ((y0 + i) << SHIFT) | x0 : ((y0 + i) << SHIFT) | (x0 + CHUNK - 1);
        const n = neighbor(road, t, d);
        const cross = n >= 0 && neighbor(road, n, OPP[d]!) === t;
        if (cross) {
          if (run % ENTRANCE_SPACING === 0) found.push(t);
          last = t; run++;
        } else {
          if (run > 0 && (run - 1) % ENTRANCE_SPACING !== 0) found.push(last);
          run = 0;
        }
      }
      if (run > 0 && (run - 1) % ENTRANCE_SPACING !== 0) found.push(last);
    }
    const sorted = Int32Array.from(found).sort();
    let m = 0;
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[m++] = sorted[i]!;
    const ent = sorted.slice(0, m);
    for (let i = 0; i < m; i++) entIdx[ent[i]!] = i;
    this.ent[c] = ent;

    const cost = new Int32Array(m * m).fill(INF);
    if (m > 1) {
      const locOf = (t: number): number => (((t >> SHIFT) - y0) << CSHIFT) | ((t & XM) - x0);
      const loc = new Int32Array(m);
      for (let i = 0; i < m; i++) { loc[i] = locOf(ent[i]!); eLoc[loc[i]!] = i; }
      for (let i = 0; i < m - 1; i++) {
        cost[i * m + i] = 0;
        this.localDijkstra(loc[i]!, i, m - 1 - i);
        for (let j = i + 1; j < m; j++) {
          const w = ld[loc[j]!]!;
          cost[i * m + j] = w; cost[j * m + i] = w;
        }
      }
      cost[(m - 1) * m + (m - 1)] = 0;
    } else if (m === 1) cost[0] = 0;
    this.cost[c] = cost;

    if (oldEnt.length !== ent.length) return true;
    for (let i = 0; i < ent.length; i++) if (oldEnt[i] !== ent[i]) return true;
    for (let i = 0; i < cost.length; i++) if (oldCost[i] !== cost[i]) return true;
    return false;
  }

  /** Shortest costs from local cell `src` over the cluster-local copy into lDist; stops once `left` entrances with index > i are settled. */
  private localDijkstra(src: number, i: number, left: number): void {
    const adj = this.lAdj, tcl = this.lCost, ld = this.lDist, eLoc = this.lEnt, lh = this.lHeap;
    ld.fill(INF);
    ld[src] = 0;
    // Keys pack (dist, node): distances stay far below 2^23.
    lh.n = 0;
    lh.push(src);
    while (lh.n > 0) {
      const key = lh.pop(), u = key & 255, g = key >> 8;
      if (g > ld[u]!) continue;
      if (eLoc[u]! > i && --left === 0) break;
      const a = adj[u]!, base = g + tcl[u]!;
      for (let d = 0; d < 4; d++) {
        if ((a & (1 << d)) === 0) continue;
        const n = u + LOCAL_OFF[d]!, ng = base + tcl[n]!;
        if (ng < ld[n]!) { ld[n] = ng; lh.push((ng << 8) | n); }
      }
    }
  }

  private find(x: number): number {
    const uf = this.uf;
    while (uf[x] !== x) { uf[x] = uf[uf[x]!]!; x = uf[x]!; }
    return x;
  }

  private computeComponents(): void {
    const uf = this.uf, root = this.compRoot;
    for (let c = 0; c < NCL; c++) for (let l = 0; l < this.nLocal[c]!; l++) uf[(c << 8) + l] = (c << 8) + l;
    for (let c = 0; c < NCL; c++) {
      const ent = this.ent[c]!;
      for (let i = 0; i < ent.length; i++) {
        const t = ent[i]!, a = (c << 8) + this.local[t]! - 1;
        for (let d = 0; d < 4; d++) {
          const n = neighbor(this.road, t, d);
          if (n < 0) continue;
          const nc = clusterOf(n);
          if (nc === c) continue;
          const ra = this.find(a), rb = this.find((nc << 8) + this.local[n]! - 1);
          if (ra < rb) uf[rb] = ra; else if (rb < ra) uf[ra] = rb;
        }
      }
    }
    for (let c = 0; c < NCL; c++) for (let l = 0; l < this.nLocal[c]!; l++) root[(c << 8) + l] = this.find((c << 8) + l);
  }

  /** Deterministic text dump of everything derived from the road layer (excluding epochs), for incremental-vs-rebuild checks. */
  canonicalDump(): string[] {
    const lines: string[] = [];
    for (let c = 0; c < NCL; c++) {
      lines.push(`c${c} loc=${this.nLocal[c]} ent=${Array.from(this.ent[c]!).join(',')} cost=${Array.from(this.cost[c]!).join(',')}`);
    }
    const canon = new Map<number, number>();
    const parts: number[] = new Array<number>(TILES);
    for (let t = 0; t < TILES; t++) {
      const r = this.componentOf(t);
      if (r < 0) { parts[t] = 0; continue; }
      if (!canon.has(r)) canon.set(r, canon.size + 1);
      parts[t] = canon.get(r)!;
    }
    for (let y = 0; y < MAP; y++) lines.push(`row${y} ${parts.slice(y * MAP, (y + 1) * MAP).join(',')}`);
    return lines;
  }
}
