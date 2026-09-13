import { ADMIN_PASSPHRASE } from "./config.js";
import {
  createTournament, watchTournaments, getTournament, updateTournament,
  createTeam, watchTeams, updateTeam, deleteTeam, addTeamMember, removeTeamMember,
  saveMatches, clearMatches, watchMatches, setMatchResult, actMatch,
} from "./db.js";
import { splitIntoGroups, scheduleMatches, computeStandings } from "./schedule.js";

// ---------- AUTH (bootstrap simple, comme agenda-conseil) ----------
const loginScreen = document.getElementById("login-screen");
const app = document.getElementById("app");

document.getElementById("btn-login").addEventListener("click", () => {
  const pass = document.getElementById("admin-password").value;
  if (pass === ADMIN_PASSPHRASE) {
    loginScreen.hidden = true;
    app.hidden = false;
    init();
  } else {
    document.getElementById("login-error").textContent = "Mot de passe incorrect.";
  }
});

// ---------- ETAT ----------
let currentTournamentId = null;
let currentTournament = null;
let teams = [];
let matches = [];

function init() {
  watchTournaments((list) => {
    const select = document.getElementById("select-tournament");
    select.innerHTML = list.map((t) => `<option value="${t.id}">${t.nom}</option>`).join("");
    if (list.length && !currentTournamentId) {
      selectTournament(list[0].id);
    }
  });

  document.getElementById("select-tournament").addEventListener("change", (e) => {
    selectTournament(e.target.value);
  });

  document.getElementById("btn-new-tournament").addEventListener("click", () => {
    document.getElementById("new-tournament-form").hidden = false;
  });

  document.getElementById("btn-create-tournament").addEventListener("click", async () => {
    const id = await createTournament({
      nom: document.getElementById("nt-nom").value,
      nbGroupes: Number(document.getElementById("nt-nbgroupes").value),
      nbTerrains: Number(document.getElementById("nt-nbterrains").value),
      dureeMatch: Number(document.getElementById("nt-duree").value),
      duréePause: Number(document.getElementById("nt-pause").value),
      dateDebut: document.getElementById("nt-date").value,
      heureDebut: document.getElementById("nt-heure").value,
    });
    document.getElementById("new-tournament-form").hidden = true;
    selectTournament(id);
  });

  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((s) => (s.hidden = true));
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      if (btn.dataset.tab === "resultats") renderResultsForm();
      if (btn.dataset.tab === "classement") renderStandings();
    });
  });

  document.getElementById("btn-add-team").addEventListener("click", async () => {
    const nom = document.getElementById("eq-nom").value.trim();
    const password = document.getElementById("eq-password").value.trim();
    if (!nom || !password) return alert("Nom et mot de passe capitaine obligatoires.");
    await createTeam(currentTournamentId, {
      nom,
      capitainePassword: password,
      preferenceTerrain: document.getElementById("eq-terrain-pref").value || null,
    });
    document.getElementById("eq-nom").value = "";
    document.getElementById("eq-password").value = "";
    document.getElementById("eq-terrain-pref").value = "";
  });

  document.getElementById("btn-generate-schedule").addEventListener("click", async () => {
    if (!teams.length) return alert("Ajoute d'abord des équipes.");
    const groupes = splitIntoGroups(teams, currentTournament.nbGroupes);
    // assigne le nom de groupe aux équipes
    for (const g of groupes) {
      for (const eq of g.equipes) {
        if (eq.groupe !== g.nom) await updateTeam(currentTournamentId, eq.id, { groupe: g.nom });
      }
    }
    const generated = scheduleMatches({
      groupes,
      nbTerrains: currentTournament.nbTerrains,
      dureeMatch: currentTournament.dureeMatch,
      duréePause: currentTournament.duréePause,
      heureDebut: currentTournament.heureDebut,
      dateDebut: currentTournament.dateDebut,
    });
    await saveMatches(currentTournamentId, generated);
    alert(`${generated.length} matchs générés.`);
  });

  document.getElementById("btn-clear-schedule").addEventListener("click", async () => {
    if (confirm("Effacer tous les matchs générés ?")) await clearMatches(currentTournamentId);
  });
}

function selectTournament(id) {
  currentTournamentId = id;
  document.getElementById("select-tournament").value = id;
  document.getElementById("tabs").hidden = false;

  getTournament(id).then((t) => (currentTournament = t));

  watchTeams(id, (list) => {
    teams = list;
    renderTeams();
  });

  watchMatches(id, (list) => {
    matches = list;
    renderMatches();
  });
}

