import {
  createPlayer, findPlayerByPassword, setPlayerAvailability, updatePlayer,
  findEquipeByCode, addEquipeMember, getEquipesForPlayer, getInscriptionsForEquipe,
  getMatchsArbitrablesDisponibles, getMesMatchsArbitre, updateMatch, setMatchResult,
  getTournament, getEquipe, trouverParticipationsLibres, lierMembreLibre, getMatches,
} from "./db.js";
import { stadeAtteintEquipe } from "./schedule.js";
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
  renderArbitreStatut();
  renderHistoriqueProposes();
}

// ===================== ÉQUIPES DU JOUEUR =====================
let pendingSondageKeys = new Set();

async function renderMesEquipes() {
  if (!currentPlayer) return;
  const container = document.getElementById("j-mes-equipes");
  const equipes = await getEquipesForPlayer(currentPlayer.id);

  pendingSondageKeys = new Set();
  equipes.forEach((e) => (e.sondagesJoueurs || []).forEach((k) => pendingSondageKeys.add(k)));
  renderDispoGrid();
  updateSondageBanner();

  if (!equipes.length) {
    container.innerHTML = `<p class="muted">Tu ne fais partie d'aucune équipe pour l'instant.</p>`;
    return;
  }

  // Une équipe est désormais globale (pas liée à un seul tournoi) — on
  // affiche ses inscriptions actuelles (à quel(s) tournoi(s) elle participe)
  // ainsi qu'un mini palmarès (stade atteint à chaque tournoi joué).
  const parEquipe = await Promise.all(
    equipes.map(async (e) => ({ equipe: e, inscriptions: await getInscriptionsForEquipe(e.id) }))
  );
  const blocs = await Promise.all(
    parEquipe.map(async ({ equipe, inscriptions }) => {
      if (!inscriptions.length) {
        return `<p><strong>${equipe.nom}</strong> <span class="muted">— aucun tournoi pour l'instant</span></p>`;
      }
      const lignesPalmares = await Promise.all(
        inscriptions.map(async (insc) => {
          const matchsDuTournoi = await getMatches(insc.tournamentId);
          const { label } = stadeAtteintEquipe(equipe.id, matchsDuTournoi);
          return `${insc.tournamentNom} (${label})`;
        })
      );
      return `<p><strong>${equipe.nom}</strong> <span class="muted">— ${lignesPalmares.join(", ")}</span></p>`;
    })
  );
  container.innerHTML = blocs.join("");
}

// ===================== HISTORIQUE : lier son compte à ses anciennes =====================
// participations (membres "libres" enregistrés sous le même nom, issus
// typiquement d'un import CSV d'un ancien tournoi, jamais liés à un compte).
let participationsProposees = [];

