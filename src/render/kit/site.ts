// Construction-site geometry: foundation slab with fence and material piles, an optional scaffold, and the tower crane.
// Scaffold vertices carry wid = 1 so the site material can clip them with the rising floor; everything else has wid = 0.
import { SCAFFOLD_LIFT } from './construction.ts';
import { Geo, hex, shade, SLOT, type PartData, type RGB } from './geo.ts';

const STEEL = hex(0xb8c0c4), PLANK = hex(0xb7a47e), SLAB = hex(0xa8a69e), YELLOW = hex(0xe8b820), DARK = hex(0x30353a);

export interface SiteModel {
  part: PartData;
  /** Scaffold height (0 when absent). */
  scaffoldHeight: number;
  triangles: number;
}

function flatten(g: Geo): PartData {
  const parts = g.finalize();
  const n = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const ni = parts.reduce((s, p) => s + p.indices.length, 0);
  const out: PartData = {
    positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), colors: new Float32Array(n * 3), uvs: new Float32Array(n * 2),
    ao: new Float32Array(n), wid: new Float32Array(n), indices: new Uint16Array(ni),
  };
  let vo = 0, io = 0;
  for (const p of parts) {
    out.positions.set(p.positions, vo * 3); out.normals.set(p.normals, vo * 3); out.colors.set(p.colors, vo * 3);
    out.uvs.set(p.uvs, vo * 2); out.ao.set(p.ao, vo); out.wid.set(p.wid, vo);
    for (let i = 0; i < p.indices.length; i++) out.indices[io + i] = p.indices[i]! + vo;
    vo += p.positions.length / 3; io += p.indices.length;
  }
  return out;
}

/** Mark every vertex added since `from` (vertex counts per slot) as scaffold. */
function tagScaffold(g: Geo, from: number[]): void {
  g.parts.forEach((p, s) => { for (let i = from[s]!; i < p.wid.length; i++) p.wid[i] = 1; });
}

