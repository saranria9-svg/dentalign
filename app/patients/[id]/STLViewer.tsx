"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { applyProceduralDentalColors } from "./dentalColoring";
import { segmentToothGum, type Jaw } from "./meshsegnet/segment";

export type ArchVisibility = "both" | "upper" | "lower";

// One treatment stage's raw STL buffers (a 3Shape "SubsetupN" folder, the
// initial scan, or — for imports with no staging at all — the single
// scan wrapped as a one-element list by the caller).
export interface ScanStageInput {
  label: string;
  upperBuffer: ArrayBuffer | null;
  lowerBuffer: ArrayBuffer | null;
}

interface Viewer3DProps {
  stages: ScanStageInput[];
}

type MlStatus = "idle" | "running" | "done" | "unavailable";

interface GeometryState {
  geometry: THREE.BufferGeometry | null;
  error: string | null;
  mlStatus: MlStatus;
}

function setToothGumColors(
  geometry: THREE.BufferGeometry,
  labels: Uint8Array,
  toothColor: string,
  gumColor: string
) {
  const tooth = new THREE.Color(toothColor);
  const gum = new THREE.Color(gumColor);
  const cellCount = geometry.attributes.position.count / 3;
  const colors = new Float32Array(cellCount * 3 * 3);
  for (let t = 0; t < cellCount; t++) {
    const c = labels[t] === 0 ? gum : tooth;
    for (let v = 0; v < 3; v++) {
      const idx = (t * 3 + v) * 3;
      colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

// Per-stage, per-jaw geometry cache. Each stage's STL is only ever parsed
// and segmented once: switching stages (manually, via autoplay, or during
// video export) reuses whatever's already in the cache instead of
// reprocessing, and a segmentation that finishes after the user has moved
// on to another stage still lands in its own cache entry — so coming back
// later shows the AI-refined result immediately rather than redoing it.
//
// The STL parse + procedural coloring happen synchronously during render
// (memoized into `cacheRef`, keyed by stage+jaw, so each buffer is only
// ever parsed once) rather than inside a useEffect. Doing it in an effect
// meant that on every stage switch there was a render where the new key
// wasn't in the cache yet — `geometry` was briefly null, `hasAny` false,
// and the whole model (or even the whole Canvas, since it's only mounted
// when `hasAny`) flashed away to the "Aucun modèle 3D importé" placeholder
// before the effect caught up a moment later. Only the actual MeshSegNet
// segmentation (genuinely async, ~10s) stays in an effect.
function useStageGeometry(
  stages: ScanStageInput[],
  stageIndex: number,
  jaw: Jaw,
  toothColor: string,
  gumColor: string
): GeometryState {
  const cacheRef = useRef<Map<string, GeometryState>>(new Map());
  const startedRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const key = `${jaw}-${stageIndex}`;
  const stage = stages[stageIndex];
  const buffer = stage ? (jaw === "upper" ? stage.upperBuffer : stage.lowerBuffer) : null;

  if (buffer && !cacheRef.current.has(key)) {
    try {
      const loader = new STLLoader();
      // Copy the buffer: STLLoader.parse reads it as-is and we don't want
      // downstream consumers of the original ArrayBuffer to be affected.
      const geometry = loader.parse(buffer.slice(0)) as THREE.BufferGeometry & {
        hasColors?: boolean;
      };
      geometry.computeVertexNormals();
      // Plain 3Shape STL exports carry no color at all. The one exception
      // is the "Magics" binary STL color extension, which STLLoader already
      // decodes into a real per-facet "color" attribute (geometry.hasColors)
      // — when present, that's real scan color and takes priority over any
      // guesswork. Otherwise, show an immediate procedural ivory/gum
      // estimate, then refine it in the background with the MeshSegNet ONNX
      // model (real tooth/gingiva segmentation, ~10s client-side) once it's
      // ready — the procedural pass means the viewer never sits blank while
      // that runs, and works just as well when flipping through stages.
      if (!geometry.hasColors) {
        applyProceduralDentalColors(geometry, { toothColor, gumColor });
        cacheRef.current.set(key, { geometry, error: null, mlStatus: "running" });
      } else {
        cacheRef.current.set(key, { geometry, error: null, mlStatus: "unavailable" });
      }
    } catch (error) {
      console.error("Erreur de lecture du fichier STL :", error);
      cacheRef.current.set(key, {
        geometry: null,
        error: "Impossible de lire ce fichier STL.",
        mlStatus: "idle",
      });
    }
  }

  useEffect(() => {
    const entry = cacheRef.current.get(key);
    if (!entry || !entry.geometry || entry.mlStatus !== "running") return;
    if (startedRef.current.has(key)) return; // already segmenting or done
    startedRef.current.add(key);
    const geometry = entry.geometry;

    segmentToothGum(geometry, jaw)
      .then((labels) => {
        setToothGumColors(geometry, labels, toothColor, gumColor);
        geometry.attributes.color.needsUpdate = true;
        cacheRef.current.set(key, { geometry, error: null, mlStatus: "done" });
        setTick((t) => t + 1);
      })
      .catch((mlError) => {
        console.error("Segmentation MeshSegNet indisponible :", mlError);
        cacheRef.current.set(key, { geometry, error: null, mlStatus: "unavailable" });
        setTick((t) => t + 1);
      });
  }, [key, jaw, toothColor, gumColor]);

  return cacheRef.current.get(key) ?? { geometry: null, error: null, mlStatus: buffer ? "running" : "idle" };
}

// Enamel-like material: low metalness, a soft clearcoat for the moist/glossy
// tooth surface, and a touch of physically-based transmission so light
// grazes through thin edges the way real enamel does. Values are kept
// subtle (not a full subsurface-scattering shader) to stay cheap enough for
// real-time rendering of two meshes.
function JawMesh({
  geometry,
  fallbackColor,
}: {
  geometry: THREE.BufferGeometry;
  fallbackColor: string;
}) {
  // Vertex colors carry the tooth/gum split (either real scan color or the
  // procedural ivory/gum estimate computed in useStageGeometry). The
  // material color is left white so it doesn't tint them; fallbackColor
  // only kicks in for the unexpected case where no color attribute made it
  // through.
  const hasVertexColors = geometry.hasAttribute("color");
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
      <meshPhysicalMaterial
        color={hasVertexColors ? "#ffffff" : fallbackColor}
        vertexColors={hasVertexColors}
        roughness={0.22}
        metalness={0}
        clearcoat={0.6}
        clearcoatRoughness={0.15}
        transmission={0.18}
        thickness={1.5}
        ior={1.5}
        attenuationColor="#e8c99b"
        attenuationDistance={1.4}
        envMapIntensity={0.9}
      />
    </mesh>
  );
}

const VISIBILITY_OPTIONS: { value: ArchVisibility; label: string }[] = [
  { value: "both", label: "Les deux arcades" },
  { value: "upper", label: "Maxillaire" },
  { value: "lower", label: "Mandibulaire" },
];

const UPPER_TOOTH_COLOR = "#f4ecd9";
const LOWER_TOOTH_COLOR = "#f1e6cf";
const UPPER_GUM_COLOR = "#e3a39a";
const LOWER_GUM_COLOR = "#e0958b";

const STAGE_HOLD_MS = 1200;

export default function STLViewer({ stages }: Viewer3DProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [autoPlaying, setAutoPlaying] = useState(false);

  // Clamp when a new scan with fewer stages gets imported.
  useEffect(() => {
    setStageIndex((i) => Math.min(i, Math.max(0, stages.length - 1)));
  }, [stages.length]);

  const currentStage = stages[stageIndex] as ScanStageInput | undefined;
  const upper = useStageGeometry(stages, stageIndex, "upper", UPPER_TOOTH_COLOR, UPPER_GUM_COLOR);
  const lower = useStageGeometry(stages, stageIndex, "lower", LOWER_TOOTH_COLOR, LOWER_GUM_COLOR);

  const [visibility, setVisibility] = useState<ArchVisibility>("both");
  const [autoRotate, setAutoRotate] = useState(false);
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const hasUpper = upper.geometry !== null;
  const hasLower = lower.geometry !== null;
  const hasAny = hasUpper || hasLower;
  const mlRunning = upper.mlStatus === "running" || lower.mlStatus === "running";
  const hasMultipleStages = stages.length > 1;

  // <Stage>'s adjustCamera re-fits/re-centers the camera on the bounding box
  // of whatever's currently displayed. That's the right behaviour the first
  // time a model appears (or when toggling which arch is shown), but
  // clear-aligner movement between stages is only a millimeter or two on a
  // several-centimeter arch — refitting the camera on every stage switch
  // recenters/rescales the view to compensate, which visually cancels out
  // that movement instead of letting the practitioner see it. Only allow a
  // refit once per "reason to refit" (first load, or an arch visibility
  // change), not on every stageIndex change.
  const [fitToken, setFitToken] = useState(0);
  const prevVisibilityRef = useRef(visibility);
  useEffect(() => {
    if (prevVisibilityRef.current !== visibility) {
      prevVisibilityRef.current = visibility;
      setFitToken((t) => t + 1);
    }
  }, [visibility]);
  const fittedTokenRef = useRef(-1);
  const shouldAdjustCamera = hasAny && fittedTokenRef.current !== fitToken;
  if (shouldAdjustCamera) fittedTokenRef.current = fitToken;

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Auto-play: step through stages on a timer until the last one, then stop.
  useEffect(() => {
    if (!autoPlaying) return;
    const interval = setInterval(() => {
      setStageIndex((i) => {
        if (i >= stages.length - 1) {
          setAutoPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, STAGE_HOLD_MS);
    return () => clearInterval(interval);
  }, [autoPlaying, stages.length]);

  function resetView() {
    controlsRef.current?.reset();
  }

  function goToPreviousStage() {
    setStageIndex((i) => Math.max(0, i - 1));
  }

  function goToNextStage() {
    setStageIndex((i) => Math.min(stages.length - 1, i + 1));
  }

  function toggleAutoPlay() {
    setAutoPlaying((wasPlaying) => {
      // Replaying from a finished sequence should restart from the beginning
      // rather than immediately stop again at the last stage.
      if (!wasPlaying && stageIndex === stages.length - 1) {
        setStageIndex(0);
      }
      return !wasPlaying;
    });
  }

  function createVideo() {
    setAutoPlaying(false);
    if (hasMultipleStages) {
      createStagesVideo();
    } else {
      createSingleStageVideo();
    }
  }

  // Original behaviour, unchanged: 8s of camera rotation on the one model.
  function createSingleStageVideo() {
    const canvas = canvasContainerRef.current?.querySelector("canvas");
    if (!canvas) {
      setVideoError("Le rendu 3D n'est pas encore prêt.");
      return;
    }

    setVideoError(null);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      // The cleanup in the effect above revokes the previous object URL
      // whenever `videoUrl` changes (and on unmount), so we only need to
      // create the new one here.
      setVideoUrl(URL.createObjectURL(blob));
      setRecording(false);
    };

    setRecording(true);
    setAutoRotate(true);
    recorder.start();

    setTimeout(() => recorder.stop(), 8000);
  }

  // Records the whole treatment evolution: restarts from stage 1, keeps the
  // camera rotating continuously, and advances one stage every
  // STAGE_HOLD_MS until the last one, using whichever geometry (AI-refined
  // or still-procedural) is already cached for each stage at the moment it
  // appears on screen — never blocking on segmentation.
  function createStagesVideo() {
    const canvas = canvasContainerRef.current?.querySelector("canvas");
    if (!canvas) {
      setVideoError("Le rendu 3D n'est pas encore prêt.");
      return;
    }

    setVideoError(null);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      setVideoUrl(URL.createObjectURL(blob));
      setRecording(false);
    };

    setRecording(true);
    setAutoRotate(true);
    setStageIndex(0);
    recorder.start();

    let index = 0;
    const advance = () => {
      index += 1;
      if (index >= stages.length) {
        recorder.stop();
        return;
      }
      setStageIndex(index);
      setTimeout(advance, STAGE_HOLD_MS);
    };
    setTimeout(advance, STAGE_HOLD_MS);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap gap-1 rounded-full bg-slate-100 p-1 text-sm">
          {VISIBILITY_OPTIONS.map((option) => {
            const disabled =
              (option.value === "upper" && !hasUpper) ||
              (option.value === "lower" && !hasLower) ||
              (option.value === "both" && !hasAny);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => setVisibility(option.value)}
                className={`rounded-full px-3 py-1.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  visibility === option.value
                    ? "bg-white text-blue-600 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mlRunning && (
            <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              Segmentation IA des dents/gencives…
            </span>
          )}
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              autoRotate
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Rotation auto
          </button>
          <button
            type="button"
            onClick={resetView}
            disabled={!hasAny}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Réinitialiser la vue
          </button>
          <button
            type="button"
            onClick={createVideo}
            disabled={!hasAny || recording}
            className="rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {recording ? "🎥 Enregistrement…" : "🎥 Créer une vidéo"}
          </button>
        </div>
      </div>

      {hasMultipleStages && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={goToPreviousStage}
              disabled={stageIndex === 0 || autoPlaying || recording}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Précédent
            </button>
            <span className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
              {currentStage?.label ?? "—"} · {stageIndex + 1}/{stages.length}
            </span>
            <button
              type="button"
              onClick={goToNextStage}
              disabled={stageIndex === stages.length - 1 || autoPlaying || recording}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Suivant →
            </button>
          </div>
          <button
            type="button"
            onClick={toggleAutoPlay}
            disabled={recording}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              autoPlaying
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
            }`}
          >
            {autoPlaying ? "⏸ Pause" : "▶ Lecture automatique"}
          </button>
        </div>
      )}

      <div ref={canvasContainerRef} className="h-[520px] w-full bg-slate-50">
        {hasAny ? (
          <Canvas shadows camera={{ position: [0, 40, 110], fov: 45 }}>
            <color attach="background" args={["#f1f5f9"]} />
            {/*
              A hemisphere light stands in for ambient fill instead of a flat
              ambientLight: cool tone from above, warm bounce from below,
              which reads much closer to real operatory lighting on enamel.
            */}
            <hemisphereLight args={["#dce8ff", "#8a7d6e", 0.55]} />
            <directionalLight
              position={[40, 60, 40]}
              intensity={1.6}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0004}
            >
              {/*
                The default directional-light shadow frustum (±5 units) is
                far too tight for a full dental arch and silently clips the
                shadow; widen it to cover the model.
              */}
              <orthographicCamera attach="shadow-camera" args={[-80, 80, 80, -80, 1, 300]} />
            </directionalLight>
            <directionalLight position={[-40, 20, -30]} intensity={0.45} color="#fff1e0" />
            {/*
              `environment={null}` disables Stage's default HDRI reflection
              map (which otherwise fetches a remote asset from a CDN). A
              chairside app needs to render reliably without depending on
              internet access, so we rely on the lights above instead.
            */}
            <Stage
              environment={null}
              intensity={0.5}
              shadows={{ type: "contact", opacity: 0.5, blur: 2.5, size: 2048 }}
              adjustCamera={shouldAdjustCamera ? 1.3 : false}
            >
              {(visibility === "both" || visibility === "upper") &&
                upper.geometry && (
                  <JawMesh geometry={upper.geometry} fallbackColor={UPPER_TOOTH_COLOR} />
                )}
              {(visibility === "both" || visibility === "lower") &&
                lower.geometry && (
                  <JawMesh geometry={lower.geometry} fallbackColor={LOWER_TOOTH_COLOR} />
                )}
            </Stage>
            <OrbitControls
              ref={controlsRef}
              makeDefault
              autoRotate={autoRotate}
              autoRotateSpeed={1.2}
              enablePan
              enableZoom
              enableRotate
              minDistance={20}
              maxDistance={400}
            />
          </Canvas>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400">
            <span className="text-4xl">🦷</span>
            <p className="text-sm">Aucun modèle 3D importé pour ce patient</p>
          </div>
        )}
      </div>

      {(upper.error || lower.error || videoError) && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
          {upper.error || lower.error || videoError}
        </div>
      )}

      {videoUrl && (
        <div className="border-t border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Vidéo générée
          </h3>
          <video
            src={videoUrl}
            controls
            className="mt-2 w-full max-w-md rounded-xl"
          />
        </div>
      )}
    </div>
  );
}
