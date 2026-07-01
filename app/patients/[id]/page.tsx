"use client";

import STLViewer from "./STLViewer";

export default async function Patient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const patients = {
    "1": {
      nom: "Dupont",
      prenom: "Marie",
      age: 35,
      traitement: "Aligneurs",
      praticien: "Dr Sivaprakasam",
      lieu: "Nanteuil",
      date: "03/05/2026",
    },
    "2": {
      nom: "Martin",
      prenom: "Lucas",
      age: 28,
      traitement: "Blanchiment",
      praticien: "Dr Sivaprakasam",
      lieu: "Serris",
      date: "02/05/2026",
    },
  };

  const patient = patients[id as keyof typeof patients];

  return (
    <main style={{ padding: 40, fontFamily: "Arial" }}>
      <a href="/patients">← Retour</a>

      <h1>Fiche patient</h1>

      {patient ? (
        <div>
          <p><strong>Nom :</strong> {patient.nom}</p>
          <p><strong>Prénom :</strong> {patient.prenom}</p>
          <p><strong>Âge :</strong> {patient.age}</p>
          <p><strong>Traitement :</strong> {patient.traitement}</p>
          <p><strong>Praticien :</strong> {patient.praticien}</p>
          <p><strong>Lieu :</strong> {patient.lieu}</p>
          <p><strong>Date :</strong> {patient.date}</p>

        </div>
      ) : (
        <p>Patient introuvable</p>
      )}

<hr style={{ marginTop: 30, marginBottom: 20 }} />

<h2>Fichiers 3D</h2>

<STLViewer />
<p style={{ marginTop: 10 }}>
  Importer ici le fichier STL exporté depuis 3Shape.
</p>
   
 </main>
  );
}