async function renderHistoriqueProposes() {
  if (!currentPlayer) return;
  const card = document.getElementById("j-historique-card");
  const found = await trouverParticipationsLibres(currentPlayer.nom);
  // Ne propose que ce qui n'est pas déjà lié à CE compte (au cas où on
  // rappelle cette fonction après un lien déjà fait) — trouverParticipationsLibres
  // ne renvoie de toute façon que des membres encore "libre".
  participationsProposees = found;
  if (!found.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  document.getElementById("j-historique-liste").innerHTML = found
    .map(
      (p, i) => `<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <input type="checkbox" class="j-historique-check" value="${i}" style="width:auto;" checked /> ${p.equipeNom}${
        p.tournamentNom ? ` — ${p.tournamentNom}` : ""
      } <span class="muted">(enregistré comme "${p.nomMembre}")</span>
    </label>`
    )
    .join("");
}

document.getElementById("j-btn-lier-historique").addEventListener("click", async () => {
  if (!currentPlayer) return;
  const resultEl = document.getElementById("j-historique-result");
  const indices = [...document.querySelectorAll(".j-historique-check:checked")].map((cb) => Number(cb.value));
  if (!indices.length) {
    resultEl.textContent = "Aucune participation cochée.";
    return;
  }
  resultEl.textContent = "Liaison en cours...";
  for (const i of indices) {
    const p = participationsProposees[i];
    await lierMembreLibre(p.tournamentId, p.equipeId, p.index, currentPlayer);
  }
  resultEl.textContent = `${indices.length} participation(s) liée(s) à ton compte ✓`;
  renderMesEquipes();
  renderHistoriqueProposes();
});

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
    const equipe = await findEquipeByCode(code);
    if (!equipe) {
      resultEl.textContent = "Aucune équipe ne correspond à ce code.";
      return;
    }
    const dejaMembre = (equipe.membres || []).some((m) => m.type === "compte" && m.joueurId === currentPlayer.id);
    if (dejaMembre) {
      resultEl.textContent = `Tu fais déjà partie de l'équipe "${equipe.nom}".`;
      return;
    }
    await addEquipeMember(equipe.id, {
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

// ===================== ARBITRAGE =====================
// Extension du compte joueur, pas un compte à part : le joueur se déclare
// dispo pour arbitrer, l'admin valide, puis il voit les matchs planifiés
// sans arbitre (tous tournois confondus) et peut s'y assigner ; une fois
// assigné, il passe en "mode match" pour encoder score et cartons pendant
// le match — les mêmes champs qu'utilise l'admin (setMatchResult).
const tournoiNomCache = new Map();
const equipeNomCache = new Map();

async function nomTournoi(id) {
  if (!tournoiNomCache.has(id)) tournoiNomCache.set(id, (await getTournament(id))?.nom || "(tournoi supprimé)");
  return tournoiNomCache.get(id);
}
async function nomEquipe(id) {
  if (!id) return "?";
  if (!equipeNomCache.has(id)) equipeNomCache.set(id, (await getEquipe(id))?.nom || "?");
  return equipeNomCache.get(id);
}

document.getElementById("j-arbitre-dispo").addEventListener("change", async (e) => {
  if (!currentPlayer) return;
  await updatePlayer(currentPlayer.id, { disponiblePourArbitrer: e.target.checked });
  currentPlayer.disponiblePourArbitrer = e.target.checked;
  renderArbitreStatut();
});

function renderArbitreStatut() {
  if (!currentPlayer) return;
  document.getElementById("j-arbitre-dispo").checked = !!currentPlayer.disponiblePourArbitrer;
  const statutEl = document.getElementById("j-arbitre-statut");
  const zone = document.getElementById("j-arbitre-zone");
  if (!currentPlayer.disponiblePourArbitrer) {
    statutEl.textContent = "";
    zone.hidden = true;
  } else if (!currentPlayer.arbitreValide) {
    statutEl.textContent = "En attente de validation par un organisateur avant d'avoir accès aux matchs à arbitrer.";
    zone.hidden = true;
  } else {
    statutEl.textContent = "✅ Validé comme arbitre.";
    zone.hidden = false;
    renderMatchsArbitrablesDisponibles();
    renderMesMatchsArbitre();
  }
}

async function renderMatchsArbitrablesDisponibles() {
  const container = document.getElementById("j-arbitre-disponibles");
  container.innerHTML = `<p class="muted">Chargement...</p>`;
  const matchs = await getMatchsArbitrablesDisponibles();
  if (!matchs.length) {
    container.innerHTML = `<p class="muted">Aucun match planifié sans arbitre pour l'instant.</p>`;
    return;
  }
  matchs.sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  const lignes = await Promise.all(
    matchs.map(async (m) => {
      const [tournoi, nomA, nomB] = await Promise.all([nomTournoi(m.tournamentId), nomEquipe(m.equipeAId), nomEquipe(m.equipeBId)]);
      return `<div class="card" style="margin-bottom:8px;">
        <strong>${nomA} vs ${nomB}</strong> <span class="muted">— ${tournoi}</span><br/>
        <span class="muted">${m.date} ${m.heure} — ${m.terrain || "terrain à préciser"}</span><br/>
        <button data-sassigner="${m.tournamentId}|${m.id}" style="margin-top:6px;">M'assigner comme arbitre</button>
      </div>`;
    })
  );
  container.innerHTML = lignes.join("");
  container.querySelectorAll("[data-sassigner]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const [tournamentId, matchId] = btn.dataset.sassigner.split("|");
      await updateMatch(tournamentId, matchId, { arbitreId: currentPlayer.id });
      renderMatchsArbitrablesDisponibles();
      renderMesMatchsArbitre();
    })
  );
}

async function renderMesMatchsArbitre() {
  const container = document.getElementById("j-arbitre-mes-matchs");
  container.innerHTML = `<p class="muted">Chargement...</p>`;
  const matchs = await getMesMatchsArbitre(currentPlayer.id);
  if (!matchs.length) {
    container.innerHTML = `<p class="muted">Aucun match qui t'est assigné pour l'instant.</p>`;
    return;
  }
  matchs.sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  const lignes = await Promise.all(
    matchs.map(async (m) => {
      const [tournoi, nomA, nomB] = await Promise.all([nomTournoi(m.tournamentId), nomEquipe(m.equipeAId), nomEquipe(m.equipeBId)]);
      const dejaJoue = m.scoreA !== null && m.scoreA !== undefined;
      return `<div class="card" style="margin-bottom:8px;">
        <strong>${nomA} vs ${nomB}</strong> <span class="muted">— ${tournoi}</span><br/>
        <span class="muted">${m.date} ${m.heure || ""} — ${m.terrain || ""}</span>
        ${dejaJoue ? `<p class="muted">Résultat déjà encodé : ${m.scoreA} - ${m.scoreB}</p>` : ""}
        <button data-mode-match="${m.tournamentId}|${m.id}" class="${dejaJoue ? "secondaire" : ""}" style="margin-top:6px;">
          ${dejaJoue ? "Modifier le résultat" : "Passer en mode match"}
        </button>
        <div data-zone-mode-match="${m.tournamentId}|${m.id}"></div>
      </div>`;
    })
  );
  container.innerHTML = lignes.join("");
  container.querySelectorAll("[data-mode-match]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const cle = btn.dataset.modeMatch;
      const [tournamentId, matchId] = cle.split("|");
      const m = matchs.find((mm) => mm.tournamentId === tournamentId && mm.id === matchId);
      afficherModeMatch(cle, m);
    })
  );
}

