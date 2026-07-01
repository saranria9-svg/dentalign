"use client";

import { useState } from "react";

export default function Patients() {
  const [recherche, setRecherche] = useState("");
  const [cabinet, setCabinet] = useState("Tous");

  const patients = [
    { id: "1", nom: "Dupont", prenom: "Marie", lieu: "Nanteuil" },
{ id: "2", nom: "Martin", prenom: "Lucas", lieu: "Serris" },
{ id: "3", nom: "Durand", prenom: "Paul", lieu: "Bussy" },
{ id: "4", nom: "Lemoine", prenom: "Julie", lieu: "Nanteuil" },
  ];

  const patientsFiltres = patients.filter((p) => {
  const correspondRecherche =
    p.nom.toLowerCase().includes(recherche.toLowerCase()) ||
    p.prenom.toLowerCase().includes(recherche.toLowerCase());

  const correspondCabinet =
    cabinet === "Tous" || p.lieu === cabinet;

  return correspondRecherche && correspondCabinet;
});

  return (
    <main style={{ padding: 40, fontFamily: "Arial" }}>
      <h1>Liste des patients</h1>

      {/* Barre de recherche */}
      <input
        type="text"
        placeholder="Rechercher un patient..."
        value={recherche}
        onChange={(e) => setRecherche(e.target.value)}
        style={{ marginTop: 20, padding: 10, width: 300 }}
      />
<select
  value={cabinet}
  onChange={(e) => setCabinet(e.target.value)}
  style={{ marginLeft: 10, padding: 10 }}
>
  <option>Tous</option>
  <option>Nanteuil</option>
  <option>Bussy</option>
  <option>Serris</option>
</select>

      {/* Liste */}
      <div style={{ marginTop: 20 }}>
        {patientsFiltres.map((p) => (
          <div key={p.id} style={{ marginBottom: 15 }}>
            {p.prenom} {p.nom} 
            <a href={`/patients/${p.id}`} style={{ marginLeft: 10 }}>
              <button>Voir fiche</button>
            </a>
          </div>
        ))}
      </div>
    </main>
  );
}