import {
  createPlayer, findPlayerByPassword, setPlayerAvailability,
  findTeamByCode, addTeamMember, getTeamsForPlayer,
} from "./db.js";
import * as Grid from "./grid.js";

// ===================== COMPTE JOUEUR (fondation du hub) =====================
// Contrairement aux équipes/tournois, un joueur existe indépendamment :
// il se crée un compte une seule fois et pourra plus tard l'utiliser pour
// rejoindre plusieurs équipes/tournois/championnats.

let currentPlayer = null; // { id, nom, dispos, ... } une fois connecté

const loginCard = document.getElementById("joueur-login-card");
const appEl = document.getElementById("joueur-app");

// ---------- Connexion ----------
const btnLogin = document.getElementById("j-btn-login");
const loginPasswordInput = document.getElementById("j-login-password");
let loginEnCours = false;

async function tenterLogin() {
  if (loginEnCours) return;
  loginEnCours = true;
  const errorEl = document.getElementById("j-login-error");
  errorEl.textContent = "";
  btnLogin.disabled = true;
  btnLogin.textContent = "Connexion...";
  try {
    const found = await findPlayerByPassword(loginPasswordInput.value);
    if (!found) {
      errorEl.textContent = "Mot de passe non reconnu.";
      return;
    }
    entrerDansApp(found);
  } catch (e) {
    errorEl.textContent = "Erreur de connexion — réessaie dans un instant.";
    console.error(e);
  } finally {
    loginEnCours = false;
    btnLogin.disabled = false;
    btnLogin.textContent = "Se connecter";
  }
}
btnLogin.addEventListener("click", tenterLogin);
loginPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tenterLogin();
});

// ---------- Création de compte ----------
const btnSignup = document.getElementById("j-btn-signup");
let signupEnCours = false;

btnSignup.addEventListener("click", async () => {
  if (signupEnCours) return;
  signupEnCours = true;
  const errorEl = document.getElementById("j-signup-error");
  errorEl.textContent = "";
  btnSignup.disabled = true;
  btnSignup.textContent = "Création...";
  try {
    const nom = document.getElementById("j-signup-nom").value.trim();
    const password = document.getElementById("j-signup-password").value;
    if (!nom || !password) {
      errorEl.textContent = "Nom et mot de passe obligatoires.";
      return;
    }
    const existant = await findPlayerByPassword(password);
    if (existant) {
      errorEl.textContent = "Ce mot de passe est déjà pris, choisis-en un autre.";
      return;
    }
    const id = await createPlayer(nom, password);
    entrerDansApp({ id, nom, dispos: {} });
  } catch (e) {
    errorEl.textContent = "Erreur lors de la création du compte — réessaie dans un instant.";
    console.error(e);
  } finally {
    signupEnCours = false;
    btnSignup.disabled = false;
    btnSignup.textContent = "Créer mon compte";
  }
});

function entrerDansApp(player) {
  currentPlayer = player;
  loginCard.hidden = true;
  appEl.hidden = false;
  document.getElementById("j-nom-affiche").textContent = player.nom;
  document.getElementById("joueur-status").textContent = `Connecté : ${player.nom}`;
  dispoMarks = { ...(player.dispos || {}) };
  renderDispoGrid();
  renderMesEquipes();
}

// ===================== ÉQUIPES DU JOUEUR =====================
let pendingSondageKeys = new Set();

async function renderMesEquipes() {
  if (!currentPlayer) return;
  const container = document.getElementById("j-mes-equipes");
  const equipes = await getTeamsForPlayer(currentPlayer.id);

  pendingSondageKeys = new Set();
  equipes.forEach((e) => (e.sondagesJoueurs || []).forEach((k) => pendingSondageKeys.add(k)));
  renderDispoGrid();
  updateSondageBanner();

  if (!equipes.length) {
    container.innerHTML = `<p class="muted">Tu ne fais partie d'aucune équipe pour l'instant.</p>`;
    return;
  }
  container.innerHTML = equipes
    .map((e) => `<p><strong>${e.nom}</strong> <span class="muted">— tournoi : ${e.tournamentNom}</span></p>`)
    .join("");
}