async function afficherModeMatch(cle, m) {
  const zone = document.querySelector(`[data-zone-mode-match="${cle}"]`);
  if (!zone) return;
  const nomA = await nomEquipe(m.equipeAId);
  const nomB = await nomEquipe(m.equipeBId);
  zone.innerHTML = `
    <div class="grille-form" style="margin-top:8px;">
      <input type="number" min="0" placeholder="Score ${nomA}" id="am-score-a" value="${m.scoreA ?? ""}" />
      <input type="number" min="0" placeholder="Score ${nomB}" id="am-score-b" value="${m.scoreB ?? ""}" />
      <select id="am-statut">
        <option value="joué" ${m.statutMatch === "joué" ? "selected" : ""}>Joué</option>
        <option value="interrompu" ${m.statutMatch === "interrompu" ? "selected" : ""}>Interrompu</option>
        <option value="forfait" ${m.statutMatch === "forfait" ? "selected" : ""}>Forfait</option>
      </select>
    </div>
    <p class="muted" style="margin:6px 0 2px;">Cartons :</p>
    <div class="grille-form">
      <input type="number" min="0" placeholder="🟨 ${nomA}" id="am-jaunes-a" value="0" />
      <input type="number" min="0" placeholder="🟥 ${nomA}" id="am-rouges-a" value="0" />
      <input type="number" min="0" placeholder="🟨 ${nomB}" id="am-jaunes-b" value="0" />
      <input type="number" min="0" placeholder="🟥 ${nomB}" id="am-rouges-b" value="0" />
    </div>
    <button id="am-btn-enregistrer" style="margin-top:8px;">Enregistrer le résultat</button>
    <p class="muted" id="am-result"></p>
  `;
  document.getElementById("am-btn-enregistrer").addEventListener("click", async () => {
    const scoreA = Number(document.getElementById("am-score-a").value);
    const scoreB = Number(document.getElementById("am-score-b").value);
    const statutMatch = document.getElementById("am-statut").value;
    const jaunesA = Number(document.getElementById("am-jaunes-a").value) || 0;
    const rougesA = Number(document.getElementById("am-rouges-a").value) || 0;
    const jaunesB = Number(document.getElementById("am-jaunes-b").value) || 0;
    const rougesB = Number(document.getElementById("am-rouges-b").value) || 0;
    const evenements = [
      ...Array(jaunesA).fill({ type: "carton_jaune", equipe: m.equipeAId }),
      ...Array(rougesA).fill({ type: "carton_rouge", equipe: m.equipeAId }),
      ...Array(jaunesB).fill({ type: "carton_jaune", equipe: m.equipeBId }),
      ...Array(rougesB).fill({ type: "carton_rouge", equipe: m.equipeBId }),
    ];
    await setMatchResult(m.tournamentId, m.id, { scoreA, scoreB, statutMatch, evenements });
    document.getElementById("am-result").textContent = "Résultat enregistré ✓";
    renderMesMatchsArbitre();
  });
}

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
