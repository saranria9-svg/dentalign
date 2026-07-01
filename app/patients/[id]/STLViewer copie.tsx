"use client";

import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";

const TOOTH_WHITE = "#f5f2ec";
const GINGIVA_PINK = "#e69590";
const MATERIAL_ROUGHNESS = 0.35;
const MATERIAL_METALNESS = 0;

type STLBufferGeometry = THREE.BufferGeometry & {
  hasColors?: boolean;
  alpha?: number;
};

type MaterialConfig =
  | { vertexColors: true; opacity: number }
  | { vertexColors: false; color: string };

const GINGIVA_NAME_PATTERN =
  /gingiva|gencive|gum|gums|soft.?tissue|mucosa|periodont/i;

function hasVariedVertexColors(geometry: THREE.BufferGeometry): boolean {
  const colors = geometry.attributes.color;
  if (!colors) return false;

  const array = colors.array as ArrayLike<number>;
  if (array.length < 6) return false;

  const r0 = array[0];
  const g0 = array[1];
  const b0 = array[2];

  for (let i = 3; i < array.length; i += 3) {
    if (
      Math.abs(array[i] - r0) > 0.02 ||
      Math.abs(array[i + 1] - g0) > 0.02 ||
      Math.abs(array[i + 2] - b0) > 0.02
    ) {
      return true;
    }
  }

  return false;
}

function isGingivaColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;

  return (
    saturation > 0.12 &&
    r > 0.35 &&
    r >= g - 0.04 &&
    r >= b - 0.04 &&
    (r > g + 0.06 || (r > 0.45 && g > 0.15 && b > 0.15))
  );
}

function applyGroupDentalColors(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const toothColor = new THREE.Color(TOOTH_WHITE);
  const gingivaColor = new THREE.Color(GINGIVA_PINK);
  const groupNames = geometry.userData.groupNames as string[] | undefined;

  for (let groupIndex = 0; groupIndex < geometry.groups.length; groupIndex++) {
    const group = geometry.groups[groupIndex];
    const name = groupNames?.[groupIndex] ?? "";
    const color = GINGIVA_NAME_PATTERN.test(name) ? gingivaColor : toothColor;

    for (let i = group.start; i < group.start + group.count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function applyHeuristicDentalColors(geometry: THREE.BufferGeometry) {
  const source = geometry.attributes.color;
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const toothColor = new THREE.Color(TOOTH_WHITE);
  const gingivaColor = new THREE.Color(GINGIVA_PINK);

  for (let i = 0; i < positions.count; i++) {
    const r = source.getX(i);
    const g = source.getY(i);
    const b = source.getZ(i);
    const color = isGingivaColor(r, g, b) ? gingivaColor : toothColor;

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function prepareDentalMaterial(geometry: THREE.BufferGeometry): MaterialConfig {
  geometry.computeVertexNormals();

  const stlGeometry = geometry as STLBufferGeometry;
  const opacity = stlGeometry.alpha ?? 1;

  if (hasVariedVertexColors(geometry)) {
    return { vertexColors: true, opacity };
  }

  if (geometry.groups.length > 1) {
    applyGroupDentalColors(geometry);
    return { vertexColors: true, opacity: 1 };
  }

  if (geometry.attributes.color) {
    applyHeuristicDentalColors(geometry);
    return { vertexColors: true, opacity: 1 };
  }

  return { vertexColors: false, color: TOOTH_WHITE };
}

function STLModel({ fileUrl }: { fileUrl: string }) {
  const [model, setModel] = useState<{
    geometry: THREE.BufferGeometry;
    materialConfig: MaterialConfig;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new STLLoader();

    loader.load(fileUrl, (geo: THREE.BufferGeometry) => {
      if (cancelled) {
        geo.dispose();
        return;
      }

      setModel({
        geometry: geo,
        materialConfig: prepareDentalMaterial(geo),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [fileUrl]);

  useEffect(() => {
    return () => {
      model?.geometry.dispose();
    };
  }, [model]);

  if (!model) return null;

  const { geometry, materialConfig } = model;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={
          materialConfig.vertexColors
            ? "#ffffff"
            : materialConfig.color
        }
        vertexColors={materialConfig.vertexColors}
        roughness={MATERIAL_ROUGHNESS}
        metalness={MATERIAL_METALNESS}
        transparent={materialConfig.vertexColors && materialConfig.opacity < 1}
        opacity={
          materialConfig.vertexColors ? materialConfig.opacity : 1
        }
      />
    </mesh>
  );
}

export default function STLViewer() {
  const [maxillaryUrl, setMaxillaryUrl] = useState<string | null>(null);
  const [mandibularUrl, setMandibularUrl] = useState<string | null>(null);

  const handleFileChange = (
    file: File | undefined,
    setter: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    if (!file) return;
    setter((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  useEffect(() => {
    return () => {
      if (maxillaryUrl) URL.revokeObjectURL(maxillaryUrl);
      if (mandibularUrl) URL.revokeObjectURL(mandibularUrl);
    };
  }, [maxillaryUrl, mandibularUrl]);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>
        <div>
          <p>
            <strong>Maxillaire</strong> (Maxillary.stl)
          </p>
          <input
            type="file"
            accept=".stl"
            onChange={(e) =>
              handleFileChange(e.target.files?.[0], setMaxillaryUrl)
            }
          />
        </div>

        <div>
          <p>
            <strong>Mandibule</strong> (Mandibular.stl)
          </p>
          <input
            type="file"
            accept=".stl"
            onChange={(e) =>
              handleFileChange(e.target.files?.[0], setMandibularUrl)
            }
          />
        </div>
      </div>

      <div
        style={{
          width: "100%",
          height: 500,
          background: "#e5e7eb",
          marginTop: 20,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 20,
            left: 20,
            color: "white",
            fontSize: 22,
            fontWeight: "bold",
            zIndex: 10,
          }}
        >
          Dr Sivaprakasam
          <br />
          Simulation 3D Aligneurs
        </div>

        <Canvas
          camera={{ position: [0, 0, 80], fov: 50 }}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.05,
          }}
          onCreated={({ gl }) => {
            gl.setClearColor("#e5e7eb");
          }}
        >
          <ambientLight intensity={0.45} />
          <hemisphereLight
            color="#ffffff"
            groundColor="#b8c0cc"
            intensity={0.55}
          />
          <directionalLight position={[60, 80, 50]} intensity={1.1} />
          <directionalLight position={[-50, 30, -40]} intensity={0.35} />
          <directionalLight position={[0, -30, 70]} intensity={0.25} />

          {maxillaryUrl && <STLModel fileUrl={maxillaryUrl} />}
          {mandibularUrl && <STLModel fileUrl={mandibularUrl} />}

          <OrbitControls autoRotate autoRotateSpeed={1} />
        </Canvas>
      </div>
    </div>
  );
}