export function generateSite(footprint: number, lifts: number): SiteModel {
  const g = new Geo();
  const h = footprint / 2 - 0.1;
  // Slab, stakes and rebar.
  g.box(SLOT.CONCRETE, -h, 0, -h, h, 0.035, h, SLAB, { aoRange: 0.04, aoMin: 0.75, top: shade(SLAB, 1.05) });
  const rebar = hex(0x7a5a46);
  for (let i = 0; i < 8; i++) {
    const t = (i + 0.5) / 8, x = -h + t * 2 * h;
    g.tube(SLOT.METAL, [x, 0.035, -h + 0.06], [x, 0.11, -h + 0.06], 0.005, 3, rebar);
    g.tube(SLOT.METAL, [x, 0.035, h - 0.06], [x, 0.11, h - 0.06], 0.005, 3, rebar);
  }
  // Hoarding fence on three sides (the street side stays open for the gate).
  const fo = h + 0.06;
  const fence = (x0: number, z0: number, x1: number, z1: number): void => {
    g.quad(SLOT.METAL, [x0, 0, z0], [x1, 0, z1], [x1, 0.06, z1], [x0, 0.06, z0], YELLOW, [0.7, 0.7, 1, 1]);
    g.quad(SLOT.METAL, [x1, 0, z1], [x0, 0, z0], [x0, 0.06, z0], [x1, 0.06, z1], shade(YELLOW, 0.8), [0.7, 0.7, 1, 1]);
  };
  fence(-fo, -fo, fo, -fo); fence(fo, -fo, fo, fo); fence(-fo, fo, -fo, -fo);
  fence(-fo, fo, -fo * 0.3, fo); fence(fo * 0.3, fo, fo, fo);
  // Material piles.
  g.box(SLOT.CONCRETE, h * 0.4, 0.035, h * 0.3, h * 0.4 + 0.12, 0.085, h * 0.3 + 0.08, PLANK, { aoRange: 0.06, aoMin: 0.7 });
  g.box(SLOT.METAL, -h * 0.7, 0.035, h * 0.45, -h * 0.7 + 0.1, 0.075, h * 0.45 + 0.1, hex(0x6c7a86), { aoRange: 0.06, aoMin: 0.7 });
  g.box(SLOT.CONCRETE, -h * 0.2, 0.035, -h * 0.4, -h * 0.2 + 0.09, 0.07, -h * 0.4 + 0.09, hex(0xc2a46c), { aoRange: 0.06, aoMin: 0.7 });

  let scaffoldHeight = 0;
  if (lifts > 0) {
    const from = g.parts.map((p) => p.wid.length);
    scaffoldHeight = lifts * SCAFFOLD_LIFT;
    const s = h + 0.02, w = 0.032;
    const posts: [number, number][] = [];
    const per = Math.max(1, Math.round((2 * s) / 0.6));
    for (let i = 0; i <= per; i++) {
      const t = -s + (i / per) * 2 * s;
      posts.push([t, -s], [t, s]);
      if (i > 0 && i < per) posts.push([-s, t], [s, t]);
    }
    for (const [x, z] of posts) g.tube(SLOT.METAL, [x, 0.03, z], [x, scaffoldHeight, z], 0.005, 3, STEEL, 0.9);
    const sideQuad = (a: [number, number], b: [number, number], y0: number, y1: number, col: RGB): void => {
      g.quad(SLOT.METAL, [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], col, 0.9);
      g.quad(SLOT.METAL, [b[0], y0, b[1]], [a[0], y0, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]], col, 0.9);
    };
    const corners: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
    for (let l = 1; l <= lifts; l++) {
      const y = l * SCAFFOLD_LIFT;
      for (let k = 0; k < 4; k++) {
        const a = corners[k]!, b = corners[(k + 1) % 4]!;
        sideQuad(a, b, y + 0.12, y + 0.128, STEEL);
        sideQuad(a, b, y + 0.2, y + 0.208, STEEL);
        if (l % 2 === 1) {
          const [ay0, ay1] = [y - SCAFFOLD_LIFT + 0.02, y];
          g.quad(SLOT.METAL, [a[0], ay0, a[1]], [b[0], ay1, b[1]], [b[0], ay1 + 0.012, b[1]], [a[0], ay0 + 0.012, a[1]], shade(STEEL, 0.85), 0.9);
        }
        const nx = b[1] - a[1], nz = a[0] - b[0], nl = Math.hypot(nx, nz) || 1;
        const ox = (nx / nl) * w, oz = (nz / nl) * w;
        const inx = -ox, inz = -oz;
        g.quad(SLOT.CONCRETE, [a[0] + inx, y, a[1] + inz], [b[0] + inx, y, b[1] + inz], [b[0] + ox, y, b[1] + oz], [a[0] + ox, y, a[1] + oz], PLANK, 0.85);
      }
    }
    tagScaffold(g, from);
  }
  const part = flatten(g);
  return { part, scaffoldHeight, triangles: part.indices.length / 3 };
}

