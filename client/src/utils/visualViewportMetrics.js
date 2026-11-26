/**
 * Computes live full-screen layout dimensions aligned to the browser's visual viewport,
 * keeping mobile chat feeds and bottom composers cleanly above virtual keyboards on
 * both iOS Safari (`visualViewport.height` + `offsetTop`) and Android Chrome/Samsung
 * Internet (`interactive-widget=resizes-content` where `window.innerHeight` shrinks).
 *
 * @param {{ innerHeight?: number, innerWidth?: number, visualViewport?: { height?: number, width?: number, offsetTop?: number, offsetLeft?: number } | null } | null} win
 * @param {{ baselineHeight?: number, inputFocused?: boolean }} [opts]
 * @returns {{
 *   top: number,
 *   left: number,
 *   width: number,
 *   height: number,
 *   keyboardInset: number,
 *   keyboardOpen: boolean,
 *   compact: boolean
 * }}
 */
export function computeVisualViewportLayout(
  win,
  { baselineHeight = 0, inputFocused = false } = {}
) {
  const layoutHeight = Number.isFinite(Number(win?.innerHeight)) ? Math.max(0, Number(win.innerHeight)) : 0;
  const layoutWidth = Number.isFinite(Number(win?.innerWidth)) ? Math.max(0, Number(win.innerWidth)) : 0;
  const vv = win?.visualViewport || null;

  const rawVvHeight = Number(vv?.height);
  const rawVvWidth = Number(vv?.width);
  const rawVvTop = Number(vv?.offsetTop);
  const rawVvLeft = Number(vv?.offsetLeft);

  const height =
    Number.isFinite(rawVvHeight) && rawVvHeight > 0
      ? Math.round(rawVvHeight)
      : Math.round(layoutHeight);
  const width =
    Number.isFinite(rawVvWidth) && rawVvWidth > 0
      ? Math.round(rawVvWidth)
      : Math.round(layoutWidth);
  const top = Number.isFinite(rawVvTop) && rawVvTop > 0 ? Math.round(rawVvTop) : 0;
  const left = Number.isFinite(rawVvLeft) && rawVvLeft > 0 ? Math.round(rawVvLeft) : 0;

  const safeBaseline = Math.max(
    Number.isFinite(Number(baselineHeight)) ? Number(baselineHeight) : 0,
    layoutHeight,
    height
  );

  // Keyboard height covers both resizes-visual (iOS Safari: vv.height shrinks while innerHeight stays fixed)
  // and resizes-content (Android Chrome: innerHeight shrinks relative to the orientation's baseline height).
  const keyboardInset = height > 0 ? Math.max(0, Math.round(safeBaseline - height)) : 0;
  const keyboardOpen =
    keyboardInset >= 110 || (Boolean(inputFocused) && height > 0 && height <= 500);
  const compact = keyboardOpen || (height > 0 && height <= 520);

  return {
    top,
    left,
    width,
    height,
    keyboardInset,
    keyboardOpen,
    compact
  };
}
