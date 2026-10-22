import { describe, expect, it } from "vitest";
import { createCampaign } from "./world";
import { tryCommand } from "./simulation";
import { exportSave, importSave, loadSave, parseSave, saveCampaign, SAVE_KEY } from "./persistence";

class MemStorage {
  data = new Map<string, string>();
  fail = false;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw new DOMException("quota", "QuotaExceededError");
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe("persistence", () => {
  it("round-trips orders, research and threat", () => {
    const s = createCampaign(5);
    s.factions.player.metal = 400;
    s.factions.player.energy = 400;
    const sq = s.squads.find((q) => q.owner === "player")!;
    tryCommand(s, { type: "order", squadId: sq.id, kind: "defend", target: 3 });
    tryCommand(s, { type: "research", id: "weapons1" });
    s.threat = 33.5;
    s.time = 120;
    const back = parseSave(exportSave(s));
    expect(back).toEqual(s);
    expect(back.squads.find((q) => q.id === sq.id)!.order).toEqual({ kind: "defend", target: 3 });
    expect(back.research.active?.id).toBe("weapons1");
  });
  const mutate = (fn: (o: Record<string, any>) => void) => {
    const o = JSON.parse(exportSave(createCampaign(5)));
    fn(o);
    return JSON.stringify(o);
  };
  it("rejects unsupported versions", () => expect(() => parseSave(mutate((o) => (o.version = 99)))).toThrow(/version/i));
  it("rejects negative resources", () => expect(() => parseSave(mutate((o) => (o.factions.player.metal = -5)))).toThrow());
  it("rejects non-finite numbers", () => {
    const txt = exportSave(createCampaign(5)).replace('"threat":0', '"threat":1e999');
    expect(() => parseSave(txt)).toThrow();
    expect(() => parseSave(mutate((o) => (o.time = null)))).toThrow();
  });
  it("rejects invalid faction references", () => {
    expect(() => parseSave(mutate((o) => (o.regions[3].owner = "blue")))).toThrow();
    expect(() => parseSave(mutate((o) => (o.squads[0].owner = "zz")))).toThrow();
  });
  it("rejects malformed JSON", () => expect(() => parseSave("{not json")).toThrow());
  it("failed import preserves the previous save", () => {
    const st = new MemStorage();
    const s = createCampaign(5);
    s.time = 77;
    expect(saveCampaign(s, st).ok).toBe(true);
    const before = st.getItem(SAVE_KEY);
    const r = importSave('{"version":1}', st);
    expect(r.ok).toBe(false);
    expect(st.getItem(SAVE_KEY)).toBe(before);
    expect(loadSave(st).campaign?.time).toBe(77);
  });
  it("valid import replaces and restores the campaign", () => {
    const st = new MemStorage();
    const s = createCampaign(9);
    s.time = 50;
    const r = importSave(exportSave(s), st);
    expect(r.ok).toBe(true);
    expect(loadSave(st).campaign).toEqual(s);
  });
  it("quota failure reports an error while export still works", () => {
    const st = new MemStorage();
    st.fail = true;
    const s = createCampaign(5);
    const r = saveCampaign(s, st);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(parseSave(exportSave(s))).toEqual(s);
  });
  it("reports corrupted saves", () => {
    const st = new MemStorage();
    st.setItem(SAVE_KEY, "garbage{");
    expect(loadSave(st).status).toBe("corrupt");
  });
});

describe('invalid imported UI data',()=>{
 it.each(['kind','event','research'])('rejects malformed %s and preserves saved progress',field=>{
  const storage=new MemStorage(); const s=createCampaign(3);saveCampaign(s,storage);const before=storage.getItem(SAVE_KEY);
  const raw=JSON.parse(exportSave(s));
  if(field==='kind') delete raw.regions[0].kind;
  if(field==='event') raw.events=[null];
  if(field==='research') raw.research.active={id:'toString',remaining:5};
  expect(importSave(JSON.stringify(raw),storage).ok).toBe(false);
  expect(storage.getItem(SAVE_KEY)).toBe(before);
 });
});
