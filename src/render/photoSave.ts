// Getting a captured PNG to the player: the share sheet on touch devices that can share files, a download elsewhere.

export type SaveMethod = 'share' | 'download';

/** Share only where the device is touch-first and the browser accepts a file; desktop browsers that expose share still get a plain download. */
export function chooseSaveMethod(env: { coarsePointer: boolean; canShareFiles: boolean }): SaveMethod {
  return env.coarsePointer && env.canShareFiles ? 'share' : 'download';
}

export const photoFileName = (now: Date = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `iron-dominion-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
};

/** Save or share the PNG; resolves with what happened. A dismissed share sheet counts as 'cancelled', not an error. */
export async function savePhoto(blob: Blob, name: string = photoFileName()): Promise<SaveMethod | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  const file = new File([blob], name, { type: 'image/png' });
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const canShareFiles = typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  if (chooseSaveMethod({ coarsePointer: coarse, canShareFiles }) === 'share') {
    try {
      await nav.share!({ files: [file], title: 'Iron Dominion' });
      return 'share';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'download';
}
