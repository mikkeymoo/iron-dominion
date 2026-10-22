import { useCallback, useEffect, useRef } from "react";
import { Minus, Plus, LocateFixed } from "lucide-react";
import type { AbilityId, Campaign, Command, FactionId } from "@/game/types";
import { REGION_RADIUS, squadPositions } from "@/game/geometry";
import { CORE_REGION, CORE_MAX_HP, WORLD } from "@/game/world";
import { getStats, isDisrupted } from "@/game/simulation";

export interface Camera {
  x: number; // screen offset
  y: number;
  zoom: number;
}

interface Props {
  state: Campaign;
  selectedSquadId: number | null;
  selectedRegionId: number | null;
  targeting: AbilityId | null;
  onCommand: (c: Command) => void;
  onSelectSquad: (id: number | null) => void;
  onSelectRegion: (id: number | null) => void;
  initialCamera?: Camera;
  version?: number;
}

const TAP_SLOP = 8;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const FACTION_VARS: FactionId[] = ["player", "red", "amber", "green", "rogue", "neutral"];

export function GameMap(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const cam = useRef<Camera>(props.initialCamera ?? { x: 0, y: 0, zoom: 0.4 });
  const fitted = useRef(!!props.initialCamera);
  const size = useRef({ w: 0, h: 0 });
  const colors = useRef<Record<string, string>>({});

  const publishCamera = () => {
    const c = cam.current;
    wrapRef.current?.setAttribute("data-camera", `${c.x.toFixed(1)},${c.y.toFixed(1)},${c.zoom.toFixed(3)}`);
  };

  const zoomAt = useCallback((px: number, py: number, next: number) => {
    const c = cam.current;
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const k = z / c.zoom;
    cam.current = { zoom: z, x: px - (px - c.x) * k, y: py - (py - c.y) * k };
    publishCamera();
  }, []);

  const fit = useCallback((focusHq = false) => {
    const { w, h } = size.current;
    if (!w || !h) return;
    if (focusHq) {
      const hq = propsRef.current.state.regions[0];
      const z = clamp(Math.min(w / 620, h / 800), MIN_ZOOM, MAX_ZOOM);
      cam.current = { zoom: z, x: w / 2 - hq.x * z, y: h * 0.62 - hq.y * z };
    } else {
      const z = Math.min(w / (WORLD.width + 80), h / (WORLD.height + 80));
      cam.current = { zoom: z, x: (w - WORLD.width * z) / 2, y: (h - WORLD.height * z) / 2 };
    }
    publishCamera();
  }, []);

  // sizing + colors
  useEffect(() => {
    const wrap = wrapRef.current!;
    const css = getComputedStyle(document.documentElement);
    for (const f of FACTION_VARS) colors.current[f] = css.getPropertyValue(`--faction-${f}`).trim() || "#888";
    for (const k of ["map-bg", "map-grid", "map-edge", "foreground", "muted-foreground", "destructive", "energy"])
      colors.current[k] = css.getPropertyValue(`--${k}`).trim() || "#666";
    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      size.current = { w: rect.width, h: rect.height };
      const cv = canvasRef.current;
      if (cv) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
      }
      if (!fitted.current && rect.width > 0) {
        fit(true);
        fitted.current = true;
      }
    };
    measure();
    publishCamera();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit]);

  // wheel zoom (native non-passive)
  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, cam.current.zoom * Math.exp(-dy * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // render loop
  useEffect(() => {
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      const ctx = cv?.getContext?.("2d");
      if (!cv || !ctx) return;
      render(ctx, cv, propsRef.current, cam.current, colors.current, now / 1000);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------- gestures ----------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ mode: "idle" | "tap" | "pan" | "pinch" | "locked"; sx: number; sy: number; dist: number }>({ mode: "idle", sx: 0, sy: 0, dist: 0 });

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleTap = (sx: number, sy: number) => {
    const p = propsRef.current;
    const c = cam.current;
    const wx = (sx - c.x) / c.zoom, wy = (sy - c.y) / c.zoom;
    const hitR = Math.max(24, 26 / c.zoom);
    let best: { id: number; d: number } | null = null;
    for (const [id, pos] of squadPositions(p.state)) {
      const d = Math.hypot(pos.x - wx, pos.y - wy);
      if (d < hitR && (!best || d < best.d)) best = { id, d };
    }
    const region = p.state.regions.find((r) => Math.hypot(r.x - wx, r.y - wy) < Math.max(REGION_RADIUS + 6, 30 / c.zoom));
    if (p.targeting && (region || best)) {
      const rid = region?.id ?? p.state.squads.find((q) => q.id === best!.id)!.at;
      p.onCommand({ type: "hack", ability: p.targeting, regionId: rid });
      return;
    }
    if (best && (!region || best.d < Math.hypot(region.x - wx, region.y - wy))) {
      const sq = p.state.squads.find((q) => q.id === best!.id)!;
      if (sq.owner === "player") return p.onSelectSquad(sq.id);
      if (p.selectedSquadId !== null) {
        return p.onCommand({ type: "order", squadId: p.selectedSquadId, kind: "attack", target: sq.to ?? sq.at });
      }
      return p.onSelectRegion(sq.to ?? sq.at);
    }
    if (region) {
      if (p.selectedSquadId !== null) {
        const kind = region.owner === "player" || region.owner === "neutral" ? "move" : "attack";
        return p.onCommand({ type: "order", squadId: p.selectedSquadId, kind, target: region.id });
      }
      return p.onSelectRegion(region.id);
    }
    p.onSelectSquad(null);
    p.onSelectRegion(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (pointers.current.size === 1) Object.assign(g, { mode: "tap", sx: pt.x, sy: pt.y });
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      Object.assign(g, { mode: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (g.mode === "tap" && Math.hypot(pt.x - g.sx, pt.y - g.sy) > TAP_SLOP) {
      g.mode = "pan";
      cam.current = { ...cam.current, x: cam.current.x + pt.x - g.sx, y: cam.current.y + pt.y - g.sy };
      publishCamera();
    } else if (g.mode === "pan" || g.mode === "locked") {
      cam.current = { ...cam.current, x: cam.current.x + pt.x - prev.x, y: cam.current.y + pt.y - prev.y };
      publishCamera();
    } else if (g.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // pan by midpoint movement of the moved finger's half
      cam.current = { ...cam.current, x: cam.current.x + (pt.x - prev.x) / 2, y: cam.current.y + (pt.y - prev.y) / 2 };
      zoomAt(mx, my, cam.current.zoom * (d / g.dist));
      g.dist = d;
    }
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!cancelled && g.mode === "tap" && pointers.current.size === 0) {
      const pt = local(e);
      if (Math.hypot(pt.x - g.sx, pt.y - g.sy) <= TAP_SLOP) handleTap(pt.x, pt.y);
    }
    if (pointers.current.size === 0) g.mode = "idle";
    else if (g.mode === "pinch") g.mode = "locked";
    if (cancelled) g.mode = pointers.current.size ? "locked" : "idle";
  };

  const zoomBtn = (factor: number) => zoomAt(size.current.w / 2, size.current.h / 2, cam.current.zoom * factor);

  return (
    <div className="relative h-full w-full overflow-hidden bg-map-bg">
      <div
        ref={wrapRef}
        data-testid="map-surface"
        className="absolute inset-0 touch-none select-none"
        style={{ cursor: props.targeting ? "crosshair" : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e, false)}
        onPointerCancel={(e) => endPointer(e, true)}
        role="application"
        aria-label="Battle map. Tap a robot to select, tap a region to order. Drag to pan, pinch to zoom."
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
      <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-2">
        <button className="btn btn-icon pointer-events-auto" aria-label="Zoom in" onClick={() => zoomBtn(1.3)}>
          <Plus className="h-5 w-5" />
        </button>
        <button className="btn btn-icon pointer-events-auto" aria-label="Zoom out" onClick={() => zoomBtn(1 / 1.3)}>
          <Minus className="h-5 w-5" />
        </button>
        <button className="btn btn-icon pointer-events-auto" aria-label="Center on headquarters" onClick={() => fit(true)}>
          <LocateFixed className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

// ---------------- rendering ----------------
function render(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, p: Props, c: Camera, col: Record<string, string>, t: number) {
  const s = p.state;
  const dpr = cv.width / (cv.clientWidth || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = col["map-bg"];
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr * c.zoom, 0, 0, dpr * c.zoom, dpr * c.x, dpr * c.y);

  // grid
  ctx.strokeStyle = col["map-grid"];
  ctx.lineWidth = 1 / c.zoom;
  ctx.beginPath();
  for (let x = -200; x <= WORLD.width + 200; x += 50) (ctx.moveTo(x, -200), ctx.lineTo(x, WORLD.height + 200));
  for (let y = -200; y <= WORLD.height + 200; y += 50) (ctx.moveTo(-200, y), ctx.lineTo(WORLD.width + 200, y));
  ctx.stroke();

  // edges
  ctx.lineWidth = 6;
  for (const r of s.regions)
    for (const n of r.neighbors) {
      if (n < r.id) continue;
      const o = s.regions[n];
      ctx.strokeStyle = r.owner === o.owner && r.owner !== "neutral" ? withAlpha(col[r.owner], 0.45) : col["map-edge"];
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(o.x, o.y);
      ctx.stroke();
    }

  // reachable highlight for selected squad
  const sel = p.selectedSquadId !== null ? s.squads.find((q) => q.id === p.selectedSquadId) : undefined;
  const reach = new Set<number>();
  if (sel) {
    const base = sel.to ?? sel.at;
    const seen = new Set([base]);
    const q = [base];
    while (q.length) {
      const cur = q.shift()!;
      for (const n of s.regions[cur].neighbors) {
        if (seen.has(n)) continue;
        seen.add(n);
        reach.add(n);
        if (s.regions[n].owner === "player") q.push(n);
      }
    }
  }

  // regions
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const r of s.regions) {
    const fc = col[r.owner];
    const R = REGION_RADIUS;
    if (reach.has(r.id)) {
      ctx.strokeStyle = withAlpha(col.player, 0.35 + 0.25 * Math.sin(t * 4));
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(r.x, r.y, R + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    hexPath(ctx, r.x, r.y, R);
    ctx.fillStyle = withAlpha(fc, r.owner === "neutral" ? 0.18 : 0.28);
    ctx.fill();
    ctx.lineWidth = p.selectedRegionId === r.id ? 6 : 3;
    ctx.strokeStyle = p.selectedRegionId === r.id ? col.foreground : fc;
    ctx.stroke();
    if (r.kind === "hq") {
      hexPath(ctx, r.x, r.y, R - 9);
      ctx.strokeStyle = fc;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (r.id === CORE_REGION && s.rogue.coreHp > 0) {
      const pulse = s.rogue.stage === "dormant" ? 0.25 : s.rogue.stage === "stirring" ? 0.5 + 0.3 * Math.sin(t * 3) : 0.7 + 0.3 * Math.sin(t * 6);
      ctx.fillStyle = withAlpha(col.rogue, pulse);
      ctx.beginPath();
      ctx.arc(r.x, r.y, 18 + 4 * Math.sin(t * 2), 0, Math.PI * 2);
      ctx.fill();
      bar(ctx, r.x - 40, r.y + R + 8, 80, 7, s.rogue.coreHp / CORE_MAX_HP, col.rogue, col["map-grid"]);
    }
    // icon letter
    ctx.fillStyle = col.foreground;
    ctx.font = "700 20px 'Chakra Petch', sans-serif";
    ctx.fillText(KIND_GLYPH[r.kind], r.x, r.y - (r.id === CORE_REGION ? 0 : 4));
    // defense pips
    for (let i = 0; i < r.defense; i++) {
      ctx.fillStyle = fc;
      ctx.fillRect(r.x - 14 + i * 11, r.y + 12, 8, 8);
    }
    // capture ring
    if (r.capture.faction && r.capture.progress > 0) {
      ctx.strokeStyle = col[r.capture.faction];
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(r.x, r.y, R + 5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, r.capture.progress)) / 100);
      ctx.stroke();
    }
    if (isDisrupted(s, r.id)) {
      ctx.strokeStyle = withAlpha(col.energy, 0.6 + 0.4 * Math.sin(t * 20));
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + t;
        ctx.lineTo(r.x + Math.cos(a) * (R + (i % 2 ? 2 : 10)), r.y + Math.sin(a) * (R + (i % 2 ? 2 : 10)));
      }
      ctx.closePath();
      ctx.stroke();
    }
    if (r.swarmUntil > s.time) {
      ctx.fillStyle = col.player;
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4 + t * 5;
        ctx.fillRect(r.x + Math.cos(a) * (R * 0.8), r.y + Math.sin(a * 1.3) * (R * 0.8), 4, 4);
      }
    }
    // label
    if (c.zoom > 0.32) {
      ctx.font = "600 15px 'Barlow', sans-serif";
      ctx.fillStyle = withAlpha(col.foreground, 0.85);
      ctx.fillText(r.name.toUpperCase(), r.x, r.y - R - 14);
    }
  }

  // selected path
  if (sel && (sel.path.length || sel.to !== null)) {
    const pos = squadPositions(s).get(sel.id)!;
    ctx.strokeStyle = col.player;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 8]);
    ctx.lineDashOffset = -t * 30;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    if (sel.to !== null) ctx.lineTo(s.regions[sel.to].x, s.regions[sel.to].y);
    for (const n of sel.path) ctx.lineTo(s.regions[n].x, s.regions[n].y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // squads
  const positions = squadPositions(s);
  for (const q of s.squads) {
    const pos = positions.get(q.id)!;
    const fc = col[q.owner];
    if (q.id === p.selectedSquadId) {
      ctx.strokeStyle = col.foreground;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 19 + Math.sin(t * 6), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = fc;
    ctx.strokeStyle = col["map-bg"];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const S = 11;
    if (q.unit === "scout") {
      ctx.moveTo(pos.x, pos.y - S - 2);
      ctx.lineTo(pos.x + S, pos.y + S - 2);
      ctx.lineTo(pos.x - S, pos.y + S - 2);
    } else if (q.unit === "assault") ctx.rect(pos.x - S, pos.y - S, S * 2, S * 2);
    else {
      ctx.moveTo(pos.x, pos.y - S - 3);
      ctx.lineTo(pos.x + S + 3, pos.y);
      ctx.lineTo(pos.x, pos.y + S + 3);
      ctx.lineTo(pos.x - S - 3, pos.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (q.order?.kind === "defend") {
      ctx.fillStyle = col["map-bg"];
      ctx.fillRect(pos.x - 3, pos.y - 3, 6, 6);
    }
    bar(ctx, pos.x - 13, pos.y - S - 9, 26, 4, q.hp / getStats(s, q).hp, fc, col["map-grid"]);
  }
}

const KIND_GLYPH: Record<string, string> = { hq: "HQ", factory: "F", metal: "M", energy: "E", plain: "·", core: "◉" };

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, fg: string, bg: string) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fg;
  ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
}

function withAlpha(color: string, a: number) {
  if (color.startsWith("oklch(")) return color.replace(/\)$/, ` / ${a.toFixed(2)})`).replace(/\/[^/]*\/\s*/, "/ ");
  return color;
}
