const WINDOW_MS = 60_000;

export type FrameWindow = { framesPerMinute: number; windowStart: number; count: number; counted: number };

export type FrameRateRefused = { framesPerMinute: number; retryAfter: number };

export const openWindow = (framesPerMinute: number): FrameWindow => ({
  framesPerMinute,
  windowStart: 0,
  count: 0,
  counted: 0,
});

export const admit = (
  window: FrameWindow,
  seq: number,
  now: number,
): { window: FrameWindow; refused: FrameRateRefused | null } => {
  if (seq <= window.counted) return { window, refused: null };
  const windowStart = now - (now % WINDOW_MS);
  const count = (windowStart === window.windowStart ? window.count : 0) + 1;
  const next = { ...window, windowStart, count, counted: seq };
  if (count <= window.framesPerMinute) return { window: next, refused: null };
  return { window: next, refused: { framesPerMinute: window.framesPerMinute, retryAfter: windowStart + WINDOW_MS } };
};

export const rateLimitDetail = (hostId: string, framesPerMinute: number): string =>
  `host ${hostId} sent more than ${framesPerMinute} frames a minute`;
