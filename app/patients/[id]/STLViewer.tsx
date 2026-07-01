
"use client";

import { useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage, useHelper } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";

function STLModel({
fileUrl,
position = [0, 0, 0],
rotation = [-Math.PI / 2, 0, 0],
}: {
fileUrl: string;
position?: [number, number, number];
rotation?: [number, number, number];
}) {

  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);

  if (!geometry) {
    const loader = new STLLoader();
    loader.load(fileUrl, (geo) => {
    geo.computeVertexNormals();

      const position = geo.attributes.position;
      const colors = [];

let minY = Infinity;
let maxY = -Infinity;
      
for (let i = 0; i < position.count; i++) {
const y = position.getY(i);
minY = Math.min(minY, y);
maxY = Math.max(maxY, y);
}


      const limiteGencive = minY + (maxY - minY) * 0.75;

      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);

        if (y < limiteGencive) {
          colors.push(0.9, 0.35, 0.45); // rose gencive
        } else {
          colors.push(1, 1, 0.95); // blanc dent
        }
      }

      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      setGeometry(geo);
    });
  }

  if (!geometry) return null;

  return (
    <mesh
geometry={geometry}
rotation={rotation}
position={position}
>
      <meshStandardMaterial
        vertexColors
        roughness={0.35}
        metalness={0}
      />
    </mesh>
  );
}

export default function STLViewer() {
  const [maxillaryUrl, setMaxillaryUrl] = useState<string | null>(null);
  const [mandibularUrl, setMandibularUrl] = useState<string | null>(null);
  
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const createVideo = () => {
    const canvas = document.querySelector("canvas");

    if (!canvas) {
      alert("Canvas 3D introuvable");
      return;
    }

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm",
    });

    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);

      const a = document.createElement("a");
      a.href = url;
      a.download = "simulation-3d.webm";
      a.click();

      URL.revokeObjectURL(url);
      setRecording(false);
    };

    setRecording(true);
    recorder.start();

    setTimeout(() => {
      recorder.stop();
    }, 10000);
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>


    <div style={{ marginBottom: 20 }}>
  <strong>Dossier 3Shape</strong>

  <br />
  <br />

  <input
    type="file"
    webkitdirectory=""
    directory=""
    multiple
    onChange={(e) => {
      console.log(e.target.files);
    }}
  />
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
  Dr Sivaprakasam<br />
  Simulation 3D Aligneurs
</div>
        <Canvas camera={{ position: [0, 0, 80] }}>
          <ambientLight intensity={6} />
          <directionalLight position={[20, 20, 20]} intensity={4} />

          <Stage>
{maxillaryUrl && (
<STLModel
fileUrl={maxillaryUrl}
rotation={[-Math.PI / 2, 0, 0]}
position={[0, 0, 0]}
/>
)}

{mandibularUrl && (
<STLModel
fileUrl={mandibularUrl}
rotation={[-Math.PI / 2, 0, 0]}
position={[0, 0, 0]}
/>
)}
</Stage>


          <OrbitControls autoRotate autoRotateSpeed={1} />
        </Canvas>
      </div>

      <button
        onClick={createVideo}
        disabled={!maxillaryUrl || !mandibularUrl || recording}
        style={{
          marginTop: 20,
          padding: 12,
          backgroundColor:
maxillaryUrl && mandibularUrl
? "#2563eb"
: "#9ca3af",
          color: "white",
          borderRadius: 10,
          border: "none",
          cursor:
maxillaryUrl && mandibularUrl
? "pointer"
: "not-allowed",
        }}
      >
        {recording ? "🎥 Création en cours..." : "🎥 Créer une vidéo"}
      </button>
{videoUrl && (
  <div style={{ marginTop: 20 }}>
    <h3>Vidéo générée</h3>
    <video
      src={videoUrl}
      controls
      style={{
        width: "100%",
        maxWidth: 600,
        borderRadius: 12,
      }}
    />
  </div>
)}
    </div>
  );
}