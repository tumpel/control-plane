export const HISTOGRAM_MAX_BUCKETS = 160;
export const HISTOGRAM_START_SCALE = 3;

interface Buckets {
  offset: number;
  bucketCounts: number[];
}

export interface ExponentialHistogram {
  scale: number;
  zeroCount: number;
  positive: Buckets;
  negative: Buckets;
}

export interface HistogramBin {
  side: number;
  index: number;
  count: number;
}

const bucketIndex = (magnitude: number, scale: number): number => Math.ceil(Math.log2(magnitude) * 2 ** scale) - 1;

const shifted = (index: number, change: number): number => Math.floor(index / 2 ** change);

export const binOf = (value: number): { side: number; index: number } => {
  if (value === 0) return { side: 0, index: 0 };
  return { side: value > 0 ? 1 : -1, index: bucketIndex(Math.abs(value), HISTOGRAM_START_SCALE) };
};

interface IndexRange {
  low: number;
  high: number;
}

const rangeOf = (bins: readonly HistogramBin[]): IndexRange | undefined =>
  bins.reduce<IndexRange | undefined>(
    (range, { index }) =>
      range === undefined
        ? { low: index, high: index }
        : { low: Math.min(range.low, index), high: Math.max(range.high, index) },
    undefined,
  );

const changeToFit = (range: IndexRange | undefined): number => {
  if (range === undefined) return 0;
  let change = 0;
  while (shifted(range.high, change) - shifted(range.low, change) + 1 > HISTOGRAM_MAX_BUCKETS) change += 1;
  return change;
};

const bucketsOf = (bins: readonly HistogramBin[], change: number): Buckets => {
  const counts = new Map<number, number>();
  for (const { index, count } of bins) {
    const at = shifted(index, change);
    counts.set(at, (counts.get(at) ?? 0) + count);
  }
  const range = rangeOf(bins.map((bin) => ({ ...bin, index: shifted(bin.index, change) })));
  if (range === undefined) return { offset: 0, bucketCounts: [] };
  return {
    offset: range.low,
    bucketCounts: Array.from(
      { length: range.high - range.low + 1 },
      (_, position) => counts.get(range.low + position) ?? 0,
    ),
  };
};

export const histogramOfBins = (bins: readonly HistogramBin[]): ExponentialHistogram => {
  const positive = bins.filter((bin) => bin.side > 0);
  const negative = bins.filter((bin) => bin.side < 0);
  const change = Math.max(changeToFit(rangeOf(positive)), changeToFit(rangeOf(negative)));
  return {
    scale: HISTOGRAM_START_SCALE - change,
    zeroCount: bins.filter((bin) => bin.side === 0).reduce((sum, bin) => sum + bin.count, 0),
    positive: bucketsOf(positive, change),
    negative: bucketsOf(negative, change),
  };
};

const bucketValue = (index: number, scale: number): number => {
  const lower = 2 ** (index * 2 ** -scale);
  const upper = 2 ** ((index + 1) * 2 ** -scale);
  return (2 * lower * upper) / (lower + upper);
};

export interface ValueBounds {
  min: number;
  max: number;
}

export const histogramQuantile = (histogram: ExponentialHistogram, quantile: number, bounds: ValueBounds): number => {
  const total =
    histogram.zeroCount +
    histogram.positive.bucketCounts.reduce((sum, count) => sum + count, 0) +
    histogram.negative.bucketCounts.reduce((sum, count) => sum + count, 0);
  const rank = Math.max(1, Math.ceil(quantile * total));
  const clamped = (value: number): number => Math.min(bounds.max, Math.max(bounds.min, value));
  let seen = 0;
  const { negative, positive, scale } = histogram;
  for (let position = negative.bucketCounts.length - 1; position >= 0; position -= 1) {
    seen += negative.bucketCounts[position] ?? 0;
    if (seen >= rank) return clamped(-bucketValue(negative.offset + position, scale));
  }
  seen += histogram.zeroCount;
  if (seen >= rank) return clamped(0);
  for (const [position, count] of positive.bucketCounts.entries()) {
    seen += count;
    if (seen >= rank) return clamped(bucketValue(positive.offset + position, scale));
  }
  return bounds.max;
};
