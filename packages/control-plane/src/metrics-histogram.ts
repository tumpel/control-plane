import { z } from "zod";

export const HISTOGRAM_MAX_BUCKETS = 160;
export const HISTOGRAM_START_SCALE = 3;

const BucketsSchema = z.object({
  offset: z.number().int(),
  bucketCounts: z.array(z.number().int().nonnegative()),
});

const ExponentialHistogramSchema = z.object({
  scale: z.number().int(),
  zeroCount: z.number().int().nonnegative(),
  positive: BucketsSchema,
  negative: BucketsSchema,
});

type Buckets = z.infer<typeof BucketsSchema>;
export type ExponentialHistogram = z.infer<typeof ExponentialHistogramSchema>;

export const parseHistogram = (stored: string): ExponentialHistogram => {
  const parsed = ExponentialHistogramSchema.safeParse(JSON.parse(stored));
  if (parsed.success) return parsed.data;
  throw new Error(
    `a stored rollup histogram is not an exponential histogram: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}; the metrics store wrote it, so its rollup row is corrupt`,
  );
};

const bucketIndex = (magnitude: number, scale: number): number => Math.ceil(Math.log2(magnitude) * 2 ** scale) - 1;

const shifted = (index: number, change: number): number => Math.floor(index / 2 ** change);

interface IndexRange {
  low: number;
  high: number;
}

const rangeOf = (indexes: readonly number[]): IndexRange | undefined =>
  indexes.length === 0 ? undefined : { low: Math.min(...indexes), high: Math.max(...indexes) };

const bucketsRange = (buckets: Buckets): IndexRange | undefined =>
  buckets.bucketCounts.length === 0
    ? undefined
    : { low: buckets.offset, high: buckets.offset + buckets.bucketCounts.length - 1 };

const union = (ranges: readonly (IndexRange | undefined)[]): IndexRange | undefined =>
  ranges.reduce<IndexRange | undefined>((joined, range) => {
    if (range === undefined) return joined;
    if (joined === undefined) return range;
    return { low: Math.min(joined.low, range.low), high: Math.max(joined.high, range.high) };
  }, undefined);

const changeToFit = (range: IndexRange | undefined): number => {
  if (range === undefined) return 0;
  let change = 0;
  while (shifted(range.high, change) - shifted(range.low, change) + 1 > HISTOGRAM_MAX_BUCKETS) change += 1;
  return change;
};

const added = (into: Map<number, number>, buckets: Buckets, change: number): void => {
  buckets.bucketCounts.forEach((count, position) => {
    const index = shifted(buckets.offset + position, change);
    into.set(index, (into.get(index) ?? 0) + count);
  });
};

const bucketsOf = (counts: Map<number, number>): Buckets => {
  const range = rangeOf([...counts.keys()]);
  if (range === undefined) return { offset: 0, bucketCounts: [] };
  const bucketCounts = Array.from({ length: range.high - range.low + 1 }, (_, position) => {
    return counts.get(range.low + position) ?? 0;
  });
  return { offset: range.low, bucketCounts };
};

const countedAt = (indexes: readonly number[], change: number): Buckets => {
  const counts = new Map<number, number>();
  for (const index of indexes) {
    const at = shifted(index, change);
    counts.set(at, (counts.get(at) ?? 0) + 1);
  }
  return bucketsOf(counts);
};

export const histogramOf = (values: readonly number[]): ExponentialHistogram => {
  const positive = values.filter((value) => value > 0).map((value) => bucketIndex(value, HISTOGRAM_START_SCALE));
  const negative = values.filter((value) => value < 0).map((value) => bucketIndex(-value, HISTOGRAM_START_SCALE));
  const change = Math.max(changeToFit(rangeOf(positive)), changeToFit(rangeOf(negative)));
  return {
    scale: HISTOGRAM_START_SCALE - change,
    zeroCount: values.length - positive.length - negative.length,
    positive: countedAt(positive, change),
    negative: countedAt(negative, change),
  };
};

const mergedSide = (
  left: Buckets,
  leftChange: number,
  right: Buckets,
  rightChange: number,
  change: number,
): Buckets => {
  const counts = new Map<number, number>();
  added(counts, left, leftChange + change);
  added(counts, right, rightChange + change);
  return bucketsOf(counts);
};

const rescaledRange = (buckets: Buckets, change: number): IndexRange | undefined => {
  const range = bucketsRange(buckets);
  return range === undefined ? undefined : { low: shifted(range.low, change), high: shifted(range.high, change) };
};

export const mergeHistograms = (left: ExponentialHistogram, right: ExponentialHistogram): ExponentialHistogram => {
  const scale = Math.min(left.scale, right.scale);
  const leftChange = left.scale - scale;
  const rightChange = right.scale - scale;
  const change = Math.max(
    changeToFit(union([rescaledRange(left.positive, leftChange), rescaledRange(right.positive, rightChange)])),
    changeToFit(union([rescaledRange(left.negative, leftChange), rescaledRange(right.negative, rightChange)])),
  );
  return {
    scale: scale - change,
    zeroCount: left.zeroCount + right.zeroCount,
    positive: mergedSide(left.positive, leftChange, right.positive, rightChange, change),
    negative: mergedSide(left.negative, leftChange, right.negative, rightChange, change),
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
