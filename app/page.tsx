export default function Home() {
  return (
    <main style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      fontFamily: "Arial"
    }}>
      <h1>🦷 Application Aligneurs 3D</h1>
      <p>Bienvenue dans ton application interne cabinet</p>
      <a href="/patients">
  <button style={{
    marginTop: 20,
    padding: "10px 20px",
    fontSize: 16,
    cursor: "pointer"
  }}>
    Voir un patient
  </button>
</a>

<a href="/ajouter-patient">
  <button style={{
    marginTop: 10,
    padding: "10px 20px",
    fontSize: 16,
    cursor: "pointer"
  }}>
    Ajouter un patient
  </button>
</a>
</main>
);
}