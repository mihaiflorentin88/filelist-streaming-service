import {describe, expect, it} from 'vitest';
import {chooseDirectionalTarget, chooseStructuredTarget, RectLike, remoteAction} from './navigation';

const rect = (left: number, top: number, width = 100, height = 100): RectLike => ({left, top, right: left + width, bottom: top + height, width, height});

describe('chooseDirectionalTarget', () => {
  const current = rect(100, 100);
  const candidates = [
    {value: 'left', rect: rect(-50, 100)},
    {value: 'right', rect: rect(250, 100)},
    {value: 'up', rect: rect(100, -50)},
    {value: 'down', rect: rect(100, 250)},
    {value: 'diagonal', rect: rect(220, 220)},
  ];

  it.each([
    ['left', 'left'],
    ['right', 'right'],
    ['up', 'up'],
    ['down', 'down'],
  ] as const)('moves %s to the aligned target', (direction, expected) => {
    expect(chooseDirectionalTarget(current, candidates, direction)).toBe(expected);
  });

  it('prefers the next aligned rail over a closer diagonal control', () => {
    const result = chooseDirectionalTarget(current, [
      {value: 'next-rail', rect: rect(100, 500)},
      {value: 'diagonal', rect: rect(450, 250)},
    ], 'down');
    expect(result).toBe('next-rail');
  });

  it('returns null when there is no target in that direction', () => {
    expect(chooseDirectionalTarget(current, [{value: 'left', rect: rect(-50, 100)}], 'right')).toBeNull();
  });
});

describe('chooseStructuredTarget', () => {
  const item = (row:number,col:number) => ({dataset:{focusRegion:'content',focusRow:String(row),focusCol:String(col)}} as unknown as HTMLElement);
  it('moves to the adjacent row and clamps to the closest available column', () => {
    const current=item(1,3);const upper=item(0,0);const lowerA=item(2,0);const lowerB=item(2,2);
    expect(chooseStructuredTarget(current,[upper,current,lowerA,lowerB],'down')).toBe(lowerB);
  });
  it('does not skip a row even when a farther item is geometrically closer', () => {
    const current=item(0,0);const next=item(1,4);const farther=item(2,0);
    expect(chooseStructuredTarget(current,[current,next,farther],'down')).toBe(next);
  });
});

describe('remoteAction', () => {
  it('normalizes remote and keyboard navigation keys', () => {
    expect(remoteAction('ArrowLeft', 0)).toBe('left');
    expect(remoteAction('', 40)).toBe('down');
    expect(remoteAction('Return', 0)).toBe('enter');
    expect(remoteAction('XF86Back', 0)).toBe('back');
    expect(remoteAction('', 10009)).toBe('back');
  });

  it('recognizes Samsung IME completion keys', () => {
    expect(remoteAction('', 65376)).toBe('ime-done');
    expect(remoteAction('', 65385)).toBe('ime-cancel');
  });
});
