import {
  watchTournaments, getTournament, watchTeams, watchMatches,
  findTeamByPassword, updateTeam, addTeamMember, removeTeamMember,
} from "./db.js";
import { computeStandings } from "./schedule.js";

let currentTournamentId = null;
let currentTournament = null;
let teams = [];
let matches = [];
let myTeam = null; // { tournamentId, teamId, ...données équipe } une fois connecté

// ---------- Tournoi sélectionné ----------
watchTournaments((list) => {
  const select = document.getElementById("select-tournament");
  select.innerHTML = list.map((t) => `<option value="${t.id}">${t.nom}</option>`).join("");
  if (list.length && !currentTournamentId) selectTournament(list[0].id);
});

document.getElementById("select-tournament").addEventListener("change", (e) => {
  selectTournament(e.target.value);
});

function selectTournament(id) {
  currentTournamentId = id;
  document.getElementById("select-tournament").value = id;
  getTournament(id).then((t) => {
    currentTournament = t;
    renderStandings();
  });
  watchTeams(id, (list) => {
    teams = list;
    renderStandings();
    if (myTeam && myTeam.tournamentId === id) renderMyTeam();
  });
  watchMatches(id, (list) => {
    matches = list;
    renderPublicMatches();
    renderStandings();
    if (myTeam && myTeam.tournamentId === id) renderMyTeam();
  });
}

// ---------- Onglets ----------
document.querySelectorAll("nav.tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((s) => (s.hidden = true));
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ---------- Vue publique : calendrier ----------
function teamName(id) {
  return teams.find((t) => t.id === id)?.nom || "?";
}

function renderPublicMatches() {
  const tbody = document.getElementById("public-matches");
  tbody.innerHTML = matches
    .map(
      (m) => `
    <tr>
      <td>${m.groupe}</td>
      <td>${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}</td>
      <td>${m.date}</td>
      <td>${m.heure}</td>
      <td>${m.terrain}</td>
      <td>${m.scoreA ?? "-"} : ${m.scoreB ?? "-"}</td>
      <td><span class="badge ${m.statut === "acté" ? "acte" : "propose"}">${m.statut}</span></td>
    </tr>`
    )
    .join("");
}

// ---------- Vue publique : classement ----------
function renderStandings() {
  const container = document.getElementById("public-classements");
  if (!currentTournament) return;
  const groupes = [...new Set(teams.map((t) => t.groupe).filter(Boolean))].sort();
  if (!groupes.length) {
    container.innerHTML = `<p class="muted">Le calendrier n'a pas encore été généré.</p>`;
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
          <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>Diff</th><th>Pts</th></tr></thead>
          <tbody>
            ${classement
              .map(
                (s, i) => `<tr>
                <td>${i + 1}</td><td>${s.nom}</td><td>${s.joues}</td><td>${s.victoires}</td>
                <td>${s.nuls}</td><td>${s.defaites}</td><td>${s.diffButs}</td><td><strong>${s.points}</strong></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
    })
    .join("");
}

// ---------- Connexion capitaine ----------
document.getElementById("btn-captain-login").addEventListener("click", async () => {
  const password = document.getElementById("captain-password").value;
  const found = await findTeamByPassword(password);
  if (!found) return alert("Mot de passe non reconnu.");
  myTeam = found;
  document.getElementById("captain-status").textContent = `Connecté : ${found.nom}`;
  document.getElementById("btn-captain-login").hidden = true;
  document.getElementById("captain-password").hidden = true;
  document.getElementById("btn-captain-logout").hidden = false;
  document.getElementById("tab-btn-mon-equipe").hidden = false;
  document.getElementById("my-terrain-pref").value = found.preferenceTerrain || "";
  // bascule sur le tournoi de l'équipe connectée si différent
  if (found.tournamentId !== currentTournamentId) selectTournament(found.tournamentId);
  else renderMyTeam();
});

document.getElementById("btn-captain-logout").addEventListener("click", () => {
  myTeam = null;
  document.getElementById("captain-status").textContent = "";
  document.getElementById("btn-captain-login").hidden = false;
  document.getElementById("captain-password").hidden = false;
  document.getElementById("btn-captain-logout").hidden = true;
  document.getElementById("tab-btn-mon-equipe").hidden = true;
});

function renderMyTeam() {
  if (!myTeam) return;
  const teamFraiche = teams.find((t) => t.id === myTeam.teamId);
  if (!teamFraiche) return;

  // prochains matchs
  const mesMatchs = matches.filter(
    (m) => m.equipeAId === myTeam.teamId || m.equipeBId === myTeam.teamId
  );
  document.getElementById("my-matches").innerHTML = mesMatchs
    .map((m) => {
      const adversaireId = m.equipeAId === myTeam.teamId ? m.equipeBId : m.equipeAId;
      return `<tr><td>${teamName(adversaireId)}</td><td>${m.date}</td><td>${m.heure}</td><td>${m.terrain}</td></tr>`;
    })
    .join("");

  // composition
  const membres = teamFraiche.membres || [];
  document.getElementById("members-table").innerHTML = membres
    .map(
      (m, i) => `<tr>
      <td>${m.nom}</td><td>${m.poste || "-"}</td><td>${m.numero || "-"}</td><td>${m.piedFort || "-"}</td>
      <td><button data-remove-member="${i}" class="danger">Retirer</button></td>
    </tr>`
    )
    .join("");

  document.querySelectorAll("[data-remove-member]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await removeTeamMember(myTeam.tournamentId, myTeam.teamId, Number(btn.dataset.removeMember));
    })
  );
}

document.getElementById("btn-add-member").addEventListener("click", async () => {
  if (!myTeam) return;
  const nom = document.getElementById("mb-nom").value.trim();
  if (!nom) return alert("Le nom du joueur est obligatoire.");
  await addTeamMember(myTeam.tournamentId, myTeam.teamId, {
    type: "libre",
    nom,
    poste: document.getElementById("mb-poste").value || null,
    numero: document.getElementById("mb-numero").value || null,
    piedFort: document.getElementById("mb-piedfort").value || null,
  });
  document.getElementById("mb-nom").value = "";
  document.getElementById("mb-poste").value = "";
  document.getElementById("mb-numero").value = "";
  document.getElementById("mb-piedfort").value = "";
});

document.getElementById("btn-save-pref").addEventListener("click", async () => {
  if (!myTeam) return;
  await updateTeam(myTeam.tournamentId, myTeam.teamId, {
    preferenceTerrain: document.getElementById("my-terrain-pref").value,
  });
  alert("Préférence enregistrée.");
});
