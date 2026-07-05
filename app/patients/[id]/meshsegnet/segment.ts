// Orchestrates the full client-side MeshSegNet pipeline — decimate ->
// build features/adjacency -> ONNX inference -> binary graph-cut -> KNN
// upsample to full resolution — entirely in the browser via
// onnxruntime-web. Validated (quality + performance) against the official
// Python/PyTorch + pygco reference pipeline before being wired in here.
//
// Model files and the WASM runtime are served locally from /public (not a
// CDN) so this keeps working without an internet connection, matching this
// app's existing "no CDN dependency" requirement (see STLViewer.tsx's
// comment on why Stage's environment map is disabled).

import * as THREE from "three";
import type * as OrtNamespace from "onnxruntime-web";
import { decimateToTargetCells } from "./decimate";
import { buildFeaturesAndAdjacency } from "./preprocess";
import { buildPairwiseEdges } from "./edges";
import { binaryGraphCut } from "./graphcut";
import { upsampleLabelsToFullRes } from "./upsample";

export type Jaw = "upper" | "lower";

const NUM_CLASSES = 15;
const TARGET_CELLS = 10000;
const MODEL_URLS: Record<Jaw, string> = {
  upper: "/models/meshsegnet_upper.onnx",
  lower: "/models/meshsegnet_lower.onnx",
};

// onnxruntime-web's threaded WASM backend spawns a Web Worker from its own
// script URL. Importing the npm package normally runs it through Turbopack,
// which rewrites that self-reference into an unservable `file://` path
// (verified: "Failed to construct 'Worker'... cannot be accessed from
// origin" at runtime). Loading the exact same file as a plain, unbundled
// module straight from /public — same as the wasm binary right next to it
// — keeps its internal worker URL resolution intact. `webpackIgnore` is
// respected by Turbopack too (see next.js turbopack docs) and skips
// bundling for this one dynamic import.
// A non-literal specifier so TypeScript treats this as an opaque dynamic
// import (Promise<any>) instead of trying to resolve "/ort/..." as a real
// module for type-checking.
const ORT_RUNTIME_URL: string = "/ort/ort.bundle.min.mjs";

let ortPromise: Promise<typeof OrtNamespace> | null = null;
function loadOrt(): Promise<typeof OrtNamespace> {
  if (!ortPromise) {
    ortPromise = import(/* webpackIgnore: true */ ORT_RUNTIME_URL).then(
      (mod: typeof OrtNamespace) => {
        mod.env.wasm.wasmPaths = "/ort/";
        if (typeof navigator !== "undefined") {
          mod.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
        }
        return mod;
      }
    );
  }
  return ortPromise;
}

const sessionCache = new Map<Jaw, Promise<OrtNamespace.InferenceSession>>();

async function getSession(jaw: Jaw): Promise<OrtNamespace.InferenceSession> {
  let session = sessionCache.get(jaw);
  if (!session) {
    session = loadOrt().then((ort) =>
      ort.InferenceSession.create(MODEL_URLS[jaw], {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      })
    );
    sessionCache.set(jaw, session);
  }
  return session;
}

export interface SegmentProgress {
  stage: "decimating" | "preprocessing" | "inferring" | "refining" | "upsampling" | "done";
}

/**
 * Segments a full-resolution jaw mesh into tooth (1) / gingiva (0) labels
 * per cell, aligned with `fullGeometry`'s (non-indexed) triangle order.
 */
export async function segmentToothGum(
  fullGeometry: THREE.BufferGeometry,
  jaw: Jaw,
  onProgress?: (p: SegmentProgress) => void
): Promise<Uint8Array> {
  onProgress?.({ stage: "decimating" });
  const decGeometry = decimateToTargetCells(fullGeometry, TARGET_CELLS);

  onProgress?.({ stage: "preprocessing" });
  const { X, A_S, A_L, nCells, normalX, normalY, normalZ, bx, by, bz } =
    buildFeaturesAndAdjacency(decGeometry);

  onProgress?.({ stage: "inferring" });
  const ort = await loadOrt();
  const session = await getSession(jaw);
  // X is [nCells,15] row-major; the model expects [1,15,nCells] (channels-first).
  const Xcf = new Float32Array(15 * nCells);
  for (let t = 0; t < nCells; t++) {
    for (let ch = 0; ch < 15; ch++) Xcf[ch * nCells + t] = X[t * 15 + ch];
  }
  const xTensor = new ort.Tensor("float32", Xcf, [1, 15, nCells]);
  const asTensor = new ort.Tensor("float32", A_S, [1, nCells, nCells]);
  const alTensor = new ort.Tensor("float32", A_L, [1, nCells, nCells]);
  const results = await session.run({ x: xTensor, a_s: asTensor, a_l: alTensor });
  const probs = results.probs.data as Float32Array; // [1, nCells, 15] flattened

  onProgress?.({ stage: "refining" });
  const roundFactor = 100;
  const unary0 = new Float64Array(nCells); // gingiva
  const unary1 = new Float64Array(nCells); // any tooth
  for (let i = 0; i < nCells; i++) {
    let pGum = probs[i * NUM_CLASSES + 0];
    let pTooth = 0;
    for (let k = 1; k < NUM_CLASSES; k++) pTooth += probs[i * NUM_CLASSES + k];
    pGum = Math.max(pGum, 1e-6);
    pTooth = Math.max(pTooth, 1e-6);
    unary0[i] = -roundFactor * Math.log10(pGum);
    unary1[i] = -roundFactor * Math.log10(pTooth);
  }
  const edges = buildPairwiseEdges(
    nCells, normalX, normalY, normalZ, bx, by, bz,
    decGeometry.attributes.position, 30, roundFactor
  );
  const refinedLabels = binaryGraphCut(nCells, unary0, unary1, edges);

  onProgress?.({ stage: "upsampling" });
  const fullPos = fullGeometry.attributes.position;
  const nFull = fullPos.count / 3;
  const fbx = new Float64Array(nFull), fby = new Float64Array(nFull), fbz = new Float64Array(nFull);
  let fcx = 0, fcy = 0, fcz = 0;
  for (let i = 0; i < fullPos.count; i++) { fcx += fullPos.getX(i); fcy += fullPos.getY(i); fcz += fullPos.getZ(i); }
  fcx /= fullPos.count; fcy /= fullPos.count; fcz /= fullPos.count;
  for (let t = 0; t < nFull; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    fbx[t] = (fullPos.getX(i0) + fullPos.getX(i1) + fullPos.getX(i2)) / 3 - fcx;
    fby[t] = (fullPos.getY(i0) + fullPos.getY(i1) + fullPos.getY(i2)) / 3 - fcy;
    fbz[t] = (fullPos.getZ(i0) + fullPos.getZ(i1) + fullPos.getZ(i2)) / 3 - fcz;
  }
  const fullLabels = upsampleLabelsToFullRes(bx, by, bz, refinedLabels, fbx, fby, fbz, 3);

  onProgress?.({ stage: "done" });
  return fullLabels;
}
