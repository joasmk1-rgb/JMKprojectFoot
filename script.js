import {
  watchTournaments, getTournament, watchEquipes, watchInscriptions, watchMatches,
  findEquipeByPassword, updateEquipe, addEquipeMember, removeEquipeMember,
  setEquipeAvailability, getPlayersByIds, getInscriptionsForEquipe,
  createPlayer, findPlayerByPassword, createEquipe, inscrireEquipe,
  demanderAdhesion, accepterAdhesion, refuserAdhesion, getEquipesForPlayer,
} from "./db.js";
import { computeStandings } from "./schedule.js";
import * as Grid from "./grid.js";

let currentTournamentId = null;
let currentTournament = null;
let equipesGlobal = []; // TOUTES les équipes du hub (globales)
let inscriptions = []; // inscriptions du tournoi actuellement affiché
let teams = []; // vue fusionnée équipe+inscription, pour CE tournoi (noms, groupe, standings)
let matches = [];
let myTeam = null; // équipe globale actuellement gérée — indépendante du tournoi affiché
let currentPlayer = null; // compte joueur connecté sur CETTE page (indépendant de myTeam)
let unsubInscriptions = null;
let unsubMatches = null;

// ---------- Équipes globales (une seule fois, indépendant du tournoi affiché) ----------
watchEquipes((list) => {
  equipesGlobal = list;
  recomputeTeams();
  if (myTeam) {
    // resynchronise la copie locale de myTeam avec la version fraîche
    const fraiche = equipesGlobal.find((e) => e.id === myTeam.id);
    if (fraiche) myTeam = fraiche;
    renderMyTeam();
  }
});

function recomputeTeams() {
  teams = inscriptions
    .map((insc) => {
      const equipe = equipesGlobal.find((e) => e.id === insc.id);
      if (!equipe) return null;
      return { ...equipe, id: insc.id, groupe: insc.groupe, statut: insc.statut, statutPaiement: insc.statutPaiement };
    })
    .filter(Boolean);
  renderStandings();
  renderPublicMatches();
}

// ---------- Liste des tournois (page d'accueil : on choisit lequel voir) ----------
// Le lien public d'un tournoi (partagé depuis l'admin) contient
// ?tournoi=ID dans l'URL — s'il est présent et valide, on l'ouvre
// directement au chargement plutôt que le premier de la liste.
let tournamentsList = [];
const idDepuisUrl = new URLSearchParams(location.search).get("tournoi");

watchTournaments((list) => {
  tournamentsList = list;
  renderListeTournois(list);
  const select = document.getElementById("select-tournament");
  select.innerHTML = list
    .map((t) => `<option value="${t.id}">${t.nom}${t.dateDebut ? ` — ${formaterDateFr(t.dateDebut)}` : ""}</option>`)
    .join("");
  if (!currentTournamentId && list.length) {
    const cible = idDepuisUrl && list.some((t) => t.id === idDepuisUrl) ? idDepuisUrl : list[0].id;
    selectTournament(cible);
  }
});

function formaterDateFr(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Cartes cliquables listant tous les tournois (nom, dates, statut) — la
// page d'accueil demandée par Joas plutôt qu'un simple menu déroulant.
function renderListeTournois(list) {
  const container = document.getElementById("liste-tournois");
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<p class="muted">Aucun tournoi pour l'instant.</p>`;
    return;
  }
  container.innerHTML = list
    .map((t) => {
      const dates = t.dateDebut
        ? `${formaterDateFr(t.dateDebut)}${t.dateFin && t.dateFin !== t.dateDebut ? ` → ${formaterDateFr(t.dateFin)}` : ""}`
        : "Date à confirmer";
      return `
    <button class="tournoi-carte ${t.id === currentTournamentId ? "tournoi-carte-active" : ""}" data-choisir-tournoi="${t.id}">
      <strong>${t.nom}</strong>
      <span class="muted">${dates} — ${t.statut}${t.inscriptionsOuvertes === false ? " · inscriptions fermées" : ""}</span>
    </button>`;
    })
    .join("");
  container.querySelectorAll("[data-choisir-tournoi]").forEach((btn) =>
    btn.addEventListener("click", () => selectTournament(btn.dataset.choisirTournoi))
  );
}

