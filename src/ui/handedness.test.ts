import { describe, expect, it } from 'vitest';
import { fabPosition, farSide, mirrorRow, mirrorX, thumbSide } from './handedness';

describe('handedness mirroring', () => {
  it('keeps the canonical order for a right-handed player and reverses it for a left-handed one', () => {
    const row = ['Bulldoze', 'Road', 'Zone', 'Undo', 'Views'];
    expect(mirrorRow(row, 'right')).toEqual(row);
    expect(mirrorRow(row, 'left')).toEqual(['Views', 'Undo', 'Zone', 'Road', 'Bulldoze']);
    expect(row[0]).toBe('Bulldoze');
  });

  it('puts the dock and button on the thumb side and the rarely used pieces on the far side', () => {
    expect(thumbSide('right')).toBe('right');
    expect(thumbSide('left')).toBe('left');
    expect(farSide('right')).toBe('left');
    expect(farSide('left')).toBe('right');
  });

  it('mirrors an x coordinate across the viewport only for a left-handed player', () => {
    expect(mirrorX(30, 400, 'right')).toBe(30);
    expect(mirrorX(30, 400, 'left')).toBe(370);
  });

  it('anchors the build button to the thumb edge', () => {
    expect(fabPosition('right')).toEqual({ left: null, right: 10 });
    expect(fabPosition('left', 12)).toEqual({ left: 12, right: null });
  });
});
