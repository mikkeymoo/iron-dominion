import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { gesture, pointer } from '../test/pointer';
import { Panel, PanelStateContext, type PanelStateStore } from './Panel';

const swipe = (el: Element, dy: number, dx = 0): void => gesture(el, { x: 100, y: 100 }, { x: 100 + dx, y: 100 + dy });
const head = (): HTMLElement => document.querySelector('.pnl-head')!;
const body = (): HTMLElement => document.querySelector('.pnl-body')!;

describe('Panel', () => {
  it('collapses when the header is tapped and expands on a second tap, with aria-expanded on the chevron', () => {
    render(<Panel id="t" title="Thing"><p>content</p></Panel>);
    const chev = screen.getByRole('button', { name: 'Collapse Thing' });
    expect(chev.getAttribute('aria-expanded')).toBe('true');
    swipe(head(), 0);
    expect(body().hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand Thing' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.pnl')!.getAttribute('data-collapsed')).toBe('true');
    swipe(head(), 0);
    expect(body().hidden).toBe(false);
  });

  it('collapses from the chevron button too, without the header tap also firing', () => {
    render(<Panel id="t" title="Thing"><p>content</p></Panel>);
    const chev = screen.getByRole('button', { name: 'Collapse Thing' });
    gesture(chev, { x: 5, y: 5 });
    fireEvent.click(chev);
    expect(body().hidden).toBe(true);
  });

  it('collapses on a swipe down and expands on a swipe up', () => {
    render(<Panel id="t" title="Thing"><p>content</p></Panel>);
    swipe(head(), 70);
    expect(body().hidden).toBe(true);
    swipe(head(), -70);
    expect(body().hidden).toBe(false);
  });

  it('ignores a sideways drag and a second finger', () => {
    render(<Panel id="t" title="Thing"><p>content</p></Panel>);
    swipe(head(), 20, 90);
    expect(body().hidden).toBe(false);
    pointer(head(), 'down', { id: 1, x: 100, y: 100 });
    pointer(head(), 'down', { id: 2, x: 140, y: 100 });
    pointer(head(), 'up', { id: 1, x: 100, y: 180 });
    expect(body().hidden).toBe(false);
  });

  it('closes a transient popover on a header tap or a swipe down instead of collapsing it', () => {
    const onClose = vi.fn();
    render(<Panel id="p" kind="popover" title="Views" onClose={onClose}><p>x</p></Panel>);
    swipe(head(), 0);
    swipe(head(), 70);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(body().hidden).toBe(false);
  });

  it('closes a closable sheet on Escape and on a second swipe down, and collapses first', () => {
    const onClose = vi.fn();
    render(<Panel id="b" title="Budget" onClose={onClose}><p>x</p></Panel>);
    swipe(head(), 70);
    expect(body().hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    swipe(head(), 70);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('collapses a card that cannot close on Escape only when focus is inside it', () => {
    render(<Panel id="c" kind="card" title="Options"><button type="button">go</button></Panel>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(body().hidden).toBe(false);
    screen.getByRole('button', { name: 'go' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(body().hidden).toBe(true);
  });

  it('moves focus to the header on mount and puts it back on unmount', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Panel id="f" title="Focus"><p>x</p></Panel>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse Focus' }));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('remembers its collapsed state in the settings store and starts from it', () => {
    const set = vi.fn();
    const store = (collapsed: Record<string, boolean>): PanelStateStore => ({ collapsed, set });
    const first = render(<PanelStateContext.Provider value={store({})}><Panel id="mem" title="Memo"><p>x</p></Panel></PanelStateContext.Provider>);
    swipe(head(), 0);
    expect(set).toHaveBeenCalledWith('mem', true);
    first.unmount();
    render(<PanelStateContext.Provider value={store({ mem: true })}><Panel id="mem" title="Memo"><p>x</p></Panel></PanelStateContext.Provider>);
    expect(body().hidden).toBe(true);
  });

  it('forgets a collapsed state when the panel is closed, so it reopens expanded', () => {
    const set = vi.fn();
    render(<PanelStateContext.Provider value={{ collapsed: { b: true }, set }}><Panel id="b" title="Budget" onClose={() => {}}><p>x</p></Panel></PanelStateContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(set).toHaveBeenCalledWith('b', false);
  });

  it('keeps state locally without a store', () => {
    function Host() {
      const [n, setN] = useState(0);
      return <><button type="button" onClick={() => setN(n + 1)}>rerender {n}</button><Panel id="loc" title="Local"><p>x</p></Panel></>;
    }
    render(<Host />);
    swipe(head(), 0);
    fireEvent.click(screen.getByRole('button', { name: /rerender/ }));
    expect(body().hidden).toBe(true);
  });
});