function updateSondageBanner() {
  const banner = document.getElementById("j-sondage-banner");
  const enAttente = [...pendingSondageKeys].filter((k) => !dispoMarks[k]).length;
  if (enAttente > 0) {
    banner.hidden = false;
    banner.textContent = `🔶 ${enAttente} créneau(x) sondé(s) par un coéquipier ou un organisateur, en attente de ta réponse (cases orange dans la grille).`;
  } else {
    banner.hidden = true;
  }
}

document.getElementById("j-btn-rejoindre").addEventListener("click", async () => {
  if (!currentPlayer) return;
  const resultEl = document.getElementById("j-rejoindre-result");
  const code = document.getElementById("j-code-equipe").value.trim().toUpperCase();
  if (!code) return;
  resultEl.textContent = "Recherche de l'équipe...";
  try {
    const equipe = await findTeamByCode(code);
    if (!equipe) {
      resultEl.textContent = "Aucune équipe ne correspond à ce code.";
      return;
    }
    const dejaMembre = (equipe.membres || []).some((m) => m.type === "compte" && m.joueurId === currentPlayer.id);
    if (dejaMembre) {
      resultEl.textContent = `Tu fais déjà partie de l'équipe "${equipe.nom}".`;
      return;
    }
    await addTeamMember(equipe.tournamentId, equipe.teamId, {
      type: "compte",
      joueurId: currentPlayer.id,
      nom: currentPlayer.nom,
    });
    resultEl.textContent = `Tu as rejoint l'équipe "${equipe.nom}" !`;
    document.getElementById("j-code-equipe").value = "";
    renderMesEquipes();
  } catch (e) {
    resultEl.textContent = "Erreur — réessaie dans un instant.";
    console.error(e);
  }
});

document.getElementById("j-btn-logout").addEventListener("click", () => {
  currentPlayer = null;
  loginCard.hidden = false;
  appEl.hidden = true;
  document.getElementById("joueur-status").textContent = "";
  loginPasswordInput.value = "";
});

// ===================== DISPONIBILITÉS PERSONNELLES =====================
// Même mécanisme que pour les équipes (grid.js) : clic/glissé pour peindre,
// sauvegarde une fois le geste terminé, + marquage rapide.

let dispoMode = "available";
let dispoMarks = {};
let isPainting = false;
let paintAction = null;

const dispoGridEl = document.getElementById("j-dispo-grid");
const dispoDates = Grid.buildDateList(new Date(), 21);
const dispoTimes = Grid.buildTimeSlots();

