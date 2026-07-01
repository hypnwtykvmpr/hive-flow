/**
 * Local attention kernels for @hive-flow/cli/performance.
 *
 * These are deterministic TypeScript implementations used to avoid a hard
 * runtime dependency on external vector packages.
 */

export type AttentionVector = Float32Array | number[];

function toFloat32Array(input: AttentionVector): Float32Array {
  return input instanceof Float32Array ? input : new Float32Array(input);
}

function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function stableSoftmax(scores: number[]): number[] {
  if (scores.length === 0) return [];

  const max = Math.max(...scores);
  const exps = scores.map(score => Math.exp(score - max));
  const total = exps.reduce((sum, value) => sum + value, 0);

  if (!Number.isFinite(total) || total <= 0) {
    const uniform = 1 / scores.length;
    return scores.map(() => uniform);
  }

  return exps.map(value => value / total);
}

export function scaledDotProductAttention(
  queryInput: AttentionVector,
  keyInputs: AttentionVector[],
  valueInputs: AttentionVector[]
): Float32Array {
  const query = toFloat32Array(queryInput);
  const keys = keyInputs.map(toFloat32Array);
  const values = valueInputs.map(toFloat32Array);

  if (keys.length !== values.length) {
    throw new Error('keys and values must have the same length');
  }
  if (keys.length === 0) {
    return new Float32Array(query.length);
  }

  const scale = Math.sqrt(Math.max(1, query.length));
  const scores = keys.map(key => dot(query, key) / scale);
  const weights = stableSoftmax(scores);
  const outputLength = values[0]?.length ?? query.length;
  const output = new Float32Array(outputLength);

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const weight = weights[i];
    for (let j = 0; j < output.length; j++) {
      output[j] += (value[j] ?? 0) * weight;
    }
  }

  return output;
}

export function flashAttention(
  query: AttentionVector,
  keys: AttentionVector[],
  values: AttentionVector[],
  _blockSize = 64
): Float32Array {
  return scaledDotProductAttention(query, keys, values);
}