function renderTeams() {
  const tbody = document.getElementById("teams-table");
  tbody.innerHTML = teams
    .map(
      (t) => `
    <tr>
      <td>${t.nom}</td>
      <td>${t.groupe || "-"}</td>
      <td>
        <select data-team="${t.id}" class="statut-select">
          <option value="en_attente" ${t.statut === "en_attente" ? "selected" : ""}>En attente</option>
          <option value="confirmée" ${t.statut === "confirmée" ? "selected" : ""}>Confirmée</option>
          <option value="forfait" ${t.statut === "forfait" ? "selected" : ""}>Forfait</option>
        </select>
      </td>
      <td>
        <select data-team-paiement="${t.id}" class="paiement-select">
          <option value="non_payé" ${t.statutPaiement === "non_payé" ? "selected" : ""}>Non payé</option>
          <option value="payé" ${t.statutPaiement === "payé" ? "selected" : ""}>Payé</option>
        </select>
      </td>
      <td>${(t.membres || []).length} joueur(s)</td>
      <td><button data-del="${t.id}" class="danger">Supprimer</button></td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll(".statut-select").forEach((sel) =>
    sel.addEventListener("change", (e) =>
      updateTeam(currentTournamentId, e.target.dataset.team, { statut: e.target.value })
    )
  );
  tbody.querySelectorAll(".paiement-select").forEach((sel) =>
    sel.addEventListener("change", (e) =>
      updateTeam(currentTournamentId, e.target.dataset.teamPaiement, { statutPaiement: e.target.value })
    )
  );
  tbody.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer cette équipe ?")) deleteTeam(currentTournamentId, btn.dataset.del);
    })
  );
}

function teamName(id) {
  return teams.find((t) => t.id === id)?.nom || "?";
}

function renderMatches() {
  const tbody = document.getElementById("matches-table");
  tbody.innerHTML = matches
    .map(
      (m) => `
    <tr>
      <td>${m.groupe}</td>
      <td>${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}</td>
      <td>${m.date}</td>
      <td>${m.heure}</td>
      <td>${m.terrain}</td>
      <td><span class="badge ${m.statut === "acté" ? "acte" : "propose"}">${m.statut}</span></td>
      <td>${m.statut !== "acté" ? `<button data-act="${m.id}" class="secondaire">Acter</button>` : ""}</td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => actMatch(currentTournamentId, btn.dataset.act))
  );
}

function renderResultsForm() {
  const container = document.getElementById("matches-to-encode");
  container.innerHTML = matches
    .map(
      (m) => `
    <div class="card" style="margin-bottom:10px;">
      <strong>${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}</strong>
      <span class="muted"> — ${m.groupe} — ${m.date} ${m.heure} — ${m.terrain}</span>
      <div class="grille-form" style="margin-top:8px;">
        <input type="number" min="0" placeholder="Score ${teamName(m.equipeAId)}" data-score-a="${m.id}" value="${m.scoreA ?? ""}" />
        <input type="number" min="0" placeholder="Score ${teamName(m.equipeBId)}" data-score-b="${m.id}" value="${m.scoreB ?? ""}" />
        <select data-statut-match="${m.id}">
          <option value="joué" ${m.statutMatch === "joué" ? "selected" : ""}>Joué</option>
          <option value="interrompu" ${m.statutMatch === "interrompu" ? "selected" : ""}>Interrompu</option>
          <option value="forfait" ${m.statutMatch === "forfait" ? "selected" : ""}>Forfait</option>
          <option value="reporté" ${m.statutMatch === "reporté" ? "selected" : ""}>Reporté</option>
        </select>
        <button data-save-result="${m.id}">Enregistrer</button>
      </div>
    </div>`
    )
    .join("");

  container.querySelectorAll("[data-save-result]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.saveResult;
      const scoreA = Number(container.querySelector(`[data-score-a="${id}"]`).value);
      const scoreB = Number(container.querySelector(`[data-score-b="${id}"]`).value);
      const statutMatch = container.querySelector(`[data-statut-match="${id}"]`).value;
      await setMatchResult(currentTournamentId, id, { scoreA, scoreB, statutMatch });
      alert("Résultat enregistré — classement mis à jour.");
    })
  );
}

function renderStandings() {
  const container = document.getElementById("classements-container");
  const groupes = [...new Set(teams.map((t) => t.groupe).filter(Boolean))].sort();

  if (!groupes.length) {
    container.innerHTML = `<p class="muted">Génère d'abord le calendrier pour voir les classements par groupe.</p>`;
    return;
  }

  container.innerHTML = groupes
    .map((g) => {
      const equipesGroupe = teams.filter((t) => t.groupe === g);
      const matchsGroupe = matches.filter((m) => m.groupe === g);
      const classement = computeStandings(equipesGroupe, matchsGroupe, currentTournament.regleClassement);
      return `
      <div class="card">
        <h2>Groupe ${g}</h2>
        <table>
          <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>BM</th><th>BE</th><th>Diff</th><th>Pts</th></tr></thead>
          <tbody>
            ${classement
              .map(
                (s, i) => `<tr>
                <td>${i + 1}</td><td>${s.nom}</td><td>${s.joues}</td><td>${s.victoires}</td>
                <td>${s.nuls}</td><td>${s.defaites}</td><td>${s.butsMarques}</td>
                <td>${s.butsEncaisses}</td><td>${s.diffButs}</td><td><strong>${s.points}</strong></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
    })
    .join("");
}