function setDispoMode(mode) {
  dispoMode = mode;
  document.getElementById("j-mode-available").classList.toggle("mode-active", mode === "available");
  document.getElementById("j-mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
}
document.getElementById("j-mode-available").addEventListener("click", () => setDispoMode("available"));
document.getElementById("j-mode-unavailable").addEventListener("click", () => setDispoMode("unavailable"));

function renderDispoGrid() {
  dispoGridEl.innerHTML = "";
  dispoGridEl.style.gridTemplateColumns = Grid.gridTemplateColumns(dispoDates.length);
  dispoGridEl.style.gridTemplateRows = Grid.gridTemplateRows(dispoTimes.length);
  Grid.renderGridHeaders(dispoGridEl, dispoDates);
  Grid.renderHourRows(dispoGridEl, dispoDates, dispoTimes, (cell, { dateISO, timeLabel }) => {
    const key = Grid.slotKey(dateISO, timeLabel);
    const mark = dispoMarks[key];
    if (mark === "available") cell.classList.add("mark-available");
    else if (mark === "unavailable") cell.classList.add("mark-unavailable");
    else if (pendingSondageKeys.has(key)) cell.classList.add("mark-sondage");
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
  cell.classList.remove("mark-available", "mark-unavailable", "mark-sondage");
  if (paintAction === "clear") {
    delete dispoMarks[key];
    if (pendingSondageKeys.has(key)) cell.classList.add("mark-sondage");
  } else {
    dispoMarks[key] = dispoMode;
    cell.classList.add(dispoMode === "available" ? "mark-available" : "mark-unavailable");
  }
}

function beginPaint(cell) {
  if (!currentPlayer) return;
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
  if (!currentPlayer) return;
  const statusEl = document.getElementById("j-dispo-save-status");
  statusEl.textContent = "Enregistrement...";
  statusEl.className = "saving";
  try {
    await setPlayerAvailability(currentPlayer.id, dispoMarks);
    statusEl.textContent = "Enregistré ✓";
    statusEl.className = "saved";
    updateSondageBanner();
  } catch (e) {
    statusEl.textContent = "Erreur d'enregistrement";
    console.error(e);
  }
}

// ---- Marquage rapide ----
document.getElementById("j-btn-toggle-marquage-rapide").addEventListener("click", () => {
  const panel = document.getElementById("j-marquage-rapide-panel");
  panel.hidden = !panel.hidden;
});

const BULK_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lundi -> dimanche
const mrJoursContainer = document.getElementById("j-mr-jours");
BULK_DAY_ORDER.forEach((dow) => {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "j-mr-jour-checkbox";
  input.value = String(dow);
  input.checked = true;
  input.disabled = true;
  label.appendChild(input);
  label.appendChild(document.createTextNode(" " + Grid.WEEKDAYS_FULL[dow].slice(0, 3)));
  mrJoursContainer.appendChild(label);
});

document.getElementById("j-mr-tous-jours").addEventListener("change", (e) => {
  const checked = e.target.checked;
  mrJoursContainer.querySelectorAll(".j-mr-jour-checkbox").forEach((cb) => {
    cb.disabled = checked;
    cb.checked = checked;
  });
});

let mrMode = "available";
function setMrMode(mode) {
  mrMode = mode;
  document.getElementById("j-mr-mode-available").classList.toggle("mode-active", mode === "available");
  document.getElementById("j-mr-mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
  document.getElementById("j-mr-mode-clear").classList.toggle("mode-active", mode === "clear");
}
document.getElementById("j-mr-mode-available").addEventListener("click", () => setMrMode("available"));
document.getElementById("j-mr-mode-unavailable").addEventListener("click", () => setMrMode("unavailable"));
document.getElementById("j-mr-mode-clear").addEventListener("click", () => setMrMode("clear"));

document.getElementById("j-btn-mr-appliquer").addEventListener("click", async () => {
  if (!currentPlayer) return;
  const tousJours = document.getElementById("j-mr-tous-jours").checked;
  const joursSelectionnes = new Set(
    [...mrJoursContainer.querySelectorAll(".j-mr-jour-checkbox")]
      .filter((cb) => tousJours || cb.checked)
      .map((cb) => Number(cb.value))
  );
  const heureDebut = document.getElementById("j-mr-heure-debut").value || null;
  const heureFin = document.getElementById("j-mr-heure-fin").value || null;
  const dateDebut = document.getElementById("j-mr-date-debut").value || null;
  const dateFin = document.getElementById("j-mr-date-fin").value || null;

  const seulementVide = document.getElementById("j-mr-seulement-vide").checked;
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
    document.getElementById("j-mr-result").textContent = "Aucun créneau ne correspond à ces critères.";
    return;
  }

  const nouvelleValeur = mrMode === "clear" ? null : mrMode;
  cibles.forEach((key) => {
    if (nouvelleValeur) dispoMarks[key] = nouvelleValeur;
    else delete dispoMarks[key];
  });

  renderDispoGrid();
  document.getElementById("j-mr-result").textContent = `${cibles.length} créneau(x) mis à jour.`;
  await persistDispoMarks();
});
