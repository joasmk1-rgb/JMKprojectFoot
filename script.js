import {
  watchTournaments, getTournament, watchTeams, watchMatches,
  findTeamByPassword, updateTeam, addTeamMember, removeTeamMember,
  setTeamAvailability,
} from "./db.js";
import { computeStandings } from "./schedule.js";
import * as Grid from "./grid.js";

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
const btnCaptainLogin = document.getElementById("btn-captain-login");
const captainPasswordInput = document.getElementById("captain-password");
let captainLoginEnCours = false;

async function tenterCaptainLogin() {
  if (captainLoginEnCours) return;
  captainLoginEnCours = true;
  btnCaptainLogin.disabled = true;
  btnCaptainLogin.textContent = "Connexion...";

  try {
    const password = captainPasswordInput.value;
    const found = await findTeamByPassword(password);
    if (!found) {
      alert("Mot de passe non reconnu.");
      return;
    }
    myTeam = found;
    document.getElementById("captain-status").textContent = `Connecté : ${found.nom}`;
    btnCaptainLogin.hidden = true;
    captainPasswordInput.hidden = true;
    document.getElementById("btn-captain-logout").hidden = false;
    document.getElementById("tab-btn-mon-equipe").hidden = false;
    document.getElementById("my-terrain-pref").value = found.preferenceTerrain || "";
    // bascule sur le tournoi de l'équipe connectée si différent
    if (found.tournamentId !== currentTournamentId) selectTournament(found.tournamentId);
    else renderMyTeam();
  } finally {
    captainLoginEnCours = false;
    btnCaptainLogin.disabled = false;
    btnCaptainLogin.textContent = "Se connecter";
  }
}

btnCaptainLogin.addEventListener("click", tenterCaptainLogin);
captainPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tenterCaptainLogin();
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

  // dispos : on ne resynchronise pas pendant qu'on est en train de peindre
  // (sinon un aller-retour Firestore pile pendant un clique-glissé
  // interromprait le geste en cours).
  if (!isPainting) {
    dispoMarks = { ...(teamFraiche.dispos || {}) };
    renderDispoGrid();
  }

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

// ===================== DISPONIBILITÉS D'ÉQUIPE (grille dispo/pas dispo) =====================
// Mécanisme repris d'agenda-conseil : clic ou clique-glissé pour peindre les
// créneaux, sauvegarde une fois le geste terminé (pas à chaque case), et un
// panneau de "marquage rapide" pour cocher tout un ensemble de créneaux
// d'un coup plutôt que case par case.

let dispoMode = "available"; // mode du clic simple sur la grille
let dispoMarks = {}; // copie locale, "date|heure" -> "available" | "unavailable"
let isPainting = false;
let paintAction = null; // "set" | "clear"

const dispoGridEl = document.getElementById("dispo-grid");
const dispoDates = Grid.buildDateList(new Date(), 21); // aligné sur DISPO_CONFIG.rangeDays côté config.js
const dispoTimes = Grid.buildTimeSlots();

function setDispoMode(mode) {
  dispoMode = mode;
  document.getElementById("mode-available").classList.toggle("mode-active", mode === "available");
  document.getElementById("mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
}
document.getElementById("mode-available").addEventListener("click", () => setDispoMode("available"));
document.getElementById("mode-unavailable").addEventListener("click", () => setDispoMode("unavailable"));

function renderDispoGrid() {
  dispoGridEl.innerHTML = "";
  dispoGridEl.style.gridTemplateColumns = Grid.gridTemplateColumns(dispoDates.length);
  dispoGridEl.style.gridTemplateRows = Grid.gridTemplateRows(dispoTimes.length);

  Grid.renderGridHeaders(dispoGridEl, dispoDates);
  Grid.renderHourRows(dispoGridEl, dispoDates, dispoTimes, (cell, { dateISO, timeLabel }) => {
    const key = Grid.slotKey(dateISO, timeLabel);
    const mark = dispoMarks[key];
    if (mark === "available") cell.classList.add("mark-available");
    if (mark === "unavailable") cell.classList.add("mark-unavailable");
    cell.dataset.key = key;
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      beginPaint(cell);
    });
    cell.addEventListener("mouseenter", () => {
      if (isPainting) applyPaint(cell);
    });
  });
}

function applyPaint(cell) {
  const key = cell.dataset.key;
  cell.classList.remove("mark-available", "mark-unavailable");
  if (paintAction === "clear") {
    delete dispoMarks[key];
  } else {
    dispoMarks[key] = dispoMode;
    cell.classList.add(dispoMode === "available" ? "mark-available" : "mark-unavailable");
  }
}