document.getElementById("select-tournament").addEventListener("change", (e) => {
  selectTournament(e.target.value);
});

function selectTournament(id) {
  currentTournamentId = id;
  document.getElementById("select-tournament").value = id;
  renderListeTournois(tournamentsList);

  // Rend le lien de cette page partageable pour CE tournoi précis, sans
  // recharger la page (le lien qu'on copie depuis la barre d'adresse marche
  // directement, et depuis l'admin aussi).
  const url = new URL(location.href);
  url.searchParams.set("tournoi", id);
  history.replaceState(null, "", url);

  getTournament(id).then((t) => {
    currentTournament = t;
    renderStandings();
    renderInscriptionPanel();
    if (myTeam) renderMyTeam();
  });

  if (unsubInscriptions) unsubInscriptions();
  unsubInscriptions = watchInscriptions(id, (list) => {
    inscriptions = list;
    recomputeTeams();
    renderInscriptionPanel();
  });

  if (unsubMatches) unsubMatches();
  unsubMatches = watchMatches(id, (list) => {
    matches = list;
    renderPublicMatches();
    renderStandings();
    if (myTeam) renderMyTeam();
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
  return teams.find((t) => t.id === id)?.nom || equipesGlobal.find((e) => e.id === id)?.nom || "?";
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

// Donne accès à la gestion d'une équipe (composition, dispo, inscriptions,
// demandes d'adhésion) — que ce soit via le mot de passe capitaine OU parce
// que le joueur connecté est un membre lié : les deux donnent EXACTEMENT
// les mêmes droits, seul le champ "contact capitaine" distingue qui appeler.
async function activerMyTeam(equipe) {
  myTeam = equipe;
  document.getElementById("captain-status").textContent = `Équipe gérée : ${equipe.nom}`;
  btnCaptainLogin.hidden = true;
  captainPasswordInput.hidden = true;
  document.getElementById("btn-captain-logout").hidden = false;
  document.getElementById("tab-btn-mon-equipe").hidden = false;
  document.getElementById("my-terrain-pref").value = equipe.preferenceTerrain || "";

  // Une équipe peut être inscrite à plusieurs tournois désormais — si elle
  // n'est pas inscrite au tournoi actuellement affiché mais l'est à un
  // autre, on bascule automatiquement sur celui-là.
  const mesInscriptions = await getInscriptionsForEquipe(equipe.id);
  const dejaSurBonTournoi = mesInscriptions.some((i) => i.tournamentId === currentTournamentId);
  if (!dejaSurBonTournoi && mesInscriptions.length) {
    selectTournament(mesInscriptions[0].tournamentId);
  } else {
    renderMyTeam();
  }
  renderInscriptionPanel();
}

async function tenterCaptainLogin() {
  if (captainLoginEnCours) return;
  captainLoginEnCours = true;
  btnCaptainLogin.disabled = true;
  btnCaptainLogin.textContent = "Connexion...";

  try {
    const password = captainPasswordInput.value;
    const found = await findEquipeByPassword(password);
    if (!found) {
      alert("Mot de passe non reconnu.");
      return;
    }
    await activerMyTeam(found);
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
  renderInscriptionPanel();
});

function renderMyTeam() {
  if (!myTeam) return;
  const teamFraiche = equipesGlobal.find((e) => e.id === myTeam.id);
  if (!teamFraiche) return;

  // dispos : on ne resynchronise pas pendant qu'on est en train de peindre
  // (sinon un aller-retour Firestore pile pendant un clique-glissé
  // interromprait le geste en cours).
  if (!isPainting) {
    dispoMarks = { ...(teamFraiche.dispos || {}) };
    renderDispoGrid();
  }

  // prochains matchs (dans le tournoi actuellement affiché)
  const mesMatchs = matches.filter(
    (m) => m.equipeAId === myTeam.id || m.equipeBId === myTeam.id
  );
  document.getElementById("my-matches").innerHTML = mesMatchs
    .map((m) => {
      const adversaireId = m.equipeAId === myTeam.id ? m.equipeBId : m.equipeAId;
      return `<tr><td>${teamName(adversaireId)}</td><td>${m.date}</td><td>${m.heure}</td><td>${m.terrain}</td></tr>`;
    })
    .join("");

  // composition (globale à l'équipe, indépendante du tournoi affiché)
  document.getElementById("mon-code-equipe").textContent = teamFraiche.codeEquipe || "-";
  const membres = teamFraiche.membres || [];
  document.getElementById("members-table").innerHTML = membres
    .map(
      (m, i) => `<tr>
      <td>${m.nom}</td><td>${m.poste || "-"}</td><td>${m.numero || "-"}</td><td>${m.piedFort || "-"}</td>
      <td><span class="badge ${m.type === "compte" ? "acte" : "propose"}">${m.type === "compte" ? "Compte" : "Libre"}</span></td>
      <td><button data-remove-member="${i}" class="danger">Retirer</button></td>
    </tr>`
    )
    .join("");

  document.querySelectorAll("[data-remove-member]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await removeEquipeMember(myTeam.id, Number(btn.dataset.removeMember));
    })
  );

  // Inscription de MON équipe au tournoi actuellement affiché, si ce n'est
  // pas déjà fait — pratique pour un membre qui gère déjà son équipe et
  // veut l'engager sur un nouveau tournoi sans repasser par un code.
  const inscritACe = teams.some((t) => t.id === myTeam.id);
  const inscrireBtn = document.getElementById("btn-inscrire-mon-equipe-ici");
  if (inscrireBtn) {
    inscrireBtn.hidden = inscritACe || !currentTournamentId;
  }

  // Demandes d'adhésion en attente — n'importe quel membre lié peut
  // accepter/refuser, pas seulement le contact capitaine.
  const demandesEl = document.getElementById("demandes-adhesion-list");
  if (demandesEl) {
    const demandes = teamFraiche.demandesAdhesion || [];
    demandesEl.innerHTML = demandes.length
      ? demandes
          .map(
            (d) => `
      <div class="creneau-row">
        <span>${d.nom}</span>
        <button data-accepter-demande="${d.joueurId}" class="secondaire">✅ Accepter</button>
        <button data-refuser-demande="${d.joueurId}" class="danger">❌ Refuser</button>
      </div>`
          )
          .join("")
      : `<p class="muted">Aucune demande d'adhésion en attente.</p>`;
    demandesEl.querySelectorAll("[data-accepter-demande]").forEach((btn) =>
      btn.addEventListener("click", () => accepterAdhesion(myTeam.id, btn.dataset.accepterDemande))
    );
    demandesEl.querySelectorAll("[data-refuser-demande]").forEach((btn) =>
      btn.addEventListener("click", () => refuserAdhesion(myTeam.id, btn.dataset.refuserDemande))
    );
  }

  renderCoequipiersDispoGrid(teamFraiche);
}

document.getElementById("btn-inscrire-mon-equipe-ici")?.addEventListener("click", async () => {
  if (!myTeam || !currentTournamentId) return;
  await inscrireEquipe(currentTournamentId, myTeam.id);
  alert("Équipe inscrite — en attente de validation par l'organisateur.");
});

// ===================== DISPO DES COÉQUIPIERS (comptes liés) =====================
const coequipiersDispoDates = Grid.buildDateList(new Date(), 21);
const coequipiersDispoTimes = Grid.buildTimeSlots();
let dernierMembresComptesKey = null; // évite de re-fetch les joueurs à chaque rendu si la liste n'a pas changé

let modeSondageEquipe = false;
let sondageEquipeSelection = new Set();

document.getElementById("btn-toggle-mode-sondage-equipe").addEventListener("click", (e) => {
  modeSondageEquipe = !modeSondageEquipe;
  e.target.classList.toggle("mode-active", modeSondageEquipe);
  e.target.textContent = modeSondageEquipe
    ? "🔶 Sélection en cours (clique sur les cases)"
    : "🔶 Sonder mes coéquipiers sur des créneaux";
});

document.getElementById("btn-sonder-equipe-appliquer").addEventListener("click", async () => {
  if (!myTeam) return;
  if (!sondageEquipeSelection.size) return alert("Sélectionne d'abord des créneaux (active le mode sélection).");
  const teamFraiche = equipesGlobal.find((e) => e.id === myTeam.id);
  const existants = new Set(teamFraiche?.sondagesJoueurs || []);
  sondageEquipeSelection.forEach((k) => existants.add(k));
  await updateEquipe(myTeam.id, { sondagesJoueurs: [...existants] });
  sondageEquipeSelection.clear();
  document.getElementById("sondage-equipe-selection-count").textContent = "";
  alert("Coéquipiers sondés — ces créneaux apparaîtront en orange sur leur grille perso jusqu'à leur réponse.");
});

document.getElementById("btn-sonder-equipe-vider").addEventListener("click", async () => {
  if (!myTeam) return;
  if (!confirm("Vider le sondage en cours pour cette équipe ?")) return;
  await updateEquipe(myTeam.id, { sondagesJoueurs: [] });
});

async function renderCoequipiersDispoGrid(team) {
  const container = document.getElementById("coequipiers-dispo-grid");
  if (!container) return;
  const membres = team?.membres || [];
  const idsComptes = membres.filter((m) => m.type === "compte" && m.joueurId).map((m) => m.joueurId);
  const key = idsComptes.slice().sort().join(",");
  const statusEl = document.getElementById("sondage-equipe-status");
  if (statusEl) {
    const nb = (team?.sondagesJoueurs || []).length;
    statusEl.textContent = nb
      ? `${nb} créneau(x) actuellement sondé(s) auprès des coéquipiers.`
      : "Aucun sondage en cours pour cette équipe.";
  }
  if (key === dernierMembresComptesKey && container.children.length) return; // déjà à jour
  dernierMembresComptesKey = key;

  container.innerHTML = "";
  container.style.gridTemplateColumns = Grid.gridTemplateColumns(coequipiersDispoDates.length);
  container.style.gridTemplateRows = Grid.gridTemplateRows(coequipiersDispoTimes.length);
  Grid.renderGridHeaders(container, coequipiersDispoDates);

  function wireSondageEquipeClick(cell, cellKey) {
    if (sondageEquipeSelection.has(cellKey)) cell.classList.add("sondage-selected");
    cell.addEventListener("click", () => {
      if (!modeSondageEquipe) return;
      if (sondageEquipeSelection.has(cellKey)) {
        sondageEquipeSelection.delete(cellKey);
        cell.classList.remove("sondage-selected");
      } else {
        sondageEquipeSelection.add(cellKey);
        cell.classList.add("sondage-selected");
      }
      document.getElementById("sondage-equipe-selection-count").textContent = sondageEquipeSelection.size
        ? `${sondageEquipeSelection.size} créneau(x) sélectionné(s)`
        : "";
    });
  }

  if (!idsComptes.length) {
    Grid.renderHourRows(container, coequipiersDispoDates, coequipiersDispoTimes, (cell, { dateISO, timeLabel }) => {
      wireSondageEquipeClick(cell, Grid.slotKey(dateISO, timeLabel));
    });
    return;
  }

  const joueurs = await getPlayersByIds(idsComptes);
  const total = joueurs.length || 1;
  Grid.renderHourRows(container, coequipiersDispoDates, coequipiersDispoTimes, (cell, { dateISO, timeLabel }) => {
    const cellKey = Grid.slotKey(dateISO, timeLabel);
    let dispo = 0;
    let pasDispo = 0;
    for (const j of joueurs) {
      const mark = (j.dispos || {})[cellKey];
      if (mark === "available") dispo++;
      if (mark === "unavailable") pasDispo++;
    }
    if (dispo > 0) {
      const intensite = Math.min(1, dispo / total);
      cell.style.background = `rgba(47, 184, 92, ${0.15 + intensite * 0.65})`;
    }
    if (pasDispo > 0) cell.style.boxShadow = "inset 0 -3px 0 var(--rouge)";
    if (dispo || pasDispo) cell.title = `${dispo} coéquipier(s) dispo, ${pasDispo} pas dispo`;
    wireSondageEquipeClick(cell, cellKey);
  });
}

document.getElementById("btn-add-member").addEventListener("click", async () => {
  if (!myTeam) return;
  const nom = document.getElementById("mb-nom").value.trim();
  if (!nom) return alert("Le nom du joueur est obligatoire.");
  await addEquipeMember(myTeam.id, {
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
  await updateEquipe(myTeam.id, {
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

  const sondagesTournoi = new Set(currentTournament?.sondages || []);

  Grid.renderGridHeaders(dispoGridEl, dispoDates);
  Grid.renderHourRows(dispoGridEl, dispoDates, dispoTimes, (cell, { dateISO, timeLabel }) => {
    const key = Grid.slotKey(dateISO, timeLabel);
    const mark = dispoMarks[key];
    if (mark === "available") cell.classList.add("mark-available");
    else if (mark === "unavailable") cell.classList.add("mark-unavailable");
    else if (sondagesTournoi.has(key)) cell.classList.add("mark-sondage");
    cell.dataset.key = key;
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      beginPaint(cell);
    });
    cell.addEventListener("mouseenter", () => {
      if (isPainting) applyPaint(cell);
    });
  });

  updateSondageBanner(sondagesTournoi);
}

function updateSondageBanner(sondagesTournoi) {
  const banner = document.getElementById("sondage-banner-equipe");
  const enAttente = [...sondagesTournoi].filter((k) => !dispoMarks[k]).length;
  if (enAttente > 0) {
    banner.hidden = false;
    banner.textContent = `🔶 ${enAttente} créneau(x) sondé(s) par l'organisateur, en attente de ta réponse (repère les cases orange dans la grille).`;
  } else {
    banner.hidden = true;
  }
}

function applyPaint(cell) {
  const key = cell.dataset.key;
  cell.classList.remove("mark-available", "mark-unavailable", "mark-sondage");
  if (paintAction === "clear") {
    delete dispoMarks[key];
    if ((currentTournament?.sondages || []).includes(key)) cell.classList.add("mark-sondage");
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
    await setEquipeAvailability(myTeam.id, dispoMarks);
    statusEl.textContent = "Enregistré ✓";
    statusEl.className = "saved";
    updateSondageBanner(new Set(currentTournament?.sondages || []));
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

  const seulementVide = document.getElementById("mr-seulement-vide").checked;
  const cibles = [];
  dispoDates.forEach((date) => {
    const dateISO = Grid.toISODate(date);
    if (dateDebut && dateISO < dateDebut) return;
    if (dateFin && dateISO > dateFin) return;
    if (!joursSelectionnes.has(date.getDay())) return;
    dispoTimes.forEach((timeLabel) => {
      if (heureDebut && timeLabel < heureDebut) return;
      if (heureFin && timeLabel >= heureFin) return;
      const key = Grid.slotKey(dateISO, timeLabel);
      if (seulementVide && dispoMarks[key]) return;
      cibles.push(key);
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

// ===================== INSCRIPTION PUBLIQUE À UN TOURNOI =====================
// Page d'entrée pour quelqu'un qui arrive via le lien partagé d'un tournoi :
// se connecter/créer un compte joueur, puis soit créer son équipe et
// l'inscrire, soit inscrire une équipe existante, soit demander à
// rejoindre une équipe déjà inscrite à CE tournoi (demande qu'un membre
// déjà lié devra accepter — pas d'ajout instantané, contrairement au code
// d'invitation classique qui reste disponible côté page joueur).

const btnInscJLogin = document.getElementById("insc-j-btn-login");
const btnInscJSignup = document.getElementById("insc-j-btn-signup");

btnInscJLogin?.addEventListener("click", async () => {
  const errorEl = document.getElementById("insc-j-error");
  errorEl.textContent = "";
  const password = document.getElementById("insc-j-password").value;
  if (!password) return;
  btnInscJLogin.disabled = true;
  try {
    const found = await findPlayerByPassword(password);
    if (!found) {
      errorEl.textContent = "Mot de passe non reconnu.";
      return;
    }
    await connecterJoueurInscription(found);
  } catch (e) {
    errorEl.textContent = "Erreur de connexion — réessaie.";
    console.error(e);
  } finally {
    btnInscJLogin.disabled = false;
  }
});

btnInscJSignup?.addEventListener("click", async () => {
  const errorEl = document.getElementById("insc-j-error");
  errorEl.textContent = "";
  const nom = document.getElementById("insc-j-signup-nom").value.trim();
  const password = document.getElementById("insc-j-signup-password").value;
  if (!nom || !password) {
    errorEl.textContent = "Nom et mot de passe obligatoires.";
    return;
  }
  btnInscJSignup.disabled = true;
  try {
    const existant = await findPlayerByPassword(password);
    if (existant) {
      errorEl.textContent = "Ce mot de passe est déjà pris, choisis-en un autre.";
      return;
    }
    const id = await createPlayer(nom, password);
    await connecterJoueurInscription({ id, nom, dispos: {} });
  } catch (e) {
    errorEl.textContent = "Erreur lors de la création du compte — réessaie.";
    console.error(e);
  } finally {
    btnInscJSignup.disabled = false;
  }
});

async function connecterJoueurInscription(joueur) {
  currentPlayer = joueur;
  document.getElementById("insc-connexion-joueur").hidden = true;
  document.getElementById("insc-connecte").hidden = false;
  document.getElementById("insc-j-nom-affiche").textContent = joueur.nom;
  await renderMesEquipesInscription();
  renderInscriptionPanel();
}

document.getElementById("insc-j-btn-logout")?.addEventListener("click", () => {
  currentPlayer = null;
  document.getElementById("insc-connexion-joueur").hidden = false;
  document.getElementById("insc-connecte").hidden = true;
  renderInscriptionPanel();
});

// Équipes déjà gérées par ce joueur (compte lié) — bouton "Gérer" direct,
// sans redemander le mot de passe capitaine.
async function renderMesEquipesInscription() {
  const container = document.getElementById("insc-mes-equipes");
  if (!container || !currentPlayer) return;
  const mesEquipes = await getEquipesForPlayer(currentPlayer.id);
  if (!mesEquipes.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML =
    `<p class="champ-label">Tes équipes</p>` +
    mesEquipes
      .map(
        (e) =>
          `<div class="creneau-row"><span>${e.nom}</span><button data-gerer-equipe="${e.id}" class="secondaire">Gérer cette équipe</button></div>`
      )
      .join("");
  container.querySelectorAll("[data-gerer-equipe]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const equipe = mesEquipes.find((e) => e.id === btn.dataset.gererEquipe);
      if (equipe) activerMyTeam(equipe);
    })
  );
}

// Créer une nouvelle équipe (le joueur connecté devient le premier membre
// lié, avec les mêmes droits que n'importe quel autre membre) puis
// l'inscrire directement à ce tournoi.
document.getElementById("insc-btn-creer-equipe")?.addEventListener("click", async () => {
  if (!currentPlayer || !currentTournamentId) return;
  const nom = document.getElementById("insc-nouvelle-eq-nom").value.trim();
  if (!nom) return alert("Le nom de l'équipe est obligatoire.");
  const password =
    document.getElementById("insc-nouvelle-eq-password").value.trim() || Math.random().toString(36).slice(2, 10);
  const contact = document.getElementById("insc-nouvelle-eq-contact").value.trim();
  const btn = document.getElementById("insc-btn-creer-equipe");
  btn.disabled = true;
  try {
    const id = await createEquipe({
      nom,
      capitainePassword: password,
      capitaineNom: currentPlayer.nom,
      capitaineContact: contact || null,
      membres: [{ type: "compte", joueurId: currentPlayer.id, nom: currentPlayer.nom }],
    });
    await inscrireEquipe(currentTournamentId, id);
    document.getElementById("insc-result").innerHTML =
      `Équipe "${nom}" créée et inscrite — en attente de validation par l'organisateur. ` +
      `Mot de passe équipe (à conserver, utile pour te reconnecter si besoin) : <strong>${password}</strong>`;
    document.getElementById("insc-nouvelle-eq-nom").value = "";
    document.getElementById("insc-nouvelle-eq-password").value = "";
    document.getElementById("insc-nouvelle-eq-contact").value = "";
    await renderMesEquipesInscription();
  } catch (e) {
    console.error(e);
    alert("Erreur lors de la création : " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
});

// Inscrire une équipe existante (dont on connaît le mot de passe) à ce
// tournoi — rattache aussi le joueur connecté comme membre lié s'il ne
// l'était pas déjà, pour qu'il puisse la gérer directement la prochaine fois.
document.getElementById("insc-btn-connecter-equipe")?.addEventListener("click", async () => {
  if (!currentPlayer || !currentTournamentId) return;
  const password = document.getElementById("insc-eq-password").value;
  if (!password) return;
  const btn = document.getElementById("insc-btn-connecter-equipe");
  btn.disabled = true;
  try {
    const equipe = await findEquipeByPassword(password);
    if (!equipe) {
      document.getElementById("insc-result").textContent = "Mot de passe équipe non reconnu.";
      return;
    }
    const dejaMembre = (equipe.membres || []).some((m) => m.type === "compte" && m.joueurId === currentPlayer.id);
    if (!dejaMembre) {
      await addEquipeMember(equipe.id, { type: "compte", joueurId: currentPlayer.id, nom: currentPlayer.nom });
    }
    await inscrireEquipe(currentTournamentId, equipe.id);
    document.getElementById("insc-result").textContent = `Équipe "${equipe.nom}" inscrite — en attente de validation par l'organisateur.`;
    document.getElementById("insc-eq-password").value = "";
    await renderMesEquipesInscription();
  } catch (e) {
    console.error(e);
    alert("Erreur : " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
});

// Demander à rejoindre une équipe déjà inscrite à ce tournoi — la demande
// attend qu'un membre déjà lié de cette équipe l'accepte (voir "Mon équipe"
// → "Demandes d'adhésion en attente").
document.getElementById("insc-liste-equipes-rejoindre")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-demander-adhesion]");
  if (!btn || !currentPlayer) return;
  btn.disabled = true;
  btn.textContent = "Demande envoyée...";
  try {
    await demanderAdhesion(btn.dataset.demanderAdhesion, { joueurId: currentPlayer.id, nom: currentPlayer.nom });
  } catch (e2) {
    console.error(e2);
    btn.disabled = false;
    btn.textContent = "Demander à rejoindre";
  }
});

function renderInscriptionPanel() {
  const ouvertEl = document.getElementById("insc-statut-fermees");
  if (ouvertEl) {
    ouvertEl.hidden = !(currentTournament && currentTournament.inscriptionsOuvertes === false);
  }

  const listeEl = document.getElementById("insc-liste-equipes-rejoindre");
  if (listeEl) {
    listeEl.innerHTML = teams.length
      ? teams
          .map(
            (t) => `
      <div class="creneau-row">
        <span>${t.nom} <span class="muted">(${t.statut})</span></span>
        <button data-demander-adhesion="${t.id}" class="secondaire">Demander à rejoindre</button>
      </div>`
          )
          .join("")
      : `<p class="muted">Aucune équipe encore inscrite à ce tournoi pour l'instant — sois le premier !</p>`;
  }
}