/** Tower crane, 3.2 tiles tall at scale 1, mast on the origin. Yellow lattice with a red beacon. */
export function generateCrane(): { part: PartData; height: number; triangles: number } {
  const g = new Geo();
  const H = 3.2, m = 0.07, seg = 0.2;
  const post = (x: number, z: number): void => g.tube(SLOT.METAL, [x, 0, z], [x, H, z], 0.011, 3, YELLOW);
  post(-m, -m); post(m, -m); post(m, m); post(-m, m);
  g.box(SLOT.CONCRETE, -0.16, 0, -0.16, 0.16, 0.05, 0.16, SLAB, { aoRange: 0.06 });
  const corners: [number, number][] = [[-m, -m], [m, -m], [m, m], [-m, m]];
  const n = Math.round(H / seg);
  for (let i = 0; i < n; i++) {
    const y0 = i * seg, y1 = y0 + seg;
    for (let k = 0; k < 4; k++) {
      const a = corners[k]!, b = corners[(k + 1) % 4]!;
      const up = i % 2 === 0;
      const [pa, pb] = up ? [a, b] : [b, a];
      g.quad(SLOT.METAL, [pa[0], y0, pa[1]], [pa[0], y0 + 0.01, pa[1]], [pb[0], y1 + 0.0, pb[1]], [pb[0], y1 - 0.01, pb[1]], YELLOW, 0.95);
      g.quad(SLOT.METAL, [pb[0], y1 - 0.01, pb[1]], [pb[0], y1, pb[1]], [pa[0], y0 + 0.01, pa[1]], [pa[0], y0, pa[1]], shade(YELLOW, 0.8), 0.95);
      g.tube(SLOT.METAL, [a[0], y1, a[1]], [b[0], y1, b[1]], 0.006, 3, YELLOW);
    }
  }
  // Slewing unit, cab, jib and counter-jib.
  const yT = H;
  g.box(SLOT.METAL, -0.1, yT, -0.1, 0.1, yT + 0.07, 0.1, shade(YELLOW, 0.9), { aoBase: yT, aoRange: 0.07 });
  g.box(SLOT.METAL, 0.1, yT, -0.06, 0.2, yT + 0.12, 0.06, YELLOW, { aoBase: yT, aoRange: 0.1 });
  g.quad(SLOT.GLASS, [0.2005, yT + 0.03, 0.045], [0.2005, yT + 0.03, -0.045], [0.2005, yT + 0.1, -0.045], [0.2005, yT + 0.1, 0.045], hex(0x2b3f4c), 1, [0, 0, 0, 0], 0);
  const jibL = 1.55, cjL = 0.55, yJ = yT + 0.07;
  for (const z of [-0.035, 0.035]) g.tube(SLOT.METAL, [-cjL, yJ, z], [jibL, yJ, z], 0.008, 3, YELLOW);
  g.tube(SLOT.METAL, [-cjL, yJ + 0.07, 0], [jibL, yJ, 0], 0.007, 3, YELLOW);
  g.tube(SLOT.METAL, [0, yJ + 0.3, 0], [jibL, yJ, 0], 0.005, 3, DARK);
  g.tube(SLOT.METAL, [0, yJ + 0.3, 0], [-cjL, yJ, 0], 0.005, 3, DARK);
  g.tube(SLOT.METAL, [0, yJ, 0], [0, yJ + 0.3, 0], 0.012, 4, YELLOW);
  const zig = 14;
  for (let i = 0; i < zig; i++) {
    const x0 = (i / zig) * jibL, x1 = ((i + 1) / zig) * jibL;
    g.tube(SLOT.METAL, [x0, i % 2 ? yJ : yJ + 0.0, i % 2 ? -0.035 : 0.035], [x1, yJ, i % 2 ? 0.035 : -0.035], 0.004, 3, YELLOW);
  }
  g.box(SLOT.CONCRETE, -cjL, yJ - 0.06, -0.05, -cjL + 0.16, yJ + 0.02, 0.05, hex(0x70767a), { aoBase: yJ, aoRange: 0.08 });
  // Hook line and block.
  g.tube(SLOT.METAL, [jibL * 0.7, yJ, 0], [jibL * 0.7, yJ - 0.9, 0], 0.003, 3, DARK);
  g.box(SLOT.METAL, jibL * 0.7 - 0.02, yJ - 0.95, -0.02, jibL * 0.7 + 0.02, yJ - 0.9, 0.02, DARK);
  g.box(SLOT.ACCENT, -0.012, yJ + 0.3, -0.012, 0.012, yJ + 0.34, 0.012, hex(0xff3020), { noBottom: true });
  const part = flatten(g);
  return { part, height: g.maxY, triangles: part.indices.length / 3 };
}