function beginPaint(cell) {
  const key = cell.dataset.key;
  paintAction = dispoMarks[key] === dispoMode ? "clear" : "set";
  isPainting = true;
  applyPaint(cell);
}

function stopPainting() {
  if (isPainting) {
    isPainting = false;
    persistDispoMarks();
  }
}
document.addEventListener("mouseup", stopPainting);

async function persistDispoMarks() {
  if (!myTeam) return;
  const statusEl = document.getElementById("dispo-save-status");
  statusEl.textContent = "Enregistrement...";
  statusEl.className = "saving";
  try {
    await setTeamAvailability(myTeam.tournamentId, myTeam.teamId, dispoMarks);
    statusEl.textContent = "Enregistré ✓";
    statusEl.className = "saved";
  } catch (e) {
    statusEl.textContent = "Erreur d'enregistrement";
    console.error(e);
  }
}

// ---- Marquage rapide (panneau) ----
document.getElementById("btn-toggle-marquage-rapide").addEventListener("click", () => {
  document.getElementById("marquage-rapide-panel").hidden = !document.getElementById("marquage-rapide-panel").hidden;
});

const BULK_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lundi -> dimanche
const mrJoursContainer = document.getElementById("mr-jours");
BULK_DAY_ORDER.forEach((dow) => {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "mr-jour-checkbox";
  input.value = String(dow);
  input.checked = true;
  input.disabled = true; // désactivées tant que "Tous les jours" est coché
  label.appendChild(input);
  label.appendChild(document.createTextNode(" " + Grid.WEEKDAYS_FULL[dow].slice(0, 3)));
  mrJoursContainer.appendChild(label);
});

document.getElementById("mr-tous-jours").addEventListener("change", (e) => {
  const checked = e.target.checked;
  mrJoursContainer.querySelectorAll(".mr-jour-checkbox").forEach((cb) => {
    cb.disabled = checked;
    cb.checked = checked;
  });
});

let mrMode = "available";
function setMrMode(mode) {
  mrMode = mode;
  document.getElementById("mr-mode-available").classList.toggle("mode-active", mode === "available");
  document.getElementById("mr-mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
  document.getElementById("mr-mode-clear").classList.toggle("mode-active", mode === "clear");
}
document.getElementById("mr-mode-available").addEventListener("click", () => setMrMode("available"));
document.getElementById("mr-mode-unavailable").addEventListener("click", () => setMrMode("unavailable"));
document.getElementById("mr-mode-clear").addEventListener("click", () => setMrMode("clear"));

document.getElementById("btn-mr-appliquer").addEventListener("click", async () => {
  if (!myTeam) return;
  const tousJours = document.getElementById("mr-tous-jours").checked;
  const joursSelectionnes = new Set(
    [...mrJoursContainer.querySelectorAll(".mr-jour-checkbox")]
      .filter((cb) => tousJours || cb.checked)
      .map((cb) => Number(cb.value))
  );
  const heureDebut = document.getElementById("mr-heure-debut").value || null;
  const heureFin = document.getElementById("mr-heure-fin").value || null;
  const dateDebut = document.getElementById("mr-date-debut").value || null;
  const dateFin = document.getElementById("mr-date-fin").value || null;

  const cibles = [];
  dispoDates.forEach((date) => {
    const dateISO = Grid.toISODate(date);
    if (dateDebut && dateISO < dateDebut) return;
    if (dateFin && dateISO > dateFin) return;
    if (!joursSelectionnes.has(date.getDay())) return;
    dispoTimes.forEach((timeLabel) => {
      if (heureDebut && timeLabel < heureDebut) return;
      if (heureFin && timeLabel >= heureFin) return;
      cibles.push(Grid.slotKey(dateISO, timeLabel));
    });
  });

  if (!cibles.length) {
    document.getElementById("mr-result").textContent = "Aucun créneau ne correspond à ces critères.";
    return;
  }

  const nouvelleValeur = mrMode === "clear" ? null : mrMode;
  cibles.forEach((key) => {
    if (nouvelleValeur) dispoMarks[key] = nouvelleValeur;
    else delete dispoMarks[key];
  });

  renderDispoGrid();
  document.getElementById("mr-result").textContent = `${cibles.length} créneau(x) mis à jour.`;
  await persistDispoMarks();
});
