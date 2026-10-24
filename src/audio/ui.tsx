import { useEffect } from 'react';
import type { Settings } from '../platform/settings.ts';
import { audio, mixOf } from './index.ts';

interface Props {
  settings: Settings;
  onSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

const pct = (v: number): number => Math.round(v * 100);

/** Sound section of the settings panel: master, music, ambience and effects sliders, mute, and music on/off. */
export function SoundSettings({ settings, onSetting }: Props) {
  const { audio: a, soundMix: m } = settings;
  const slider = (label: string, value: number, set: (v: number) => void) => (
    <label>{label} {pct(value)}%
      <input type="range" min={0} max={100} step={1} value={pct(value)} aria-label={`${label} volume`} onChange={(e) => set(Number(e.target.value) / 100)} />
    </label>
  );
  return (
    <fieldset className="sound-settings" aria-label="Sound" style={{ border: 0, padding: 0, margin: '0.5rem 0', display: 'grid', gap: '0.4rem' }}>
      <legend style={{ padding: 0, fontWeight: 600 }}>Sound</legend>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input type="checkbox" checked={a.muted} onChange={(e) => onSetting('audio', { ...a, muted: e.target.checked })} />Mute all sound
      </label>
      {slider('Master', a.volume, (v) => onSetting('audio', { ...a, volume: v }))}
      {slider('Music', m.music, (v) => onSetting('soundMix', { ...m, music: v }))}
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input type="checkbox" checked={!m.musicOn} onChange={(e) => onSetting('soundMix', { ...m, musicOn: !e.target.checked })} />Mute music only
      </label>
      {slider('Ambience', m.ambience, (v) => onSetting('soundMix', { ...m, ambience: v }))}
      {slider('Effects', m.sfx, (v) => onSetting('soundMix', { ...m, sfx: v }))}
    </fieldset>
  );
}

/**
 * Keeps the audio engine in step with the settings and marks the game screen as the place ambience and music play.
 * Mount it once while a city is on screen; it renders nothing.
 */
export function AudioSync({ settings }: { settings: Settings }) {
  useEffect(() => { audio().applySettings(mixOf(settings)); }, [settings]);
  useEffect(() => {
    const d = audio();
    d.setActive(true);
    if (window.__iron) window.__iron.audio = d.debug;
    return () => d.setActive(false);
  }, []);
  return null;
}

/** Speaker button (mutes all sound) for the top bar. */
export function SpeakerToggle({ settings, onSetting }: Props) {
  const a = settings.audio;
  const off = a.muted;
  return (
    <button type="button" className="tb icon speaker-toggle" aria-pressed={!off} aria-label={off ? 'Sound off' : 'Sound on'} title={off ? 'Sound off (click to unmute)' : 'Sound on (click to mute)'} onClick={() => onSetting('audio', { ...a, muted: !a.muted })}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
        {off ? <path d="M17 9l5 6M22 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" />}
      </svg>
    </button>
  );
}
