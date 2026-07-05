// Calibrates a per-arch-bucket tooth/gum height threshold from one stage's
// real MeshSegNet output, then re-applies that same fixed threshold to
// every other stage's mesh directly (no ML, no decimation — just a height
// check) instead of re-running independent segmentation per stage.
//
// Real ClearAligner treatment moves teeth; the gum tissue itself barely
// shifts stage to stage. Re-running MeshSegNet independently per stage let
// ordinary model noise/variance draw the boundary a little differently
// each time, which reads as the gum sliding around between stages even
// though nothing there actually changed. Learning the boundary once (from
// the reference stage's own labels, not a generic assumption) and locking
// every other stage to that exact profile keeps it visually identical
// everywhere — matching how dedicated orthodontic software (3Shape/
// ClinCheck) only animates the teeth while the gum stays put — while still
// being cheap enough to run for every stage at import time.
import { computeBucketedHeights } from "./archBuckets";

export interface GumProfile {
  bucketCount: number;
  /** Per-bucket height-fraction threshold (0..1); a cell above it is tooth. */
  threshold: Float64Array;
}

/**
 * Learns the profile from one stage's decimated cells + the tooth(1)/
 * gingiva(0) labels MeshSegNet+graph-cut produced for them.
 */
export function calibrateGumProfile(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  labels: Uint8Array,
  bucketCount = 48
): GumProfile {
  const { bucketOf, heightFraction } = computeBucketedHeights(bx, by, bz, bucketCount);

  const gumSum = new Float64Array(bucketCount);
  const gumCount = new Int32Array(bucketCount);
  const toothSum = new Float64Array(bucketCount);
  const toothCount = new Int32Array(bucketCount);
  let globalGumSum = 0;
  let globalGumCount = 0;
  let globalToothSum = 0;
  let globalToothCount = 0;

  for (let i = 0; i < labels.length; i++) {
    const b = bucketOf[i];
    if (labels[i] === 0) {
      gumSum[b] += heightFraction[i];
      gumCount[b]++;
      globalGumSum += heightFraction[i];
      globalGumCount++;
    } else {
      toothSum[b] += heightFraction[i];
      toothCount[b]++;
      globalToothSum += heightFraction[i];
      globalToothCount++;
    }
  }

  const globalGumAvg = globalGumCount > 0 ? globalGumSum / globalGumCount : 0.3;
  const globalToothAvg = globalToothCount > 0 ? globalToothSum / globalToothCount : 0.6;
  const globalThreshold = (globalGumAvg + globalToothAvg) / 2;

  const threshold = new Float64Array(bucketCount);
  for (let b = 0; b < bucketCount; b++) {
    // A bucket with no examples of one label (thin sliver of arch, or one
    // that happened to land entirely on one side) can't calibrate its own
    // threshold; fall back to the arch-wide average instead of guessing.
    threshold[b] =
      gumCount[b] > 0 && toothCount[b] > 0
        ? (gumSum[b] / gumCount[b] + toothSum[b] / toothCount[b]) / 2
        : globalThreshold;
  }
  return { bucketCount, threshold };
}

/**
 * Applies a previously-learned profile to any other mesh's cells — cheap
 * enough (no decimation, no ONNX, no graph-cut) to run on the full-
 * resolution mesh directly for every stage at import time.
 */
export function classifyByGumProfile(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  profile: GumProfile
): Uint8Array {
  const { bucketOf, heightFraction } = computeBucketedHeights(bx, by, bz, profile.bucketCount);
  const labels = new Uint8Array(bx.length);
  for (let i = 0; i < bx.length; i++) {
    labels[i] = heightFraction[i] > profile.threshold[bucketOf[i]] ? 1 : 0;
  }
  return labels;
}
