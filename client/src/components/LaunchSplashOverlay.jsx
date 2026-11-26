import React, { useEffect, useRef, useState } from 'react';
import BrandLogo from './BrandLogo.jsx';

const SPRAY_SPARKS = [
  { id: 's1', dx: '-118px', dy: '-72px', size: 11, color: '#00f5d4', delay: '60ms', rot: '-22deg' },
  { id: 's2', dx: '124px', dy: '-64px', size: 10, color: '#ff3e7f', delay: '95ms', rot: '28deg' },
  { id: 's3', dx: '-136px', dy: '14px', size: 8, color: '#ffd166', delay: '130ms', rot: '45deg' },
  { id: 's4', dx: '142px', dy: '20px', size: 9, color: '#00bbf9', delay: '115ms', rot: '-35deg' },
  { id: 's5', dx: '-86px', dy: '78px', size: 10, color: '#80ff72', delay: '160ms', rot: '18deg' },
  { id: 's6', dx: '92px', dy: '74px', size: 8, color: '#f15bb5', delay: '145ms', rot: '-40deg' },
  { id: 's7', dx: '-34px', dy: '-104px', size: 7, color: '#ffd166', delay: '80ms', rot: '30deg' },
  { id: 's8', dx: '42px', dy: '96px', size: 7, color: '#00f5d4', delay: '175ms', rot: '-18deg' }
];

/**
 * Full-screen kinetic launch intro for SPRAY.LAND:
 *  1) 'intro'   (0 -> ~900ms): Large Voxel Spray Can mark shrinks down & fades behind the SPRAY.LAND wordmark with playful neon spray sparks.
 *  2) 'settle'  (~900 -> ~1150ms, holding if appReady=false): Sparks & ambient burst soften, leaving crisp wordmark over the faded mark.
 *  3) 'fadeout' (1000ms): Logo mark, wordmark text, and splash backdrop smoothly fade out over 1 second to reveal the live app.
 *  4) 'done'    : Unmounts completely with zero residual DOM nodes.
 */
export default function LaunchSplashOverlay({
  appReady = true,
  introDurationMs = 900,
  settleHoldMs = 240,
  fadeOutDurationMs = 1000,
  onComplete = null
}) {
  const [phase, setPhase] = useState('intro'); // 'intro' | 'settle' | 'fadeout' | 'done'
  const [introFinished, setIntroFinished] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Step 1: Complete the shrink-behind + wordmark reveal beat
  useEffect(() => {
    const t = window.setTimeout(() => {
      setIntroFinished(true);
      setPhase((prev) => (prev === 'intro' ? 'settle' : prev));
    }, Math.max(0, Number(introDurationMs) || 0));
    return () => window.clearTimeout(t);
  }, [introDurationMs]);

  // Step 2: Once intro beat finished AND app is ready, hold briefly then trigger 1-second fadeout
  useEffect(() => {
    if (!introFinished || !appReady || phase === 'fadeout' || phase === 'done') return undefined;
    const t = window.setTimeout(() => {
      setPhase('fadeout');
    }, Math.max(0, Number(settleHoldMs) || 0));
    return () => window.clearTimeout(t);
  }, [introFinished, appReady, phase, settleHoldMs]);

  // Step 3: Unmount cleanly right after the 1-second fadeout completes
  useEffect(() => {
    if (phase !== 'fadeout') return undefined;
    const t = window.setTimeout(() => {
      setPhase('done');
      onCompleteRef.current?.();
    }, Math.max(50, Number(fadeOutDurationMs) || 1000));
    return () => window.clearTimeout(t);
  }, [phase, fadeOutDurationMs]);

  if (phase === 'done') return null;

  return (
    <div
      className={`launch-splash-overlay is-phase-${phase}`}
      data-testid="launch-splash-overlay"
      data-phase={phase}
      role="presentation"
      aria-hidden="true"
      style={{ '--launch-fadeout-ms': `${Math.max(50, Number(fadeOutDurationMs) || 1000)}ms` }}
    >
      <div className="launch-splash-aura" />

      <div className="launch-splash-stage">
        {/* Playful neon voxel spray-mist droplets that burst gently while the can shrinks */}
        <div className="launch-splash-sparks" data-testid="launch-splash-sparks">
          {SPRAY_SPARKS.map((sp) => (
            <span
              key={sp.id}
              className="launch-splash-spark"
              style={{
                '--spark-dx': sp.dx,
                '--spark-dy': sp.dy,
                '--spark-size': `${sp.size}px`,
                '--spark-color': sp.color,
                '--spark-delay': sp.delay,
                '--spark-rot': sp.rot
              }}
            />
          ))}
        </div>

        {/* Back Layer: Voxel Spray Can logo mark — starts LARGE, shrinks down, fades behind wordmark */}
        <div className="launch-splash-mark-layer" data-testid="launch-splash-mark-layer">
          <BrandLogo
            variant="mark"
            height={160}
            decorative
            className="launch-splash-mark-img"
          />
        </div>

        {/* Front Layer: Crisp SPRAY.LAND logo text emerging cleanly in front of the faded mark */}
        <div className="launch-splash-wordmark-layer" data-testid="launch-splash-wordmark-layer">
          <BrandLogo
            variant="wordmark"
            tone="dark"
            height={48}
            decorative
            className="launch-splash-wordmark-img"
          />
          <span className="launch-splash-wordmark-sheen" />
        </div>
      </div>
    </div>
  );
}
