import { useEffect, useRef } from 'preact/hooks';

export type OsdFeedback =
  | { kind: 'seek'; fraction: number; hint: string }
  | { kind: 'volume'; percent: number }
  | { kind: 'mute'; muted: boolean }
  | { kind: 'hint'; text: string };

const HIDE_MS = 2000;

// Transient on-screen feedback for Player commands: one feedback at a time,
// auto-hidden after 2s by calling onHidden (the parent clears the state).
export function OsdLayer(props: { feedback: OsdFeedback | null; onHidden?: () => void }): preact.JSX.Element | null {
  const { feedback, onHidden } = props;
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => onHiddenRef.current?.(), HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  if (!feedback) return null;
  return <div class="osd" role="status">{body(feedback)}</div>;
}

function body(feedback: OsdFeedback): preact.JSX.Element {
  switch (feedback.kind) {
    case 'seek':
      return <><span class="osd-ghost" style={`left:${feedback.fraction * 100}%`} /><span class="osd-hint-text">{feedback.hint}</span></>;
    case 'volume':
      return <><span class="osd-volume-track"><span class="osd-volume-fill" style={`width:${feedback.percent}%`} /></span><span class="osd-volume-label">{feedback.percent}%</span></>;
    case 'mute':
      return <span class="osd-mute-label">{feedback.muted ? 'Muted' : 'Sound on'}</span>;
    case 'hint':
      return <span class="osd-hint-text">{feedback.text}</span>;
  }
}
