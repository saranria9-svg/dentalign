export default function AjouterPatient() {
  return (
    <main style={{ padding: 40, fontFamily: "Arial" }}>
      <a href="/">← Retour</a>

      <h1>Ajouter un patient</h1>

      <form
        style={{ marginTop: 20 }}
      >
        <input placeholder="Nom" style={{ display: "block", marginBottom: 10, padding: 8 }} />
        <input placeholder="Prénom" style={{ display: "block", marginBottom: 10, padding: 8 }} />
        <input placeholder="Âge" style={{ display: "block", marginBottom: 10, padding: 8 }} />
        <input placeholder="Traitement" style={{ display: "block", marginBottom: 10, padding: 8 }} />
        <input placeholder="Praticien" style={{ display: "block", marginBottom: 10, padding: 8 }} />

        <select style={{ display: "block", marginBottom: 10, padding: 8 }}>
          <option>Nanteuil</option>
          <option>Bussy-Saint-Georges</option>
          <option>Serris</option>
        </select>

        <button type="submit" style={{ padding: 10 }}>
          Enregistrer
        </button>
      </form>
    </main>
  );
}