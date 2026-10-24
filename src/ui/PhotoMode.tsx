import { useEffect, useRef, useState } from 'react';
import type { Speed } from '../sim/protocol.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import type { PhotoController } from '../render/photo.ts';
import { ASPECT_IDS, ASPECT_LABELS, EXPOSURE_RANGE, FOV_RANGE, PHOTO_WEATHERS, SATURATION_RANGE, type PhotoSettings } from '../render/photoSettings.ts';
import { savePhoto } from '../render/photoSave.ts';
import { Panel } from './Panel';
import './photo.css';

interface Props {
  photo: PhotoController;
  lifecycle: Lifecycle;
  /** Post passes the current tier built (`tiltShift`, `dof`); controls for a missing pass are disabled. */
  passes: readonly string[];
  touring: boolean;
  onTour(): void;
}

const clock = (f: number): string => {
  const mins = Math.floor((((f % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

type NumKey = { [K in keyof PhotoSettings]: PhotoSettings[K] extends number ? K : never }[keyof PhotoSettings];

/** The photo-mode overlay: aspect guide, capture bar and the collapsible look panel. Mounted only while photo mode is on. */
export function PhotoMode({ photo, lifecycle, passes, touring, onTour }: Props) {
  const [, bump] = useState(0);
  const [status, setStatus] = useState('');
  const saved = useRef<Speed | null>(null);

  useEffect(() => photo.subscribe(() => bump((n) => n + 1)), [photo]);
  useEffect(() => {
    const on = (): void => bump((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const s = photo.settings;
  useEffect(() => {
    if (s.keepRunning) {
      if (saved.current !== null) { lifecycle.setSpeed(saved.current); saved.current = null; }
    } else if (saved.current === null) {
      saved.current = lifecycle.state.speed;
      lifecycle.setSpeed(0);
    }
  }, [s.keepRunning, lifecycle]);
  useEffect(() => () => {
    if (saved.current !== null) { lifecycle.setSpeed(saved.current); saved.current = null; }
  }, [lifecycle]);

  const capture = async (): Promise<void> => {
    setStatus('Capturing...');
    try {
      const r = await photo.capture();
      const blob = photo.lastBlob;
      const how = blob ? await savePhoto(blob) : 'cancelled';
      setStatus(how === 'cancelled' ? 'Share cancelled' : `${how === 'share' ? 'Shared' : 'Saved'} ${r.width} x ${r.height} PNG`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const hasTilt = passes.includes('tiltShift'), hasDof = passes.includes('dof');
  const slider = (label: string, key: NumKey, min: number, max: number, step: number, show: (v: number) => string, disabled = false) => (
    <label className="row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={s[key]} disabled={disabled} onChange={(e) => photo.set({ [key]: Number(e.target.value) })} />
      <output>{show(s[key])}</output>
    </label>
  );
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const rect = s.aspect === 'view' ? null : photo.frame();

  return (
    <>
      {rect && <div className="photo-guide" data-testid="photo-guide" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
      <div className="photo" role="region" aria-label="Photo mode">
        <div className="photo-status" role="status" aria-live="polite">{status}</div>
        <div className="photo-bar">
          <button type="button" className="tb shutter" disabled={photo.capturing} onClick={() => void capture()}>Capture</button>
          <button type="button" className="tb" aria-pressed={touring} onClick={onTour}>{touring ? 'Stop tour' : 'Tour'}</button>
          <button type="button" className="tb" onClick={() => photo.exit()}>Exit (Esc)</button>
        </div>
        <Panel id="photo" title="Look controls" kind="card" role="group" className="photo-panel" escape="none">
            {slider('Time of day', 'time', 0, 0.999, 0.002, clock)}
            <div className="chips" role="group" aria-label="Weather">
              {PHOTO_WEATHERS.map((w) => (
                <button key={w} type="button" className="tb" aria-pressed={s.weather === w} onClick={() => photo.set({ weather: w })}>{w === 'live' ? 'Live weather' : w}</button>
              ))}
            </div>
            <div className="chips" role="group" aria-label="Frame">
              {ASPECT_IDS.map((a) => (
                <button key={a} type="button" className="tb" aria-pressed={s.aspect === a} onClick={() => photo.set({ aspect: a })}>{ASPECT_LABELS[a]}</button>
              ))}
            </div>
            {slider('Field of view', 'fov', FOV_RANGE.min, FOV_RANGE.max, 1, (v) => `${Math.round(v)}`)}
            {slider('Focus line', 'tiltFocus', 0, 1, 0.01, pct, !hasTilt)}
            <label className="row">
              <span>Tilt-shift</span>
              <input type="range" min={0} max={1} step={0.01} value={s.tiltStrength} disabled={!hasTilt || s.tiltAuto} onChange={(e) => photo.set({ tiltStrength: Number(e.target.value) })} />
              <output>{s.tiltAuto ? 'auto' : pct(s.tiltStrength)}</output>
            </label>
            <div className="chips">
              <button type="button" className="tb" aria-pressed={s.tiltAuto} disabled={!hasTilt} onClick={() => photo.set({ tiltAuto: !s.tiltAuto })}>Auto tilt</button>
              <button type="button" className="tb" aria-pressed={s.dof && hasDof} disabled={!hasDof} onClick={() => photo.set({ dof: !s.dof })}>Depth of field</button>
              <button type="button" className="tb" aria-pressed={s.keepRunning} onClick={() => photo.set({ keepRunning: !s.keepRunning })}>Keep city running</button>
            </div>
            {!hasTilt && <p className="hint">Tilt-shift and depth of field need the mid graphics tier or higher.</p>}
            {slider('Exposure', 'exposure', EXPOSURE_RANGE.min, EXPOSURE_RANGE.max, 0.01, (v) => v.toFixed(2))}
            {slider('Saturation', 'saturation', SATURATION_RANGE.min, SATURATION_RANGE.max, 0.01, pct)}
            {slider('Vignette', 'vignette', 0, 1, 0.01, pct)}
            {slider('Film grain', 'grain', 0, 1, 0.01, pct)}
            <div className="chips">
              <button type="button" className="tb" onClick={() => photo.reset()}>Reset look</button>
            </div>
        </Panel>
      </div>
    </>
  );
}
