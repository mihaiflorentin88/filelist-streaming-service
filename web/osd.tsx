import { useEffect, useMemo, useRef } from 'preact/hooks';

export type OsdFeedback =
  | { kind: 'seek'; fraction: number; hint: string }
  | { kind: 'volume'; percent: number }
  | { kind: 'mute'; muted: boolean }
  | { kind: 'hint'; text: string };

const HIDE_MS = 2000;
// Transient on-screen feedback for Player commands: one feedback at a time,
// auto-hidden after 2s by calling onHidden (the parent clears the state).
// Slider flash: each feedback identity gets a fresh key, so the keyed volume
// fill remounts and its flash animation restarts; held Player command repeats
// (new object, same percent) refresh in place like the hide timer does.

export function OsdLayer(props: { feedback: OsdFeedback | null; onHidden?: () => void }): preact.JSX.Element | null {
  const { feedback, onHidden } = props;
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  const flashSeq = useRef(0);
  const flashKey = useMemo(() => ++flashSeq.current, [feedback]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => onHiddenRef.current?.(), HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  if (!feedback) return null;
  return <div class="osd" role="status">{body(feedback, flashKey)}</div>;
}

function body(feedback: OsdFeedback, flashKey: number): preact.JSX.Element {
  switch (feedback.kind) {
    case 'seek':
      return <><span class="osd-ghost" style={`left:${feedback.fraction * 100}%`} /><span class="osd-hint-text">{feedback.hint}</span></>;
    case 'volume':
      return <><span class="osd-volume-track"><span key={flashKey} class="osd-volume-fill osd-volume-flash" style={`width:${feedback.percent}%`} /></span><span class="osd-volume-label">{feedback.percent}%</span></>;
    case 'mute':
      return (
        <span class="osd-mute-label" role="img" aria-label={feedback.muted ? 'Muted' : 'Sound on'}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
            {feedback.muted
              ? <path d="M16 9l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" />
              : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" />}
          </svg>
        </span>
      );
    case 'hint':
      return <span class="osd-hint-text">{feedback.text}</span>;
  }
}
