import { describe, expect, it, vi, beforeAll } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { GameMap } from "./GameMap";
import { createCampaign } from "@/game/world";
import { squadPositions } from "@/game/geometry";

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PE extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "touch";
      }
    }
    // @ts-expect-error jsdom polyfill
    window.PointerEvent = PE;
  }
});

function setup(selected: number | null) {
  const state = createCampaign(1);
  const onCommand = vi.fn();
  const onSelectSquad = vi.fn();
  const onSelectRegion = vi.fn();
  const utils = render(
    <GameMap
      state={state}
      selectedSquadId={selected === null ? null : state.squads.find((q) => q.owner === "player")!.id}
      selectedRegionId={null}
      targeting={null}
      onCommand={onCommand}
      onSelectSquad={onSelectSquad}
      onSelectRegion={onSelectRegion}
      initialCamera={{ x: 0, y: 0, zoom: 1 }}
    />,
  );
  const surface = utils.getByTestId("map-surface");
  return { state, onCommand, onSelectSquad, onSelectRegion, surface };
}

const down = (el: Element, id: number, x: number, y: number) => fireEvent.pointerDown(el, { pointerId: id, clientX: x, clientY: y, button: 0 });
const move = (el: Element, id: number, x: number, y: number) => fireEvent.pointerMove(el, { pointerId: id, clientX: x, clientY: y });
const up = (el: Element, id: number, x: number, y: number) => fireEvent.pointerUp(el, { pointerId: id, clientX: x, clientY: y });

describe("GameMap gestures", () => {
  it("a short stationary tap issues an order to the tapped region", () => {
    const { state, onCommand, surface } = setup(1);
    const r = state.regions[3];
    down(surface, 1, r.x, r.y);
    move(surface, 1, r.x + 3, r.y + 2);
    up(surface, 1, r.x + 3, r.y + 2);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0][0]).toMatchObject({ type: "order", kind: "move", target: 3 });
  });
  it("a tap on a friendly robot selects it", () => {
    const { state, onSelectSquad, surface } = setup(null);
    const sq = state.squads.find((q) => q.owner === "player")!;
    const p = squadPositions(state).get(sq.id)!;
    down(surface, 1, p.x, p.y);
    up(surface, 1, p.x, p.y);
    expect(onSelectSquad).toHaveBeenCalledWith(sq.id);
  });
  it("moving beyond 8px pans and issues no command", () => {
    const { state, onCommand, onSelectRegion, surface } = setup(1);
    const r = state.regions[3];
    const before = surface.getAttribute("data-camera");
    down(surface, 1, r.x, r.y);
    move(surface, 1, r.x + 12, r.y);
    move(surface, 1, r.x + 40, r.y + 10);
    up(surface, 1, r.x + 40, r.y + 10);
    expect(onCommand).not.toHaveBeenCalled();
    expect(onSelectRegion).not.toHaveBeenCalled();
    expect(surface.getAttribute("data-camera")).not.toBe(before);
  });
  it("a second touch switches to pinch and cancels the pending tap", () => {
    const { state, onCommand, surface } = setup(1);
    const r = state.regions[3];
    down(surface, 1, r.x, r.y);
    down(surface, 2, r.x + 100, r.y);
    move(surface, 2, r.x + 160, r.y);
    up(surface, 2, r.x + 160, r.y);
    up(surface, 1, r.x, r.y);
    expect(onCommand).not.toHaveBeenCalled();
  });
  it("pointer cancel never issues a command", () => {
    const { state, onCommand, surface } = setup(1);
    const r = state.regions[3];
    down(surface, 1, r.x, r.y);
    fireEvent.pointerCancel(surface, { pointerId: 1 });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('release displacement safety',()=>{
 it('does not issue a command when release moved without pointermove',()=>{
  const {state,onCommand,surface}=setup(1); const r=state.regions[3];
  down(surface,1,r.x,r.y);up(surface,1,r.x+30,r.y);
  expect(onCommand).not.toHaveBeenCalled();
 });
});
