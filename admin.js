import { ADMIN_PASSPHRASE } from "./config.js";
import {
  createTournament, watchTournaments, getTournament, updateTournament, deleteTournament,
  createChampionnat, watchChampionnats, updateChampionnat, deleteChampionnat, getMatches,
  watchPlayers, updatePlayer, deletePlayer, getInscriptionsForEquipe,
  createEquipe, watchEquipes, updateEquipe, deleteEquipe, setEquipeAvailability, addEquipeMember, removeEquipeMember,
  addInscriptionMembre, removeInscriptionMembre, createPlayerNonRevendique,
  getToutesInscriptions, fusionnerJoueurs,
  inscrireEquipe, watchInscriptions, updateInscription, desinscrireEquipe, getInscriptions,
  createTerrain, watchTerrains, deleteTerrain, setTerrainAvailability,
  saveMatches, clearMatches, watchMatches, setMatchResult, actMatch, deleteMatch, updateMatch,
  getAdmins, watchAdmins, createAdmin, deleteAdmin,
} from "./db.js";
import {
  computeNbGroups, splitIntoGroups, scheduleMatches, computeStandings,
  computeQualifiers, generateKnockoutBracket, genererTourSuivant, stadeAtteintEquipe,
} from "./schedule.js";
import * as Grid from "./grid.js";

// ---------- AUTH (bootstrap verrouillable, comme agenda-conseil) ----------
const loginScreen = document.getElementById("login-screen");
const app = document.getElementById("app");
let currentAdmin = null; // { id, nom } une fois connecté

const btnLogin = document.getElementById("btn-login");
const adminPasswordInput = document.getElementById("admin-password");
let loginEnCours = false;

async function tenterLogin() {
  if (loginEnCours) return; // évite tout double-clic pendant la vérification
  loginEnCours = true;

  const pass = adminPasswordInput.value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  btnLogin.disabled = true;
  btnLogin.textContent = "Connexion...";

  try {
    // Un seul aller-retour réseau : on récupère la liste des admins une
    // fois, puis on 1. cherche un admin existant qui correspond, sinon
    // 2. accepte la passphrase de démarrage UNIQUEMENT s'il n'existe encore
    // aucun admin (bootstrap) — dès qu'un admin existe, elle est morte.
    const admins = await getAdmins();
    const admin = admins.find((a) => a.password === pass);
    if (admin) {
      currentAdmin = admin;
      loginScreen.hidden = true;
      app.hidden = false;
      init();
      return;
    }

    if (admins.length === 0 && pass === ADMIN_PASSPHRASE) {
      currentAdmin = null; // pas encore un vrai admin, juste le bootstrap
      loginScreen.hidden = true;
      app.hidden = false;
      init();
      return;
    }

    errorEl.textContent = "Mot de passe incorrect.";
  } catch (e) {
    errorEl.textContent = "Erreur de connexion à la base — réessaie dans un instant.";
    console.error(e);
  } finally {
    loginEnCours = false;
    btnLogin.disabled = false;
    btnLogin.textContent = "Se connecter";
  }
}

btnLogin.addEventListener("click", tenterLogin);
adminPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tenterLogin();
});

// ---------- ETAT ----------
let currentTournamentId = null;
let currentTournament = null;

let equipesGlobal = []; // TOUTES les équipes du hub (collection globale "equipes")
let inscriptions = []; // inscriptions du tournoi actuellement affiché (équipe <-> tournoi)
let teams = []; // vue fusionnée : équipe inscrite à CE tournoi + son inscription (groupe/statut/paiement)

let terrainsGlobal = []; // TOUS les terrains du hub (collection globale "terrains")
let venues = []; // terrains UTILISÉS par ce tournoi (sous-ensemble de terrainsGlobal), avec .creneaux

let matches = [];

let tournamentsList = []; // TOUS les tournois du hub (pour construire la checklist des championnats)
let championnatsList = [];
let joueursGlobal = []; // TOUS les comptes joueurs du hub (collection globale "joueurs")

// ---- Disponibilités des terrains (grille peinte) ----
let selectedVenueId = null;
let terrainDispoMode = "available";
let terrainDispoMarks = {};
let isPaintingTerrain = false;
let paintActionTerrain = null;
const terrainDispoDates = Grid.buildDateList(new Date(), 21);
const terrainDispoTimes = Grid.buildTimeSlots();

// ---- Sondage des équipes façon Doodle (tournoi entier) ----
let modeSondage = false;
let sondageSelection = new Set();
let sondageTerrainIds = new Set();

function renderSondageTournoiSelect() {
  const select = document.getElementById("sondage-tournoi-select");
  if (!select) return;
  select.innerHTML = tournamentsList
    .map((t) => `<option value="${t.id}">${t.historique ? "🗄 " : ""}${t.nom}</option>`)
    .join("");
  if (currentTournamentId) select.value = currentTournamentId;
}

function renderSondageTerrainsChecklist() {
  const container = document.getElementById("sondage-terrains-checklist");
  if (!container) return;
  if (!venues.length) {
    container.innerHTML = "Aucun terrain alloué à ce tournoi.";
    sondageTerrainIds.clear();
    return;
  }
  container.innerHTML = venues
    .map(
      (v) => `<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <input type="checkbox" class="sondage-terrain-check" value="${v.id}" style="width:auto;" ${sondageTerrainIds.has(v.id) ? "checked" : ""} /> ${v.nom}
    </label>`
    )
    .join("");
  container.querySelectorAll(".sondage-terrain-check").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      if (e.target.checked) sondageTerrainIds.add(e.target.value);
      else sondageTerrainIds.delete(e.target.value);
      renderAdminDispoGrid();
    })
  );
}

let initDone = false;

function init() {
  // ⚠️ init() peut être appelée plusieurs fois (si l'utilisateur clique
  // plusieurs fois sur "Se connecter", ou re-tente une connexion) — sans
  // cette garde, tous les écouteurs de clic étaient réattachés à chaque
  // fois, ce qui multipliait les équipes/terrains créés à un seul clic.
  if (initDone) return;
  initDone = true;

  watchAdmins(renderAdmins);

  watchPlayers((list) => {
    joueursGlobal = list;
    renderJoueurs();
  });

  // Équipes et terrains sont globaux : on les écoute une seule fois, pas
  // par tournoi.
  watchEquipes((list) => {
    equipesGlobal = list;
    recomputeTeams();
    renderEquipesDisponibles();
  });

  watchTerrains((list) => {
    terrainsGlobal = list;
    recomputeVenues();
    renderTerrainsDisponibles();
    populateTerrainDispoSelect();
  });

  watchTournaments((list) => {
    tournamentsList = list;
    const select = document.getElementById("select-tournament");
    select.innerHTML = list
      .map((t) => `<option value="${t.id}">${t.historique ? "🗄 " : ""}${t.nom}${t.dateDebut ? ` — ${formaterDateFr(t.dateDebut)}` : ""}</option>`)
      .join("");
    if (list.length && !currentTournamentId) {
      selectTournament(list[0].id);
    }
    renderChampTournoisChecklist();
    renderChampionnats();
    renderSondageTournoiSelect();
  });

  watchChampionnats((list) => {
    championnatsList = list;
    renderChampionnats();
  });

  document.getElementById("btn-creer-championnat").addEventListener("click", async () => {
    const nom = document.getElementById("champ-nom").value.trim();
    if (!nom) return alert("Le nom du championnat est obligatoire.");
    const tournamentIds = [...document.querySelectorAll("#champ-tournois-checklist input:checked")].map((c) => c.value);
    if (tournamentIds.length < 2) {
      if (!confirm("Moins de 2 tournois sélectionnés — un championnat à un seul tournoi n'a pas grand intérêt. Créer quand même ?")) return;
    }
    const inclurePhaseFinale = document.getElementById("champ-inclure-finale").checked;
    await createChampionnat({ nom, tournamentIds, inclurePhaseFinale });
    document.getElementById("champ-nom").value = "";
  });

  document.getElementById("select-tournament").addEventListener("change", (e) => {
    selectTournament(e.target.value);
  });

  document.getElementById("sondage-tournoi-select").addEventListener("change", (e) => {
    selectTournament(e.target.value);
  });

  document.getElementById("btn-new-tournament").addEventListener("click", () => {
    document.getElementById("new-tournament-form").hidden = false;
  });

  document.getElementById("nt-inscriptions-ouvertes").addEventListener("change", async (e) => {
    if (!currentTournamentId) return;
    await updateTournament(currentTournamentId, { inscriptionsOuvertes: e.target.checked });
    currentTournament = await getTournament(currentTournamentId);
  });

  document.getElementById("btn-create-tournament").addEventListener("click", async () => {
    const btn = document.getElementById("btn-create-tournament");
    const nom = document.getElementById("nt-nom").value.trim();
    if (!nom) return alert("Le nom du tournoi est obligatoire.");
    btn.disabled = true;
    btn.textContent = "Création...";
    try {
      const nbQualifiesRaw = document.getElementById("nt-nbqualifies").value;
      const id = await createTournament({
        nom,
        dateDebut: document.getElementById("nt-datedebut").value || null,
        dateFin: document.getElementById("nt-datefin").value || null,
        tailleGroupeVisee: Number(document.getElementById("nt-taillegroupe").value),
        nbMiTemps: Number(document.getElementById("nt-nbmitemps").value),
        dureeMiTemps: Number(document.getElementById("nt-dureemitemps").value),
        duréePause: Number(document.getElementById("nt-pause").value),
        allerRetour: document.getElementById("nt-allerretour").checked,
        nbQualifiesPhaseFinale: nbQualifiesRaw ? Number(nbQualifiesRaw) : null,
        historique: document.getElementById("nt-historique").checked,
      });
      document.getElementById("new-tournament-form").hidden = true;
      selectTournament(id);
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la création du tournoi : " + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Créer le tournoi";
    }
  });

  document.getElementById("btn-save-tournoi").addEventListener("click", async () => {
    if (!currentTournamentId) return;
    const statusEl = document.getElementById("tn-save-status");
    const nbQualifiesRaw = document.getElementById("tn-nbqualifies").value;
    try {
      await updateTournament(currentTournamentId, {
        nom: document.getElementById("tn-nom").value.trim(),
        dateDebut: document.getElementById("tn-datedebut").value || null,
        dateFin: document.getElementById("tn-datefin").value || null,
        tailleGroupeVisee: Number(document.getElementById("tn-taillegroupe").value),
        nbMiTemps: Number(document.getElementById("tn-nbmitemps").value),
        dureeMiTemps: Number(document.getElementById("tn-dureemitemps").value),
        duréePause: Number(document.getElementById("tn-pause").value),
        allerRetour: document.getElementById("tn-allerretour").checked,
        nbQualifiesPhaseFinale: nbQualifiesRaw ? Number(nbQualifiesRaw) : null,
        historique: document.getElementById("tn-historique").checked,
        inscriptionsOuvertes: document.getElementById("tn-historique").checked ? false : currentTournament.inscriptionsOuvertes,
      });
      currentTournament = await getTournament(currentTournamentId);
      renderTournoiSettings();
      // Le sélecteur de tournoi en haut de page et la carte "Tournois" de la
      // page publique affichent le nom — on les rafraîchit pour rester
      // cohérent sans attendre le prochain snapshot Firestore.
      const opt = document.querySelector(`#select-tournament option[value="${currentTournamentId}"]`);
      if (opt) opt.textContent = currentTournament.nom;
      statusEl.textContent = "Enregistré ✓";
      setTimeout(() => (statusEl.textContent = ""), 2500);
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Erreur : " + (e.message || e);
    }
  });

  document.getElementById("btn-delete-tournoi").addEventListener("click", async () => {
    if (!currentTournamentId || !currentTournament) return;
    if (!confirm(`Supprimer définitivement le tournoi "${currentTournament.nom}" ? Ses inscriptions et matchs seront perdus. Les équipes du hub ne sont pas touchées.`)) return;
    if (!confirm("Vraiment sûr ? Cette action est irréversible.")) return;
    const idASupprimer = currentTournamentId;
    await deleteTournament(idASupprimer);
    currentTournamentId = null;
    currentTournament = null;
    document.getElementById("tabs").hidden = true;
    alert("Tournoi supprimé.");
  });

  document.getElementById("btn-bulk-statut").addEventListener("click", async () => {
    const ids = [...document.querySelectorAll(".check-team:checked")].map((cb) => cb.value);
    if (!ids.length) return alert("Aucune équipe cochée.");
    const statut = document.getElementById("bulk-statut-select").value;
    await Promise.all(ids.map((id) => updateInscription(currentTournamentId, id, { statut })));
  });

  document.getElementById("btn-bulk-paiement").addEventListener("click", async () => {
    const ids = [...document.querySelectorAll(".check-team:checked")].map((cb) => cb.value);
    if (!ids.length) return alert("Aucune équipe cochée.");
    const statutPaiement = document.getElementById("bulk-paiement-select").value;
    await Promise.all(ids.map((id) => updateInscription(currentTournamentId, id, { statutPaiement })));
  });

  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((s) => (s.hidden = true));
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      if (btn.dataset.tab === "resultats") renderResultsForm();
      if (btn.dataset.tab === "classement") renderStandings();
      if (btn.dataset.tab === "dispos") {
        const scope = document.getElementById("dispo-scope-select").value;
        if (scope === "equipes") {
          renderAdminDispoGrid();
          updateSondageStatus();
        } else {
          renderTerrainDispoGrid();
        }
      }
    });
  });

  document.getElementById("dispo-view-select").addEventListener("change", renderAdminDispoGrid);

  document.getElementById("dispo-scope-select").addEventListener("change", (e) => {
    const scope = e.target.value;
    document.getElementById("dispo-scope-equipes").hidden = scope !== "equipes";
    document.getElementById("dispo-scope-terrains").hidden = scope !== "terrains";
    if (scope === "equipes") {
      renderAdminDispoGrid();
      updateSondageStatus();
    } else {
      renderTerrainDispoGrid();
    }
  });

  document.getElementById("btn-toggle-mode-sondage").addEventListener("click", (e) => {
    modeSondage = !modeSondage;
    e.target.classList.toggle("mode-active", modeSondage);
    e.target.textContent = modeSondage ? "🔶 Sélection en cours (clique sur les cases)" : "🔶 Sélectionner des créneaux à sonder";
  });

  document.getElementById("btn-sonder-appliquer").addEventListener("click", async () => {
    if (!sondageSelection.size) return alert("Sélectionne d'abord des créneaux (active le mode sélection).");
    const existants = new Set(currentTournament.sondages || []);
    sondageSelection.forEach((k) => existants.add(k));
    await updateTournament(currentTournamentId, { sondages: [...existants] });
    currentTournament = await getTournament(currentTournamentId);
    sondageSelection.clear();
    renderAdminDispoGrid();
    updateSondageStatus();
    alert("Créneaux sondés — ils apparaîtront en orange chez les équipes concernées jusqu'à leur réponse.");
  });

  document.getElementById("btn-sonder-vider").addEventListener("click", async () => {
    if (!confirm("Vider tous les créneaux sondés en cours pour ce tournoi ?")) return;
    await updateTournament(currentTournamentId, { sondages: [] });
    currentTournament = await getTournament(currentTournamentId);
    updateSondageStatus();
  });

  document.getElementById("btn-add-admin").addEventListener("click", async () => {
    const nom = document.getElementById("ad-nom").value.trim();
    const password = document.getElementById("ad-password").value.trim();
    if (!nom || !password) return alert("Nom et mot de passe obligatoires.");
    try {
      await createAdmin(nom, password);
      document.getElementById("ad-nom").value = "";
      document.getElementById("ad-password").value = "";
      alert("Administrateur ajouté. S'il s'agit du premier, le mot de passe de démarrage ne fonctionne plus.");
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'ajout de l'administrateur : " + (e.message || e));
    }
  });

  // ---- Détection de noms proches (équipes + joueurs, sur tout le hub) ----
  document.getElementById("btn-verifier-doublons").addEventListener("click", lancerVerificationDoublons);

  // ---- Palmarès global (participation/victoires par joueur, tout le hub) ----
  document.getElementById("btn-calculer-palmares").addEventListener("click", async () => {
    const btn = document.getElementById("btn-calculer-palmares");
    const container = document.getElementById("palmares-result");
    btn.disabled = true;
    btn.textContent = "Calcul en cours...";
    container.innerHTML = `<p class="muted">Analyse de tous les tournois et matchs...</p>`;
    try {
      const stats = await calculerPalmaresGlobal();
      afficherPalmaresGlobal(stats);
    } catch (e) {
      console.error(e);
      container.innerHTML = `<p class="muted">Erreur pendant le calcul : ${e.message || e}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "📊 Calculer le palmarès";
    }
  });

  // ---- Équipes : créer (globale) + inscrire automatiquement à ce tournoi ----
  document.getElementById("btn-add-team").addEventListener("click", async () => {
    const btn = document.getElementById("btn-add-team");
    const nom = document.getElementById("eq-nom").value.trim();
    const password = document.getElementById("eq-password").value.trim();
    if (!nom || !password) return alert("Nom et mot de passe capitaine obligatoires.");
    if (!currentTournamentId) return alert("Aucun tournoi sélectionné — choisis ou crée d'abord un tournoi en haut de page.");
    btn.disabled = true;
    btn.textContent = "Ajout...";
    try {
      const equipeId = await createEquipe({ nom, capitainePassword: password });
      await inscrireEquipe(currentTournamentId, equipeId);
      document.getElementById("eq-nom").value = "";
      document.getElementById("eq-password").value = "";
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'ajout de l'équipe : " + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Ajouter l'équipe";
    }
  });

  // ---- Terrains : créer (global) ----
  document.getElementById("btn-add-venue").addEventListener("click", async () => {
    const nom = document.getElementById("ter-nom").value.trim();
    if (!nom) return alert("Nom du terrain obligatoire.");
    try {
      await createTerrain(nom);
      document.getElementById("ter-nom").value = "";
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'ajout du terrain : " + (e.message || e));
    }
  });

  // ---- Grille de disponibilité des terrains + marquage rapide ----
  document.getElementById("ter-dispo-select").addEventListener("change", (e) => {
    selectedVenueId = e.target.value || null;
    loadSelectedVenueMarks();
    renderTerrainDispoGrid();
  });

  function setTerrainDispoMode(mode) {
    terrainDispoMode = mode;
    document.getElementById("ter-mode-available").classList.toggle("mode-active", mode === "available");
    document.getElementById("ter-mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
  }
  document.getElementById("ter-mode-available").addEventListener("click", () => setTerrainDispoMode("available"));
  document.getElementById("ter-mode-unavailable").addEventListener("click", () => setTerrainDispoMode("unavailable"));

  document.getElementById("ter-btn-toggle-marquage-rapide").addEventListener("click", () => {
    const panel = document.getElementById("ter-marquage-rapide-panel");
    panel.hidden = !panel.hidden;
  });

  const TER_BULK_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lundi -> dimanche
  const terMrJoursContainer = document.getElementById("ter-mr-jours");
  TER_BULK_DAY_ORDER.forEach((dow) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "ter-mr-jour-checkbox";
    input.value = String(dow);
    input.checked = true;
    input.disabled = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + Grid.WEEKDAYS_FULL[dow].slice(0, 3)));
    terMrJoursContainer.appendChild(label);
  });

  document.getElementById("ter-mr-tous-jours").addEventListener("change", (e) => {
    const checked = e.target.checked;
    terMrJoursContainer.querySelectorAll(".ter-mr-jour-checkbox").forEach((cb) => {
      cb.disabled = checked;
      cb.checked = checked;
    });
  });

  let terMrMode = "available";
  function setTerMrMode(mode) {
    terMrMode = mode;
    document.getElementById("ter-mr-mode-available").classList.toggle("mode-active", mode === "available");
    document.getElementById("ter-mr-mode-unavailable").classList.toggle("mode-active", mode === "unavailable");
    document.getElementById("ter-mr-mode-clear").classList.toggle("mode-active", mode === "clear");
  }
  document.getElementById("ter-mr-mode-available").addEventListener("click", () => setTerMrMode("available"));
  document.getElementById("ter-mr-mode-unavailable").addEventListener("click", () => setTerMrMode("unavailable"));
  document.getElementById("ter-mr-mode-clear").addEventListener("click", () => setTerMrMode("clear"));

  document.getElementById("ter-btn-mr-appliquer").addEventListener("click", async () => {
    if (!selectedVenueId) return alert("Sélectionne d'abord un terrain.");
    const tousJours = document.getElementById("ter-mr-tous-jours").checked;
    const joursSelectionnes = new Set(
      [...terMrJoursContainer.querySelectorAll(".ter-mr-jour-checkbox")]
        .filter((cb) => tousJours || cb.checked)
        .map((cb) => Number(cb.value))
    );
    const heureDebut = document.getElementById("ter-mr-heure-debut").value || null;
    const heureFin = document.getElementById("ter-mr-heure-fin").value || null;
    const dateDebut = document.getElementById("ter-mr-date-debut").value || null;
    const dateFin = document.getElementById("ter-mr-date-fin").value || null;
    const seulementVide = document.getElementById("ter-mr-seulement-vide").checked;

    const cibles = [];
    terrainDispoDates.forEach((date) => {
      const dateISO = Grid.toISODate(date);
      if (dateDebut && dateISO < dateDebut) return;
      if (dateFin && dateISO > dateFin) return;
      if (!joursSelectionnes.has(date.getDay())) return;
      terrainDispoTimes.forEach((timeLabel) => {
        if (heureDebut && timeLabel < heureDebut) return;
        if (heureFin && timeLabel >= heureFin) return;
        const key = Grid.slotKey(dateISO, timeLabel);
        if (seulementVide && terrainDispoMarks[key]) return;
        cibles.push(key);
      });
    });

    if (!cibles.length) {
      document.getElementById("ter-mr-result").textContent = "Aucun créneau ne correspond à ces critères.";
      return;
    }

    const nouvelleValeur = terMrMode === "clear" ? null : terMrMode;
    cibles.forEach((key) => {
      if (nouvelleValeur) terrainDispoMarks[key] = nouvelleValeur;
      else delete terrainDispoMarks[key];
    });

    renderTerrainDispoGrid();
    document.getElementById("ter-mr-result").textContent = `${cibles.length} créneau(x) mis à jour.`;
    await persistTerrainDispoMarks();
  });

  document.addEventListener("mouseup", () => {
    if (isPaintingTerrain) {
      isPaintingTerrain = false;
      persistTerrainDispoMarks();
    }
  });

  let generationEnCours = false;
  document.getElementById("btn-generate-schedule").addEventListener("click", async () => {
    // ⚠️ garde contre les double-clics / clics répétés : sans ça, chaque
    // clic empilait un nouveau lot de matchs par-dessus l'ancien.
    if (generationEnCours) return;

    if (!teams.length) return alert("Inscris d'abord des équipes à ce tournoi.");
    if (!venues.length || venues.every((v) => !v.creneaux?.length)) {
      return alert("Sélectionne d'abord au moins un terrain pour ce tournoi (onglet Terrains) et déclare ses créneaux de disponibilité (onglet Disponibilités → Terrains).");
    }

    const btn = document.getElementById("btn-generate-schedule");
    generationEnCours = true;
    btn.disabled = true;
    btn.textContent = "Génération...";

    try {
      // Efface le calendrier de poule existant AVANT d'en générer un
      // nouveau, pour que "Générer" remplace plutôt que d'empiler. La
      // phase finale (si déjà générée) n'est pas touchée.
      const ancienMatchsPoule = matches.filter((m) => m.phase === "poule");
      await Promise.all(ancienMatchsPoule.map((m) => deleteMatch(currentTournamentId, m.id)));

      const groupes = splitIntoGroups(teams, currentTournament.tailleGroupeVisee);
      console.log(`Génération : ${teams.length} équipe(s) répartie(s) en ${groupes.length} groupe(s)`, groupes.map((g) => ({ groupe: g.nom, equipes: g.equipes.map((e) => e.nom) })));

      for (const g of groupes) {
        for (const eq of g.equipes) {
          if (eq.groupe !== g.nom) await updateInscription(currentTournamentId, eq.id, { groupe: g.nom });
        }
      }
      const generated = scheduleMatches({
        groupes,
        venues,
        nbMiTemps: currentTournament.nbMiTemps,
        dureeMiTemps: currentTournament.dureeMiTemps,
        duréePause: currentTournament.duréePause,
        allerRetour: currentTournament.allerRetour,
      });
      const nonPlaces = generated.filter((m) => m.date === null).length;
      await saveMatches(currentTournamentId, generated);
      alert(
        `${generated.length} matchs générés pour ${teams.length} équipe(s) en ${groupes.length} groupe(s).` +
          (nonPlaces ? `\n⚠️ ${nonPlaces} match(s) n'ont pas pu être placés faute de créneaux disponibles.` : "")
      );
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la génération du calendrier : " + (e.message || e));
    } finally {
      generationEnCours = false;
      btn.disabled = false;
      btn.textContent = "Générer le calendrier";
    }
  });

  document.getElementById("btn-clear-schedule").addEventListener("click", async () => {
    if (confirm("Effacer tous les matchs générés ?")) await clearMatches(currentTournamentId);
  });

  // ---------- Import d'un tournoi déjà joué (équipes/membres/matchs en CSV) ----------
  let importEnCours = false;
  document.getElementById("btn-import-tournoi").addEventListener("click", async () => {
    if (importEnCours) return;

    const fichiers = [...document.getElementById("imp-files").files];
    if (!fichiers.length) {
      return alert("Choisis au moins un fichier CSV à importer.");
    }

    const btn = document.getElementById("btn-import-tournoi");
    const resultEl = document.getElementById("import-result");
    importEnCours = true;
    btn.disabled = true;
    btn.textContent = "Import en cours...";
    resultEl.textContent = "";

    try {
      // Détection automatique du type de chaque fichier déposé, à partir de
      // ses colonnes — plus besoin de se souvenir de quelle case correspond
      // à quoi, ni de risquer de mettre le mauvais fichier au mauvais
      // endroit : on regarde ce que chaque fichier CONTIENT et on range en
      // conséquence, en ignorant ce qui ne correspond à rien de connu.
      const rowsEquipes = [];
      const rowsMembres = [];
      const rowsMatchs = [];
      const rapportDetection = [];
      for (const fichier of fichiers) {
        const rows = await readCsvFile(fichier);
        if (!rows.length) {
          rapportDetection.push(`"${fichier.name}" : fichier vide, ignoré.`);
          continue;
        }
        const entetes = new Set(Object.keys(rows[0]));
        let type;
        if (entetes.has("equipea") || entetes.has("equipeb")) {
          type = "matchs";
          rowsMatchs.push(...rows);
        } else if (entetes.has("equipe") && entetes.has("nom")) {
          type = "membres";
          rowsMembres.push(...rows);
        } else if (entetes.has("nom")) {
          type = "équipes";
          rowsEquipes.push(...rows);
        } else {
          type = null;
        }
        rapportDetection.push(
          type
            ? `"${fichier.name}" → reconnu comme fichier ${type} (${rows.length} ligne(s)).`
            : `"${fichier.name}" : colonnes non reconnues (${[...entetes].join(", ") || "aucune"}) — ignoré.`
        );
      }

      // Regroupement par tournoi : si les fichiers ont une colonne "tournoi"
      // (cas d'un import qui mélange plusieurs anciens tournois d'un coup —
      // chaque PDF a son propre nom de tournoi), chaque groupe est importé
      // dans SON tournoi à lui (créé automatiquement, marqué historique, si
      // aucun tournoi existant ne porte ce nom) plutôt que tout mélanger
      // dans le tournoi actuellement sélectionné. Une ligne sans colonne
      // "tournoi" (ou vide) garde l'ancien comportement : le tournoi
      // actuellement sélectionné en haut de page.
      function clePourGroupe(row) {
        const nomTournoiCsv = champCsv(row, "tournoi", "tournoi_nom", "nom du tournoi").trim();
        return nomTournoiCsv || null; // null = "pas de colonne, utiliser le tournoi sélectionné"
      }
      const nomsTournoisPresents = new Set([...rowsEquipes, ...rowsMatchs, ...rowsMembres].map(clePourGroupe));

      // Le tournoi sélectionné en haut de page n'est nécessaire QUE si au
      // moins une ligne n'a pas de colonne "tournoi" à elle (donc compte sur
      // le tournoi actuellement affiché) — un import entièrement étiqueté
      // par tournoi n'en a pas besoin.
      if (nomsTournoisPresents.has(null) && !currentTournamentId) {
        throw new Error(
          "Au moins une ligne de ton fichier n'a pas de colonne \"tournoi\" — sélectionne ou crée d'abord un tournoi en haut de page pour ces lignes-là, ou ajoute la colonne \"tournoi\" partout."
        );
      }

      // Un seul mot-clé "tournoi" peut apparaître sous plusieurs casses —
      // on regroupe par nom normalisé pour éviter de créer deux tournois
      // "Tournoi A" / "tournoi a".
      const tournoiIdParCle = new Map(); // clé normalisée (ou null) -> tournamentId
      const tournoisAutoCrees = [];
      for (const nomTournoiCsv of nomsTournoisPresents) {
        if (nomTournoiCsv === null) {
          tournoiIdParCle.set(null, currentTournamentId);
          continue;
        }
        const cle = normaliseNom(nomTournoiCsv);
        const existant = tournamentsList.find((t) => normaliseNom(t.nom) === cle);
        if (existant) {
          tournoiIdParCle.set(cle, existant.id);
        } else {
          const id = await createTournament({ nom: nomTournoiCsv, historique: true });
          tournoiIdParCle.set(cle, id);
          tournoisAutoCrees.push(nomTournoiCsv);
        }
      }
      function tournamentIdPourRow(row) {
        const nomTournoiCsv = clePourGroupe(row);
        return nomTournoiCsv === null ? currentTournamentId : tournoiIdParCle.get(normaliseNom(nomTournoiCsv));
      }

      // Conversion des groupes en lettres (A, B, C...) partout, même si le
      // fichier source utilise des chiffres (1, 2, 3) — cohérence d'affichage
      // sur tout le site. Une lettre par tournoi, attribuée dans l'ordre de
      // première apparition ; si la valeur du fichier est déjà une lettre
      // seule, elle est gardée telle quelle (en majuscule).
      const lettresGroupeParTournoi = new Map(); // tournamentId -> Map(valeurBrute -> lettre)
      function lettreGroupe(tournamentId, valeurBrute) {
        const v = valeurBrute.trim();
        if (!v) return v;
        if (/^[a-zA-Z]$/.test(v)) return v.toUpperCase();
        if (!lettresGroupeParTournoi.has(tournamentId)) lettresGroupeParTournoi.set(tournamentId, new Map());
        const table = lettresGroupeParTournoi.get(tournamentId);
        if (!table.has(v)) table.set(v, String.fromCharCode(65 + table.size));
        return table.get(v);
      }

      // Équipes (globales, réutilisées si le nom correspond déjà) — utilisé
      // par TOUS les groupes, pour que la même équipe ne soit pas recréée
      // en double si elle apparaît dans plusieurs des tournois importés.
      const nomVersId = new Map(equipesGlobal.map((e) => [normaliseNom(e.nom), e.id]));
      const nouveauxMotsDePasse = [];

      // 1. Équipes + inscription + groupe, tournoi par tournoi.
      const inscriptionsExistantesParTournoi = new Map(); // tournamentId -> Set(equipeId déjà inscrites)
      const equipeIdVersGroupeParTournoi = new Map(); // tournamentId -> Map(equipeId -> groupe)
      async function inscriptionsDe(tournamentId) {
        if (!inscriptionsExistantesParTournoi.has(tournamentId)) {
          const insc = tournamentId === currentTournamentId ? teams.map((t) => ({ equipeId: t.id, groupe: t.groupe })) : await getInscriptions(tournamentId);
          inscriptionsExistantesParTournoi.set(tournamentId, new Set(insc.map((i) => i.equipeId || i.id)));
          equipeIdVersGroupeParTournoi.set(tournamentId, new Map(insc.filter((i) => i.groupe).map((i) => [i.equipeId || i.id, i.groupe])));
        }
        return inscriptionsExistantesParTournoi.get(tournamentId);
      }

      for (const row of rowsEquipes) {
        const nom = champCsv(row, "nom").trim();
        if (!nom) continue;
        const tournamentId = tournamentIdPourRow(row);
        if (!tournamentId) continue;
        const cle = normaliseNom(nom);
        let equipeId = nomVersId.get(cle);
        if (!equipeId) {
          const motDePasse = genererMotDePasseTemp();
          equipeId = await createEquipe({ nom, capitainePassword: motDePasse });
          nomVersId.set(cle, equipeId);
          nouveauxMotsDePasse.push(`${nom} → ${motDePasse}`);
        }
        const dejaInscrites = await inscriptionsDe(tournamentId);
        if (!dejaInscrites.has(equipeId)) {
          await inscrireEquipe(tournamentId, equipeId);
          dejaInscrites.add(equipeId);
        }
        const groupeCsvBrut = champCsv(row, "groupe").trim();
        if (groupeCsvBrut) {
          const groupeCsv = lettreGroupe(tournamentId, groupeCsvBrut);
          await updateInscription(tournamentId, equipeId, { groupe: groupeCsv });
          equipeIdVersGroupeParTournoi.get(tournamentId).set(equipeId, groupeCsv);
        }
      }

      // 2. Membres : ajoutés en "libre" (sans compte) sur l'INSCRIPTION au
      // tournoi concerné (pas sur l'équipe globale) — pour que la même
      // équipe qui revient dans plusieurs tournois ait un effectif distinct
      // à chaque fois, plutôt qu'un effectif mélangé. Doublons évités si le
      // même import est relancé deux fois, par tournoi.
      const membresHistoriqueParTournoi = new Map(); // tournamentId -> Map(equipeId -> membresHistorique[] déjà là ou tout juste ajoutés)
      async function membresHistoriqueActuels(tournamentId, equipeId) {
        if (!membresHistoriqueParTournoi.has(tournamentId)) {
          const insc = tournamentId === currentTournamentId
            ? teams.map((t) => ({ equipeId: t.id, membresHistorique: t.membresHistorique || [] }))
            : await getInscriptions(tournamentId);
          membresHistoriqueParTournoi.set(
            tournamentId,
            new Map(insc.map((i) => [i.equipeId || i.id, [...(i.membresHistorique || [])]]))
          );
        }
        const table = membresHistoriqueParTournoi.get(tournamentId);
        if (!table.has(equipeId)) table.set(equipeId, []);
        return table.get(equipeId);
      }

      let nbMembresAjoutes = 0;
      for (const row of rowsMembres) {
        const cleEquipe = normaliseNom(champCsv(row, "equipe"));
        const nomMembre = champCsv(row, "nom").trim();
        if (!nomMembre || !nomVersId.has(cleEquipe)) continue;
        const equipeId = nomVersId.get(cleEquipe);
        const tournamentId = tournamentIdPourRow(row);
        if (!tournamentId) continue;
        const membresActuels = await membresHistoriqueActuels(tournamentId, equipeId);
        const dejaMembre = membresActuels.some((m) => normaliseNom(m.nom) === normaliseNom(nomMembre));
        if (dejaMembre) continue;
        // Chaque membre importé obtient directement un vrai compte joueur
        // (sans mot de passe, "non revendiqué") — n'importe qui pourra
        // ensuite le retrouver par son nom et le réclamer pour de bon.
        const joueurId = await createPlayerNonRevendique(nomMembre);
        await addInscriptionMembre(tournamentId, equipeId, { type: "non_revendique", joueurId, nom: nomMembre });
        membresActuels.push({ type: "non_revendique", joueurId, nom: nomMembre });
        nbMembresAjoutes++;
      }

      // 3. Matchs, tournoi par tournoi — créés directement avec les horaires
      // du fichier (pas de recalcul via le générateur auto). Le terrain
      // vient de la colonne "terrain" du CSV si présente, sinon du champ
      // texte de secours.
      const terrainParDefaut = document.getElementById("imp-terrain-defaut").value.trim();
      const nomsIntrouvables = new Set();
      const matchsCandidatsParTournoi = new Map(); // tournamentId -> [matchs]
      for (const row of rowsMatchs) {
        const tournamentId = tournamentIdPourRow(row);
        if (!tournamentId) continue;
        const nomEquipeA = champCsv(row, "equipeA", "equipe a", "equipea");
        const nomEquipeB = champCsv(row, "equipeB", "equipe b", "equipeb");
        const idA = nomVersId.get(normaliseNom(nomEquipeA));
        const idB = nomVersId.get(normaliseNom(nomEquipeB));
        if (!idA) nomsIntrouvables.add(nomEquipeA || "(colonne équipeA vide)");
        if (!idB) nomsIntrouvables.add(nomEquipeB || "(colonne équipeB vide)");
        if (!idA || !idB) continue;
        await inscriptionsDe(tournamentId); // s'assure que equipeIdVersGroupeParTournoi est peuplé
        const groupeCsvMatchBrut = champCsv(row, "groupe").trim();
        const groupeCsvMatch = groupeCsvMatchBrut ? lettreGroupe(tournamentId, groupeCsvMatchBrut) : "";
        const equipeIdVersGroupe = equipeIdVersGroupeParTournoi.get(tournamentId);
        if (!matchsCandidatsParTournoi.has(tournamentId)) matchsCandidatsParTournoi.set(tournamentId, []);
        matchsCandidatsParTournoi.get(tournamentId).push({
          equipeAId: idA,
          equipeBId: idB,
          groupe: groupeCsvMatch || equipeIdVersGroupe.get(idA) || equipeIdVersGroupe.get(idB) || null,
          phase: "poule",
          terrain: champCsv(row, "terrain").trim() || terrainParDefaut || "À préciser",
          date: champCsv(row, "date").trim() || null,
          heure: champCsv(row, "heureDebut", "heure debut", "heure").trim() || null,
        });
      }

      // Détection de doublons : même paire d'équipes (peu importe l'ordre)
      // + même date + même heure, comparé aux matchs déjà présents DANS LE
      // MÊME tournoi ET entre les lignes du fichier lui-même.
      function signatureMatch(m) {
        return [m.equipeAId, m.equipeBId].sort().join("|") + "|" + (m.date || "") + "|" + (m.heure || "");
      }
      let nbMatchsImportes = 0;
      let nbMatchsIgnores = 0;
      let nbGroupesRepares = 0;
      for (const [tournamentId, matchsCandidats] of matchsCandidatsParTournoi) {
        const matchsExistants = tournamentId === currentTournamentId ? matches : await getMatches(tournamentId);
        const matchsExistantsParSignature = new Map(matchsExistants.map((m) => [signatureMatch(m), m]));
        const matchsAImporter = [];
        const doublonsDetectes = [];
        const signaturesVues = new Set(matchsExistantsParSignature.keys());
        for (const m of matchsCandidats) {
          const sig = signatureMatch(m);
          if (signaturesVues.has(sig)) {
            doublonsDetectes.push(m);
            const existant = matchsExistantsParSignature.get(sig);
            if (existant && !existant.groupe && m.groupe) {
              await updateMatch(tournamentId, existant.id, { groupe: m.groupe });
              nbGroupesRepares++;
            }
          } else {
            signaturesVues.add(sig);
            matchsAImporter.push(m);
          }
        }

        let matchsFinal = matchsAImporter;
        if (doublonsDetectes.length) {
          const nomTournoiAffiche = tournamentId === currentTournamentId ? currentTournament.nom : tournamentsList.find((t) => t.id === tournamentId)?.nom || tournamentId;
          const detail = doublonsDetectes
            .map((m) => `${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}${m.date ? " — " + m.date : ""}${m.heure ? " " + m.heure : ""}`)
            .join("\n");
          const ignorerDoublons = confirm(
            `⚠️ [${nomTournoiAffiche}] ${doublonsDetectes.length} doublon(s) détecté(s) (même équipes + même date/heure qu'un match déjà présent, ou répété dans le fichier) :\n\n${detail}\n\nOK = ignorer ces doublons et importer seulement les nouveaux matchs.\nAnnuler = les importer quand même (créera des matchs en double).`
          );
          if (!ignorerDoublons) matchsFinal = matchsCandidats;
        }

        if (matchsFinal.length) await saveMatches(tournamentId, matchsFinal);
        nbMatchsImportes += matchsFinal.length;
        nbMatchsIgnores += matchsCandidats.length - matchsFinal.length;
      }

      const lignes = [
        ...rapportDetection,
        `${rowsEquipes.length} équipe(s) traitée(s) dans le fichier équipes.`,
        `${nbMembresAjoutes} membre(s) ajouté(s).`,
        `${nbMatchsImportes} match(s) importé(s)${nbMatchsIgnores ? ` (${nbMatchsIgnores} ignoré(s) : ${nomsIntrouvables.size ? "équipe introuvable et/ou " : ""}doublon détecté)` : ""}.`,
      ];
      if (tournoisAutoCrees.length) {
        lignes.push(`🗄 Tournoi(s) créé(s) automatiquement (marqués historique, réglages par défaut à ajuster dans l'onglet Tournoi si besoin) : ${tournoisAutoCrees.join(", ")}.`);
      }
      if (nouveauxMotsDePasse.length) {
        lignes.push(`Nouvelles équipes créées avec mot de passe temporaire à communiquer au capitaine :`);
        lignes.push(...nouveauxMotsDePasse);
      }
      if (nomsIntrouvables.size) {
        lignes.push(`⚠️ Noms d'équipe introuvables dans le fichier matchs (vérifie l'orthographe vs le fichier équipes) : ${[...nomsIntrouvables].join(", ")}`);
      }
      if (nbGroupesRepares) {
        lignes.push(`🔧 ${nbGroupesRepares} match(s) déjà importé(s) précédemment avaient un groupe manquant — réparé(s).`);
      }
      resultEl.innerHTML = lignes.map((l) => `<div>${l}</div>`).join("");
    } catch (e) {
      console.error(e);
      resultEl.textContent = "Erreur pendant l'import : " + (e.message || e);
    } finally {
      importEnCours = false;
      btn.disabled = false;
      btn.textContent = "Importer dans le tournoi sélectionné";
    }
  });

  document.getElementById("btn-generate-finale").addEventListener("click", async () => {
    if (!currentTournament.nbQualifiesPhaseFinale) {
      return alert("Ce tournoi n'a pas de nombre de qualifiés défini (à la création).");
    }
    const groupesNoms = [...new Set(teams.map((t) => t.groupe).filter(Boolean))].sort();
    if (!groupesNoms.length) return alert("Génère et joue d'abord la phase de groupe.");

    const classementsParGroupe = groupesNoms.map((g) => ({
      groupe: g,
      classement: computeStandings(
        teams.filter((t) => t.groupe === g),
        matches.filter((m) => m.groupe === g),
        currentTournament.regleClassement
      ),
    }));

    if (currentTournament.nbQualifiesPhaseFinale > 16) {
      if (!confirm(`${currentTournament.nbQualifiesPhaseFinale} qualifié(e)s, c'est au-delà de ce qui a été testé (16 max prévu) — continuer quand même ?`)) return;
    }

    const criteres = currentTournament.regleClassement?.criteres || ["points", "diffButs", "butsMarques", "fairplayScore"];
    const qualifies = computeQualifiers(classementsParGroupe, currentTournament.nbQualifiesPhaseFinale, criteres);
    if (qualifies.length < currentTournament.nbQualifiesPhaseFinale) {
      if (!confirm(`Seulement ${qualifies.length} équipe(s) qualifiable(s) trouvée(s) (au lieu de ${currentTournament.nbQualifiesPhaseFinale}). Continuer quand même ?`)) return;
    }
    if (qualifies.length < 2) return alert("Pas assez d'équipes qualifiables pour générer une phase finale.");

    const bracket = generateKnockoutBracket(qualifies);
    const nbByes = bracket.filter((m) => m.bye).length;
    const withPlaceholders = bracket.map((m) => (m.bye ? m : { ...m, terrain: "À définir", date: null, heure: null }));
    await saveMatches(currentTournamentId, withPlaceholders);
    alert(
      `Phase finale générée : ${bracket.length - nbByes} match(s) à jouer` +
        (nbByes ? `, ${nbByes} équipe(s) qualifiée(s) d'office (bye) faute d'effectif rond.` : ".")
    );
  });

  document.getElementById("btn-generer-tour-suivant").addEventListener("click", async () => {
    const finale = matches.filter((m) => m.phase !== "poule");
    if (!finale.length) return alert("Génère d'abord la phase finale.");
    const tourMax = Math.max(...finale.map((m) => m.tourIndex ?? 0));
    const matchsDuTour = finale.filter((m) => (m.tourIndex ?? 0) === tourMax);
    const resultat = genererTourSuivant(matchsDuTour);
    if (resultat.pret === false) {
      return alert("Tous les matchs du tour affiché ne sont pas encore encodés (score décisif requis, pas de match nul sans tirs au but).");
    }
    if (resultat.champion) {
      return alert(`🏆 Championne/champion du tournoi : ${teamName(resultat.champion)} !`);
    }
    await saveMatches(currentTournamentId, resultat.matchs.map((m) => ({ ...m, terrain: "À définir", date: null, heure: null })));
    alert(`Tour suivant généré : ${resultat.matchs.length} match(s) (${resultat.matchs[0]?.phase}).`);
  });

  // ---- sélection multiple / suppression en masse (équipes inscrites, matchs, admins) ----
  setupBulkDelete({
    checkAllId: "check-all-teams",
    checkClass: "check-team",
    btnId: "btn-delete-teams-selection",
    confirmLabel: "équipe(s) à désinscrire de ce tournoi (l'équipe elle-même n'est pas supprimée)",
    onDelete: (ids) => Promise.all(ids.map((id) => desinscrireEquipe(currentTournamentId, id))),
  });

  setupBulkDelete({
    checkAllId: "check-all-matches",
    checkClass: "check-match",
    btnId: "btn-delete-matches-selection",
    confirmLabel: "match(s)",
    onDelete: (ids) => Promise.all(ids.map((id) => deleteMatch(currentTournamentId, id))),
  });

  setupBulkDelete({
    checkAllId: "check-all-admins",
    checkClass: "check-admin",
    btnId: "btn-delete-admins-selection",
    confirmLabel: "administrateur(s)",
    onDelete: (ids) => Promise.all(ids.map((id) => deleteAdmin(id))),
  });

  setupBulkDelete({
    checkAllId: "check-all-joueurs",
    checkClass: "check-joueur",
    btnId: "btn-delete-joueurs-selection",
    confirmLabel: "compte(s) joueur (aussi retiré(s) des équipes où ils étaient liés)",
    onDelete: (ids) => Promise.all(ids.map((id) => supprimerJoueur(id))),
  });

  document.getElementById("joueurs-recherche").addEventListener("input", () => renderJoueurs());

  document.getElementById("btn-reset-donnees").addEventListener("click", async () => {
    const zones = [];
    if (document.getElementById("reset-tournois").checked) zones.push("tous les tournois (inscriptions + matchs inclus)");
    if (document.getElementById("reset-equipes").checked) zones.push("toutes les équipes (et leurs effectifs)");
    if (document.getElementById("reset-terrains").checked) zones.push("tous les terrains");
    if (document.getElementById("reset-joueurs").checked) zones.push("tous les comptes joueurs");
    if (document.getElementById("reset-championnats").checked) zones.push("tous les championnats");
    if (!zones.length) return alert("Coche au moins une case.");
    if (!confirm(`Supprimer définitivement :\n\n${zones.join("\n")}\n\nCette action est irréversible. Continuer ?`)) return;
    if (!confirm("Vraiment sûr ? Il n'y a pas de retour en arrière possible.")) return;

    const statusEl = document.getElementById("reset-status");
    statusEl.textContent = "Suppression en cours...";
    try {
      if (document.getElementById("reset-tournois").checked) {
        for (const t of tournamentsList) await deleteTournament(t.id);
      }
      if (document.getElementById("reset-equipes").checked) {
        for (const e of equipesGlobal) await deleteEquipe(e.id);
      }
      if (document.getElementById("reset-terrains").checked) {
        for (const t of terrainsGlobal) await deleteTerrain(t.id);
      }
      if (document.getElementById("reset-joueurs").checked) {
        for (const j of joueursGlobal) await deletePlayer(j.id);
      }
      if (document.getElementById("reset-championnats").checked) {
        for (const c of championnatsList) await deleteChampionnat(c.id);
      }
      statusEl.textContent = "✓ Suppression terminée.";
      currentTournamentId = null;
      currentTournament = null;
      document.getElementById("tabs").hidden = true;
    } catch (err) {
      statusEl.textContent = "Erreur pendant la suppression : " + err.message;
    }
  });
}

// Câble une case "tout cocher" + un bouton "Supprimer la sélection" à un
// groupe de cases à cocher identifiées par leur classe CSS. Les cases sont
// recréées à chaque rendu (innerHTML), donc on lit .check-xxx au moment du
// clic plutôt que d'attacher un écouteur par case.
function setupBulkDelete({ checkAllId, checkClass, btnId, confirmLabel, onDelete }) {
  document.getElementById(checkAllId).addEventListener("change", (e) => {
    document.querySelectorAll(`.${checkClass}`).forEach((cb) => (cb.checked = e.target.checked));
  });

  document.getElementById(btnId).addEventListener("click", async () => {
    const ids = [...document.querySelectorAll(`.${checkClass}:checked`)].map((cb) => cb.value);
    if (!ids.length) return alert("Aucun élément coché.");
    if (!confirm(`Supprimer ${ids.length} ${confirmLabel} ?`)) return;
    await onDelete(ids);
  });
}

// Abonnements Firestore actifs pour le tournoi actuellement affiché — on
// les coupe avant de resouscrire, sinon changer de tournoi (ou rappeler
// selectTournament) empile les écouteurs et déclenche des rendus en double.
let unsubInscriptions = null;
let unsubMatches = null;

function selectTournament(id) {
  currentTournamentId = id;
  document.getElementById("select-tournament").value = id;
  const sondageSelect = document.getElementById("sondage-tournoi-select");
  if (sondageSelect) sondageSelect.value = id;
  document.getElementById("tabs").hidden = false;

  if (unsubInscriptions) unsubInscriptions();
  if (unsubMatches) unsubMatches();

  getTournament(id).then((t) => {
    currentTournament = t;
    recomputeVenues();
    renderTeams();
    renderTerrainsDisponibles();
    document.getElementById("nt-inscriptions-ouvertes").checked = t.inscriptionsOuvertes !== false;
    const lien = `${location.origin}${location.pathname.replace(/admin\.html$/, "")}index.html?tournoi=${id}`;
    const lienEl = document.getElementById("lien-public-tournoi");
    lienEl.href = lien;
    lienEl.textContent = lien;
    renderTournoiSettings();
  });

  unsubInscriptions = watchInscriptions(id, (list) => {
    inscriptions = list;
    recomputeTeams();
  });

  unsubMatches = watchMatches(id, (list) => {
    matches = list;
    renderMatches();
    renderFinaleMatches();
    renderApercuBracket();
  });
}

// Reconstruit la vue fusionnée "teams" (équipe globale + son inscription à
// CE tournoi) à chaque fois que les équipes globales OU les inscriptions
// changent — c'est cette vue que consomment le calendrier, le classement,
// la phase finale, etc., exactement comme avant.
function recomputeTeams() {
  teams = inscriptions
    .map((insc) => {
      const equipe = equipesGlobal.find((e) => e.id === insc.equipeId);
      if (!equipe) return null; // équipe supprimée globalement mais inscription orpheline
      return {
        ...equipe,
        id: equipe.id,
        groupe: insc.groupe,
        statut: insc.statut,
        statutPaiement: insc.statutPaiement,
        membresHistorique: insc.membresHistorique || [], // effectif importé spécifique à CE tournoi
      };
    })
    .filter((t) => t !== null);
  renderTeams();
  populateDispoViewSelect();
  renderTournoiSettings();
  if (!document.getElementById("tab-dispos").hidden && document.getElementById("dispo-scope-select").value === "equipes") {
    renderAdminDispoGrid();
  }
}

// Reconstruit "venues" = terrains globaux utilisés par ce tournoi
// (tournament.terrainIds), avec leurs créneaux déjà calculés côté terrain.
function recomputeVenues() {
  const ids = new Set(currentTournament?.terrainIds || []);
  venues = terrainsGlobal.filter((t) => ids.has(t.id));
  renderTournoiSettings();
  sondageTerrainIds.clear(); // le tournoi (donc les terrains alloués) a changé — filtre remis à zéro
  renderSondageTerrainsChecklist();
}

// ---------- Onglet "Tournoi" : réglages + vue d'ensemble ----------
function renderTournoiSettings() {
  if (!currentTournament) return;
  const t = currentTournament;
  document.getElementById("tn-nom").value = t.nom || "";
  document.getElementById("tn-datedebut").value = t.dateDebut || "";
  document.getElementById("tn-datefin").value = t.dateFin || "";
  document.getElementById("tn-taillegroupe").value = t.tailleGroupeVisee ?? "";
  document.getElementById("tn-nbmitemps").value = t.nbMiTemps ?? "";
  document.getElementById("tn-dureemitemps").value = t.dureeMiTemps ?? "";
  document.getElementById("tn-pause").value = t.duréePause ?? "";
  document.getElementById("tn-allerretour").checked = !!t.allerRetour;
  document.getElementById("tn-nbqualifies").value = t.nbQualifiesPhaseFinale ?? "";
  document.getElementById("tn-historique").checked = !!t.historique;

  const nbEquipesConfirmees = teams.filter((e) => e.statut === "confirmée").length;
  const nbTerrains = venues.length;
  document.getElementById("tn-resume").innerHTML = `
    ${t.historique ? `<span class="badge forfait">Historique</span> ` : ""}${teams.length} équipe(s) inscrite(s) (${nbEquipesConfirmees} confirmée(s)) — détail et actions dans l'onglet Équipes.<br/>
    ${nbTerrains} terrain(s) alloué(s) à ce tournoi — à gérer dans l'onglet Terrains.<br/>
    Inscriptions publiques : ${t.inscriptionsOuvertes !== false ? "ouvertes" : "fermées"} (case à cocher en haut de page).
  `;
  renderApercuVisuel();
}

// ---------- Aperçu visuel : poules en cartes + bracket phase finale ----------
function renderApercuVisuel() {
  renderApercuPoules();
  renderApercuBracket();
}

function renderApercuPoules() {
  const zone = document.getElementById("apercu-poules");
  if (!zone) return;
  if (!teams.length) {
    zone.innerHTML = `<p class="muted">Inscris des équipes à ce tournoi pour les voir apparaître ici.</p>`;
    return;
  }
  const groupes = new Map(); // nom de groupe (ou "Sans groupe") -> [équipes]
  teams.forEach((t) => {
    const cle = t.groupe || "Sans groupe";
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(t);
  });
  const groupesTries = [...groupes.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  zone.innerHTML = `<div class="apercu-poules-wrap">${groupesTries
    .map(
      ([nomGroupe, equipesDuGroupe]) => `
    <div class="apercu-groupe-bloc">
      <div class="apercu-groupe-label">Groupe ${nomGroupe}</div>
      <div class="apercu-equipes-col">
        ${equipesDuGroupe
          .map((e) => {
            const membres = [...(e.membres || []), ...(e.membresHistorique || [])];
            return `
          <div class="apercu-equipe-carte">
            <div class="apercu-equipe-entete">
              <span>${e.nom}</span>
              <span class="apercu-badge-statut apercu-badge-${e.statut || "en_attente"}">${e.statut || "en attente"}</span>
            </div>
            <div class="apercu-membres">
              ${
                membres.length
                  ? membres.map((m) => `<p>${m.nom}</p>`).join("")
                  : `<p class="muted">Aucun membre encodé</p>`
              }
            </div>
          </div>`;
          })
          .join("")}
      </div>
    </div>`
    )
    .join("")}</div>`;
}

function renderApercuBracket() {
  const zone = document.getElementById("apercu-bracket");
  if (!zone) return;
  const matchsFinale = matches.filter((m) => m.phase !== "poule");
  if (!matchsFinale.length) {
    zone.innerHTML = "";
    return;
  }
  const parTour = new Map(); // tourIndex -> [matchs]
  matchsFinale.forEach((m) => {
    const idx = m.tourIndex ?? 0;
    if (!parTour.has(idx)) parTour.set(idx, []);
    parTour.get(idx).push(m);
  });
  const toursTries = [...parTour.entries()].sort((a, b) => a[0] - b[0]);

  const dernierTour = toursTries[toursTries.length - 1][1];
  const derniereEstFinale = dernierTour.every((m) => m.phase === "finale");
  let championHtml = "";
  if (derniereEstFinale) {
    const finale = dernierTour[0];
    const joue = finale.bye || (finale.scoreA !== null && finale.scoreA !== undefined);
    if (joue) {
      const gagnantId = finale.bye
        ? finale.equipeAId
        : finale.scoreA > finale.scoreB
        ? finale.equipeAId
        : finale.equipeBId;
      championHtml = `<div class="apercu-tour-col"><div class="apercu-tour-titre">&nbsp;</div><div class="apercu-champion-carte">🏆 Champion<span>${teamName(
        gagnantId
      )}</span></div></div>`;
    }
  }

  zone.innerHTML = `<div class="apercu-bracket-wrap">${toursTries
    .map(
      ([, matchsDuTour]) => `
    <div class="apercu-tour-col">
      <div class="apercu-tour-titre">${matchsDuTour[0].phase}</div>
      ${matchsDuTour
        .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
        .map((m) => {
          if (m.bye) {
            return `<div class="apercu-match-carte"><div class="apercu-ligne apercu-gagnant"><span>${teamName(
              m.equipeAId
            )}</span><span class="apercu-score">bye</span></div></div>`;
          }
          const joue = m.scoreA !== null && m.scoreA !== undefined;
          const aGagne = joue && m.scoreA > m.scoreB;
          const bGagne = joue && m.scoreB > m.scoreA;
          return `<div class="apercu-match-carte">
            <div class="apercu-ligne ${aGagne ? "apercu-gagnant" : ""}"><span>${teamName(
            m.equipeAId
          )}</span><span class="apercu-score">${m.scoreA ?? "-"}</span></div>
            <div class="apercu-ligne ${bGagne ? "apercu-gagnant" : ""}"><span>${teamName(
            m.equipeBId
          )}</span><span class="apercu-score">${m.scoreB ?? "-"}</span></div>
          </div>`;
        })
        .join("")}
    </div>`
    )
    .join("")}${championHtml}</div>`;
}

function renderTeams() {
  if (currentTournament) {
    const nbGroupes = computeNbGroups(teams.length, currentTournament.tailleGroupeVisee);
    document.getElementById("groupes-preview").textContent = teams.length
      ? `Avec ${teams.length} équipe(s) inscrite(s) et une taille de groupe visée de ${currentTournament.tailleGroupeVisee}, le calendrier générera ${nbGroupes} groupe(s). Ce nombre se recalcule automatiquement à chaque inscription/désinscription d'équipe.`
      : "Inscris des équipes à ce tournoi pour voir combien de groupes seront générés.";
  }

  const tbody = document.getElementById("teams-table");
  tbody.innerHTML = teams
    .map(
      (t) => `
    <tr>
      <td><input type="checkbox" class="check-team" value="${t.id}" /></td>
      <td>${t.nom}</td>
      <td>${t.groupe || "-"}</td>
      <td>
        <select data-team="${t.id}" class="statut-select">
          <option value="en_attente" ${t.statut === "en_attente" ? "selected" : ""}>En attente</option>
          <option value="confirmée" ${t.statut === "confirmée" ? "selected" : ""}>Confirmée</option>
          <option value="forfait" ${t.statut === "forfait" ? "selected" : ""}>Forfait</option>
          <option value="désistée" ${t.statut === "désistée" ? "selected" : ""}>Désistée</option>
        </select>
      </td>
      <td>
        <select data-team-paiement="${t.id}" class="paiement-select">
          <option value="non_payé" ${t.statutPaiement === "non_payé" ? "selected" : ""}>Non payé</option>
          <option value="payé" ${t.statutPaiement === "payé" ? "selected" : ""}>Payé</option>
        </select>
      </td>
      <td><button class="secondaire" data-voir-composition="${t.id}">${(t.membres || []).length + (t.membresHistorique || []).length} joueur(s) — voir</button></td>
      <td>
        <button data-desinscrire="${t.id}" class="danger">Désinscrire</button>
        ${t.statut === "désistée" ? `<span class="badge forfait">Désistée</span>` : `<button data-desiste="${t.id}" class="danger">Se désiste (+ repêchage)</button>`}
      </td>
    </tr>`
    )
    .join("") || `<p class="muted">Aucune équipe inscrite à ce tournoi pour l'instant.</p>`;

  tbody.querySelectorAll(".statut-select").forEach((sel) =>
    sel.addEventListener("change", (e) =>
      updateInscription(currentTournamentId, e.target.dataset.team, { statut: e.target.value })
    )
  );
  tbody.querySelectorAll(".paiement-select").forEach((sel) =>
    sel.addEventListener("change", (e) =>
      updateInscription(currentTournamentId, e.target.dataset.teamPaiement, { statutPaiement: e.target.value })
    )
  );
  tbody.querySelectorAll("[data-desinscrire]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Désinscrire cette équipe de ce tournoi ? (l'équipe elle-même n'est pas supprimée)")) {
        desinscrireEquipe(currentTournamentId, btn.dataset.desinscrire);
      }
    })
  );
  tbody.querySelectorAll("[data-voir-composition]").forEach((btn) =>
    btn.addEventListener("click", () => toggleComposition(btn.dataset.voirComposition))
  );
  tbody.querySelectorAll("[data-desiste]").forEach((btn) =>
    btn.addEventListener("click", () => desisterEquipe(btn.dataset.desiste))
  );

  // Si une équipe était affichée en détail, on rafraîchit son contenu
  // (utile après un ajout/retrait de membre) plutôt que de la refermer.
  if (equipeCompositionOuverte) renderComposition(equipeCompositionOuverte);
}

// ---------- Désistement en cours de tournoi + repêchage ----------
// Objectif (demandé par Joas) : si une équipe abandonne en cours de route,
// le tournoi doit pouvoir continuer en "repêchant" un remplaçant plutôt que
// de simplement laisser un trou dans le calendrier. Règles retenues (à
// ajuster si ça ne correspond pas à ce qu'il a en tête) :
//  - l'équipe désistée garde son historique (matchs déjà joués = résultats
//    valables pour ses adversaires), elle est juste marquée "désistée" ;
//  - ses matchs de POULE pas encore joués sont réattribués (même
//    date/heure/terrain) à une équipe de remplacement choisie par l'admin
//    parmi les équipes du hub pas encore inscrites à ce tournoi (il n'y a
//    pas de classement pour les départager, donc pas de suggestion auto) ;
//  - ses matchs de PHASE FINALE pas encore joués sont réattribués à la
//    "meilleure équipe éliminée" du tournoi (calculée selon les mêmes
//    critères de classement que la qualification), proposée par défaut.
function meilleureEquipeElimineeSuggestion() {
  const groupesNoms = [...new Set(teams.map((t) => t.groupe).filter(Boolean))].sort();
  if (!groupesNoms.length || !currentTournament) return null;
  const criteres = currentTournament.regleClassement?.criteres || ["points", "diffButs", "butsMarques", "fairplayScore"];
  // Classement toutes poules confondues (juste pour repêcher un "meilleur perdant").
  const classementGlobal = groupesNoms
    .flatMap((g) => computeStandings(teams.filter((t) => t.groupe === g), matches.filter((m) => m.groupe === g), currentTournament.regleClassement))
    .sort((x, y) => {
      for (const c of criteres) {
        if (c === "confrontationDirecte") continue;
        if (y[c] !== x[c]) return y[c] - x[c];
      }
      return 0;
    });
  // Équipes encore "en vie" dans le tableau à élimination directe : celles
  // apparaissant dans le dernier tour généré sans avoir perdu.
  const finale = matches.filter((m) => m.phase !== "poule");
  const perdantes = new Set();
  for (const m of finale) {
    if (m.bye) continue;
    if (m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) continue;
    perdantes.add(m.scoreA > m.scoreB ? m.equipeBId : m.equipeAId);
  }
  const dejaEnLice = new Set(finale.map((m) => [m.equipeAId, m.equipeBId]).flat());
  const candidat = classementGlobal.find((s) => perdantes.has(s.equipeId) || (!dejaEnLice.has(s.equipeId) && !perdantes.has(s.equipeId)));
  return candidat || null;
}

async function desisterEquipe(equipeId) {
  const equipe = teams.find((t) => t.id === equipeId);
  if (!equipe) return;
  if (!confirm(`Marquer "${equipe.nom}" comme désistée de ce tournoi ? Ses résultats déjà joués sont conservés ; ses matchs à venir seront proposés à une équipe de remplacement.`)) return;

  await updateInscription(currentTournamentId, equipeId, { statut: "désistée" });

  const matchsNonJoues = matches.filter(
    (m) => !m.bye && (m.equipeAId === equipeId || m.equipeBId === equipeId) && (m.scoreA === null || m.scoreA === undefined)
  );
  if (!matchsNonJoues.length) {
    alert(`"${equipe.nom}" est marquée désistée. Aucun match à venir ne la concernait, rien d'autre à faire.`);
    return;
  }

  const matchsPoule = matchsNonJoues.filter((m) => m.groupe);
  const matchsFinale = matchsNonJoues.filter((m) => !m.groupe);

  // ---- Repêchage pour les matchs de poule ----
  if (matchsPoule.length) {
    const candidatsHub = equipesGlobal.filter((e) => !teams.some((t) => t.id === e.id) && e.id !== equipeId);
    const noms = candidatsHub.map((e) => e.nom).join(", ") || "(aucune équipe libre dans le hub — crée-en une d'abord dans l'onglet Équipes)";
    const saisie = prompt(
      `${matchsPoule.length} match(s) de poule de "${equipe.nom}" à réattribuer.\nÉquipes du hub pas encore inscrites à ce tournoi : ${noms}\n\nTape le nom exact de l'équipe de remplacement (ou laisse vide pour juste annuler ces matchs sans remplaçant) :`
    );
    if (saisie && saisie.trim()) {
      const cible = candidatsHub.find((e) => normaliseNom(e.nom) === normaliseNom(saisie.trim()));
      if (!cible) {
        alert("Nom non trouvé parmi les équipes du hub disponibles — les matchs de poule restent donc attribués à l'équipe désistée pour l'instant, tu pourras réessayer.");
      } else {
        if (!teams.some((t) => t.id === cible.id)) {
          await inscrireEquipe(currentTournamentId, cible.id);
          if (equipe.groupe) await updateInscription(currentTournamentId, cible.id, { groupe: equipe.groupe });
        }
        for (const m of matchsPoule) {
          await updateMatch(currentTournamentId, m.id, {
            equipeAId: m.equipeAId === equipeId ? cible.id : m.equipeAId,
            equipeBId: m.equipeBId === equipeId ? cible.id : m.equipeBId,
          });
        }
      }
    } else {
      for (const m of matchsPoule) await deleteMatch(currentTournamentId, m.id);
    }
  }

  // ---- Repêchage pour les matchs de phase finale ----
  if (matchsFinale.length) {
    const suggestion = meilleureEquipeElimineeSuggestion();
    const saisie = prompt(
      `${matchsFinale.length} match(s) de phase finale de "${equipe.nom}" à réattribuer.\nMeilleure équipe repêchable suggérée : ${suggestion ? suggestion.nom : "(aucune suggestion trouvée automatiquement)"}\n\nTape le nom exact de l'équipe qui la remplace (ou laisse vide pour annuler ces matchs — l'adversaire sera alors qualifié d'office) :`,
      suggestion ? suggestion.nom : ""
    );
    if (saisie && saisie.trim()) {
      const cible = teams.find((t) => normaliseNom(t.nom) === normaliseNom(saisie.trim())) || equipesGlobal.find((e) => normaliseNom(e.nom) === normaliseNom(saisie.trim()));
      if (!cible) {
        alert("Nom non trouvé — les matchs de phase finale restent donc attribués à l'équipe désistée pour l'instant, tu pourras réessayer.");
      } else {
        for (const m of matchsFinale) {
          await updateMatch(currentTournamentId, m.id, {
            equipeAId: m.equipeAId === equipeId ? cible.id : m.equipeAId,
            equipeBId: m.equipeBId === equipeId ? cible.id : m.equipeBId,
          });
        }
      }
    } else {
      // Pas de remplaçant : l'adversaire est qualifié d'office (bye a posteriori).
      for (const m of matchsFinale) {
        const adversaire = m.equipeAId === equipeId ? m.equipeBId : m.equipeAId;
        await updateMatch(currentTournamentId, m.id, { bye: true, statut: "acté", equipeAId: adversaire, equipeBId: null });
      }
    }
  }

  alert(`"${equipe.nom}" désistée — matchs à venir traités.`);
}

// ---------- Détail "composition d'équipe" (liste des joueurs) ----------
// Affiché sous le tableau des équipes inscrites — la seule vue jusqu'ici
// n'était qu'un nombre, pas de moyen de voir qui est dans l'équipe.
let equipeCompositionOuverte = null;

function toggleComposition(equipeId) {
  equipeCompositionOuverte = equipeCompositionOuverte === equipeId ? null : equipeId;
  renderComposition(equipeCompositionOuverte);
}

function renderComposition(equipeId) {
  const container = document.getElementById("equipe-composition-detail");
  if (!container) return;
  if (!equipeId) {
    container.innerHTML = "";
    return;
  }
  const equipe = equipesGlobal.find((e) => e.id === equipeId);
  if (!equipe) {
    container.innerHTML = "";
    return;
  }
  const membresCompte = equipe.membres || [];
  const equipeDansTournoi = teams.find((t) => t.id === equipeId);
  const membresHistorique = equipeDansTournoi?.membresHistorique || [];

  function tableauMembres(liste, { historique }) {
    if (!liste.length) return `<p class="muted">Aucun joueur ici pour l'instant.</p>`;
    return `<table>
      <thead><tr><th>Nom</th><th>Poste</th><th>N°</th><th>Pied fort</th><th>Type</th><th></th></tr></thead>
      <tbody>
        ${liste
          .map(
            (m, i) => `<tr>
          <td>${m.nom}</td><td>${m.poste || "-"}</td><td>${m.numero || "-"}</td><td>${m.piedFort || "-"}</td>
          <td><span class="badge ${m.type === "compte" ? "acte" : m.type === "non_revendique" ? "propose" : "forfait"}">${
              m.type === "compte" ? "Compte" : m.type === "non_revendique" ? "Non revendiqué" : "Libre"
            }</span></td>
          <td><button data-retirer-membre="${i}" data-historique="${historique}" class="danger">Retirer</button></td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
  }

  container.innerHTML = `
    <div class="card">
      <h2>Composition — ${equipe.nom}</h2>
      <p class="muted">Code d'invitation joueur : <strong>${equipe.codeEquipe || "-"}</strong> — préférence terrain : ${equipe.preferenceTerrain || "-"}</p>

      <h3 style="margin-top:16px;">Effectif de l'équipe (permanent, tous tournois confondus)</h3>
      <p class="aide">Joueurs qui ont rejoint via le code d'invitation — cet effectif suit l'équipe partout où elle s'inscrit.</p>
      ${tableauMembres(membresCompte, { historique: false })}

      <h3 style="margin-top:16px;">Effectif importé pour ce tournoi</h3>
      <p class="aide">Spécifique au tournoi actuellement sélectionné — ne se mélange pas avec ce que cette équipe a joué ailleurs.</p>
      ${tableauMembres(membresHistorique, { historique: true })}

      <button class="secondaire" id="btn-voir-palmares" style="margin-top:10px;">Voir le palmarès</button>
      <div id="palmares-zone" style="margin-top:10px;"></div>
      <button class="secondaire" id="btn-fermer-composition" style="margin-top:10px;">Fermer</button>
    </div>`;

  container.querySelectorAll("[data-retirer-membre]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Retirer ce joueur ?")) return;
      const index = Number(btn.dataset.retirerMembre);
      if (btn.dataset.historique === "true") {
        await removeInscriptionMembre(currentTournamentId, equipeId, index);
      } else {
        await removeEquipeMember(equipeId, index);
      }
    })
  );
  document.getElementById("btn-fermer-composition").addEventListener("click", () => toggleComposition(equipeId));
  document.getElementById("btn-voir-palmares").addEventListener("click", () => afficherPalmares(equipeId));
}

// Résumé par tournoi : pour chaque tournoi où l'équipe a une inscription,
// le stade atteint (poules, éliminé en demi, finaliste, champion...) —
// calculé à la demande (pas de cache), pour rester correct même après un
// nouveau résultat encodé ailleurs.
async function afficherPalmares(equipeId) {
  const zone = document.getElementById("palmares-zone");
  if (!zone) return;
  zone.innerHTML = `<p class="muted">Calcul en cours...</p>`;
  const inscriptionsEquipe = await getInscriptionsForEquipe(equipeId);
  if (!inscriptionsEquipe.length) {
    zone.innerHTML = `<p class="muted">Cette équipe n'est inscrite à aucun tournoi pour l'instant.</p>`;
    return;
  }
  const lignes = await Promise.all(
    inscriptionsEquipe.map(async (insc) => {
      const matchsDuTournoi = insc.tournamentId === currentTournamentId ? matches : await getMatches(insc.tournamentId);
      const { label } = stadeAtteintEquipe(equipeId, matchsDuTournoi);
      return `<p>🏆 <strong>${insc.tournamentNom}</strong> — ${label}</p>`;
    })
  );
  zone.innerHTML = lignes.join("");
}

// Liste des équipes globales PAS ENCORE inscrites à ce tournoi, avec un
// bouton pour les inscrire d'un clic (équipe créée pour un autre tournoi,
// ou par son capitaine directement).
function renderEquipesDisponibles() {
  const container = document.getElementById("equipes-disponibles-list");
  if (!container) return;
  const inscritesIds = new Set(inscriptions.map((i) => i.equipeId));
  const disponibles = equipesGlobal.filter((e) => !inscritesIds.has(e.id));

  container.innerHTML = disponibles.length
    ? disponibles
        .map(
          (e) => `
    <div class="creneau-row">
      <span>${e.nom} — ${(e.membres || []).length} joueur(s)</span>
      <button data-voir-composition="${e.id}" class="secondaire">Voir composition</button>
      <button data-inscrire="${e.id}" class="secondaire">+ Inscrire à ce tournoi</button>
      <button data-supprimer-equipe="${e.id}" class="danger">Supprimer définitivement</button>
    </div>`
        )
        .join("")
    : `<p class="muted">Toutes les équipes existantes sont déjà inscrites à ce tournoi (ou aucune équipe n'existe encore).</p>`;

  container.querySelectorAll("[data-inscrire]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!currentTournamentId) return alert("Sélectionne d'abord un tournoi.");
      try {
        await inscrireEquipe(currentTournamentId, btn.dataset.inscrire);
      } catch (e) {
        console.error(e);
        alert("Erreur lors de l'inscription : " + (e.message || e));
      }
    })
  );
  container.querySelectorAll("[data-supprimer-equipe]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer définitivement cette équipe (et toutes ses inscriptions) ? Cette action est irréversible.")) {
        deleteEquipe(btn.dataset.supprimerEquipe);
      }
    })
  );
  container.querySelectorAll("[data-voir-composition]").forEach((btn) =>
    btn.addEventListener("click", () => toggleComposition(btn.dataset.voirComposition))
  );
  if (equipeCompositionOuverte) renderComposition(equipeCompositionOuverte);
}

function teamName(id) {
  return teams.find((t) => t.id === id)?.nom || equipesGlobal.find((e) => e.id === id)?.nom || "?";
}

function renderMatches() {
  const tbody = document.getElementById("matches-table");
  tbody.innerHTML = matches
    .filter((m) => m.phase === "poule")
    .map(
      (m) => `
    <tr>
      <td><input type="checkbox" class="check-match" value="${m.id}" /></td>
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

// Compte actuel de cartons déjà enregistrés pour un match (dérivé de
// m.evenements) — sert à pré-remplir les champs plutôt que de repartir de 0
// à chaque ouverture du formulaire.
function comptesCartons(m) {
  const c = { jaunesA: 0, rougesA: 0, jaunesB: 0, rougesB: 0 };
  for (const ev of m.evenements || []) {
    const cote = ev.equipe === m.equipeAId ? "A" : ev.equipe === m.equipeBId ? "B" : null;
    if (!cote) continue;
    if (ev.type === "carton_jaune") c[`jaunes${cote}`]++;
    else if (ev.type === "carton_rouge") c[`rouges${cote}`]++;
  }
  return c;
}

function renderResultsForm() {
  const container = document.getElementById("matches-to-encode");
  // Les matchs "bye" (qualification directe, effectif de phase finale
  // impair) n'ont rien à encoder — déjà actés à la génération du tableau.
  container.innerHTML = matches
    .filter((m) => !m.bye)
    .map((m) => {
      const c = comptesCartons(m);
      return `
    <div class="card" style="margin-bottom:10px;">
      <strong>${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}</strong>
      <span class="muted"> — ${m.phase === "poule" ? m.groupe : m.phase} — ${m.date || ""} ${m.heure || ""} — ${m.terrain || ""}${m.arbitreId ? ` — arbitre : ${joueursGlobal.find((j) => j.id === m.arbitreId)?.nom || "?"}` : ""}</span>
      <div class="grille-form" style="margin-top:8px;">
        <input type="number" min="0" placeholder="Score ${teamName(m.equipeAId)}" data-score-a="${m.id}" value="${m.scoreA ?? ""}" />
        <input type="number" min="0" placeholder="Score ${teamName(m.equipeBId)}" data-score-b="${m.id}" value="${m.scoreB ?? ""}" />
        <select data-statut-match="${m.id}">
          <option value="joué" ${m.statutMatch === "joué" ? "selected" : ""}>Joué</option>
          <option value="interrompu" ${m.statutMatch === "interrompu" ? "selected" : ""}>Interrompu</option>
          <option value="forfait" ${m.statutMatch === "forfait" ? "selected" : ""}>Forfait</option>
          <option value="reporté" ${m.statutMatch === "reporté" ? "selected" : ""}>Reporté</option>
        </select>
      </div>
      <p class="muted" style="margin:6px 0 2px;">Cartons (pour le fair-play du classement) :</p>
      <div class="grille-form">
        <input type="number" min="0" placeholder="🟨 ${teamName(m.equipeAId)}" data-jaunes-a="${m.id}" value="${c.jaunesA}" />
        <input type="number" min="0" placeholder="🟥 ${teamName(m.equipeAId)}" data-rouges-a="${m.id}" value="${c.rougesA}" />
        <input type="number" min="0" placeholder="🟨 ${teamName(m.equipeBId)}" data-jaunes-b="${m.id}" value="${c.jaunesB}" />
        <input type="number" min="0" placeholder="🟥 ${teamName(m.equipeBId)}" data-rouges-b="${m.id}" value="${c.rougesB}" />
      </div>
      <button data-save-result="${m.id}" style="margin-top:8px;">Enregistrer</button>
    </div>`;
    })
    .join("");

  container.querySelectorAll("[data-save-result]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.saveResult;
      const m = matches.find((mm) => mm.id === id);
      const scoreA = Number(container.querySelector(`[data-score-a="${id}"]`).value);
      const scoreB = Number(container.querySelector(`[data-score-b="${id}"]`).value);
      const statutMatch = container.querySelector(`[data-statut-match="${id}"]`).value;
      const jaunesA = Number(container.querySelector(`[data-jaunes-a="${id}"]`).value) || 0;
      const rougesA = Number(container.querySelector(`[data-rouges-a="${id}"]`).value) || 0;
      const jaunesB = Number(container.querySelector(`[data-jaunes-b="${id}"]`).value) || 0;
      const rougesB = Number(container.querySelector(`[data-rouges-b="${id}"]`).value) || 0;
      // On ne garde que le décompte (pas de joueur/minute précis) : suffisant
      // pour le critère fair-play du classement, sans construire tout un
      // module arbitre pour l'instant.
      const evenements = [
        ...Array(jaunesA).fill({ type: "carton_jaune", equipe: m.equipeAId }),
        ...Array(rougesA).fill({ type: "carton_rouge", equipe: m.equipeAId }),
        ...Array(jaunesB).fill({ type: "carton_jaune", equipe: m.equipeBId }),
        ...Array(rougesB).fill({ type: "carton_rouge", equipe: m.equipeBId }),
      ];
      await setMatchResult(currentTournamentId, id, { scoreA, scoreB, statutMatch, evenements });
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
          <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>BM</th><th>BE</th><th>Diff</th><th>🟨/🟥</th><th>Pts</th></tr></thead>
          <tbody>
            ${classement
              .map(
                (s, i) => `<tr>
                <td>${i + 1}</td><td>${s.nom}</td><td>${s.joues}</td><td>${s.victoires}</td>
                <td>${s.nuls}</td><td>${s.defaites}</td><td>${s.butsMarques}</td>
                <td>${s.butsEncaisses}</td><td>${s.diffButs}</td>
                <td class="muted">${s.cartonsJaunes}/${s.cartonsRouges}</td>
                <td><strong>${s.points}</strong></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
    })
    .join("");
}

// ---- Terrains : liste globale + toggle "utilisé dans ce tournoi" ----
function renderTerrainsDisponibles() {
  const container = document.getElementById("venues-list");
  if (!container) return;
  const idsUtilises = new Set(currentTournament?.terrainIds || []);

  container.innerHTML = terrainsGlobal.length
    ? terrainsGlobal
        .map((t) => {
          const nbCreneaux = (t.creneaux || []).length;
          const resume = nbCreneaux
            ? (t.creneaux || []).map((c) => `${c.date} ${c.heureDebut}-${c.heureFin}`).join(" · ")
            : "Aucune disponibilité peinte pour l'instant (onglet Disponibilités → Terrains).";
          return `
    <div class="card">
      <h2>${t.nom} <button data-del-terrain="${t.id}" class="danger" style="float:right;">Supprimer définitivement</button></h2>
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" class="check-terrain-utilise" data-terrain="${t.id}" style="width:auto;" ${idsUtilises.has(t.id) ? "checked" : ""} ${currentTournamentId ? "" : "disabled"} />
        Utilisé pour ce tournoi
      </label>
      <p class="muted">${resume}</p>
    </div>`;
        })
        .join("")
    : `<p class="muted">Aucun terrain créé pour l'instant.</p>`;

  container.querySelectorAll("[data-del-terrain]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer définitivement ce terrain (et toutes ses dispos) ? Cette action est irréversible.")) {
        deleteTerrain(btn.dataset.delTerrain);
      }
    })
  );

  container.querySelectorAll(".check-terrain-utilise").forEach((cb) =>
    cb.addEventListener("change", async (e) => {
      if (!currentTournamentId || !currentTournament) return;
      const id = e.target.dataset.terrain;
      const ids = new Set(currentTournament.terrainIds || []);
      if (e.target.checked) ids.add(id);
      else ids.delete(id);
      await updateTournament(currentTournamentId, { terrainIds: [...ids] });
      currentTournament = await getTournament(currentTournamentId);
      recomputeVenues();
    })
  );
}

function populateTerrainDispoSelect() {
  const select = document.getElementById("ter-dispo-select");
  if (!select) return;
  const valeurActuelle = selectedVenueId;
  select.innerHTML = terrainsGlobal.length
    ? terrainsGlobal.map((v) => `<option value="${v.id}">${v.nom}</option>`).join("")
    : `<option value="">Crée d'abord un terrain</option>`;

  if (terrainsGlobal.some((v) => v.id === valeurActuelle)) {
    select.value = valeurActuelle;
  } else {
    selectedVenueId = terrainsGlobal.length ? terrainsGlobal[0].id : null;
    select.value = selectedVenueId || "";
  }
  loadSelectedVenueMarks();
  renderTerrainDispoGrid();
}

function loadSelectedVenueMarks() {
  const venue = terrainsGlobal.find((v) => v.id === selectedVenueId);
  if (!isPaintingTerrain) terrainDispoMarks = { ...(venue?.dispos || {}) };
}

function renderTerrainDispoGrid() {
  const gridEl = document.getElementById("terrain-dispo-grid");
  if (!gridEl) return;
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = Grid.gridTemplateColumns(terrainDispoDates.length);
  gridEl.style.gridTemplateRows = Grid.gridTemplateRows(terrainDispoTimes.length);
  Grid.renderGridHeaders(gridEl, terrainDispoDates);
  Grid.renderHourRows(gridEl, terrainDispoDates, terrainDispoTimes, (cell, { dateISO, timeLabel }) => {
    const key = Grid.slotKey(dateISO, timeLabel);
    const mark = terrainDispoMarks[key];
    if (mark === "available") cell.classList.add("mark-available");
    if (mark === "unavailable") cell.classList.add("mark-unavailable");
    cell.dataset.key = key;
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (!selectedVenueId) return;
      const k = cell.dataset.key;
      paintActionTerrain = terrainDispoMarks[k] === terrainDispoMode ? "clear" : "set";
      isPaintingTerrain = true;
      applyPaintTerrain(cell);
    });
    cell.addEventListener("mouseenter", () => {
      if (isPaintingTerrain) applyPaintTerrain(cell);
    });
  });
}

function applyPaintTerrain(cell) {
  const key = cell.dataset.key;
  cell.classList.remove("mark-available", "mark-unavailable");
  if (paintActionTerrain === "clear") {
    delete terrainDispoMarks[key];
  } else {
    terrainDispoMarks[key] = terrainDispoMode;
    cell.classList.add(terrainDispoMode === "available" ? "mark-available" : "mark-unavailable");
  }
}

async function persistTerrainDispoMarks() {
  if (!selectedVenueId) return;
  const statusEl = document.getElementById("ter-dispo-save-status");
  statusEl.textContent = "Enregistrement...";
  statusEl.className = "saving";
  try {
    await setTerrainAvailability(selectedVenueId, terrainDispoMarks);
    statusEl.textContent = "Enregistré ✓";
    statusEl.className = "saved";
  } catch (e) {
    statusEl.textContent = "Erreur d'enregistrement";
    console.error(e);
  }
}

// ---------- Championnats (classement cumulé sur plusieurs tournois) ----------
function renderChampTournoisChecklist() {
  const container = document.getElementById("champ-tournois-checklist");
  if (!container) return;
  container.innerHTML = tournamentsList.length
    ? tournamentsList
        .map(
          (t) => `<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <input type="checkbox" value="${t.id}" style="width:auto;" /> ${t.nom}${t.dateDebut ? ` — ${formaterDateFr(t.dateDebut)}` : ""}
      </label>`
        )
        .join("")
    : "Aucun tournoi créé pour l'instant.";
}

// Classement cumulé : concatène les matchs joués de tous les tournois du
// championnat (poule uniquement, ou poule + phase finale selon le réglage),
// puis réutilise computeStandings — les ids d'équipe sont globaux (hub),
// donc ça s'additionne directement sans traduction.
async function computeStandingsChampionnat(champ) {
  const tousLesMatchs = [];
  for (const tId of champ.tournamentIds || []) {
    const m = await getMatches(tId);
    const filtres = champ.inclurePhaseFinale ? m : m.filter((mm) => mm.groupe);
    tousLesMatchs.push(...filtres.filter((mm) => !mm.bye));
  }
  const regleClassement = {
    pointsVictoire: 3,
    pointsNul: 1,
    pointsDefaite: 0,
    criteres: ["points", "diffButs", "butsMarques", "fairplayScore"],
  };
  const idsEquipes = new Set(tousLesMatchs.flatMap((m) => [m.equipeAId, m.equipeBId]));
  const equipesConcernees = equipesGlobal.filter((e) => idsEquipes.has(e.id));
  return computeStandings(equipesConcernees, tousLesMatchs, regleClassement);
}

async function afficherClassementChampionnat(champId) {
  const champ = championnatsList.find((c) => c.id === champId);
  const zone = document.getElementById(`champ-classement-${champId}`);
  if (!champ || !zone) return;
  zone.innerHTML = `<p class="muted">Calcul en cours...</p>`;
  const classement = await computeStandingsChampionnat(champ);
  if (!classement.length) {
    zone.innerHTML = `<p class="muted">Aucun match joué pour l'instant dans les tournois de ce championnat.</p>`;
    return;
  }
  zone.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>BM</th><th>BE</th><th>Diff</th><th>🟨/🟥</th><th>Pts</th></tr></thead>
      <tbody>
        ${classement
          .map(
            (s, i) => `<tr>
            <td>${i + 1}</td><td>${s.nom}</td><td>${s.joues}</td><td>${s.victoires}</td>
            <td>${s.nuls}</td><td>${s.defaites}</td><td>${s.butsMarques}</td>
            <td>${s.butsEncaisses}</td><td>${s.diffButs}</td>
            <td class="muted">${s.cartonsJaunes}/${s.cartonsRouges}</td>
            <td><strong>${s.points}</strong></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderChampionnats() {
  const container = document.getElementById("championnats-liste");
  if (!container) return;
  if (!championnatsList.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = championnatsList
    .map((c) => {
      const nomsInclus = (c.tournamentIds || [])
        .map((id) => tournamentsList.find((t) => t.id === id)?.nom || "(tournoi supprimé)")
        .join(", ");
      return `
      <div class="card">
        <h2>${c.nom} <button data-supprimer-champ="${c.id}" class="danger" style="float:right;">Supprimer</button></h2>
        <p class="muted">Tournois inclus : ${nomsInclus || "aucun"} — ${c.inclurePhaseFinale ? "poules + phase finale" : "poules uniquement"}</p>
        <button data-voir-champ="${c.id}" class="secondaire">Voir le classement</button>
        <div id="champ-classement-${c.id}" style="margin-top:10px;"></div>
      </div>`;
    })
    .join("");

  container.querySelectorAll("[data-voir-champ]").forEach((btn) =>
    btn.addEventListener("click", () => afficherClassementChampionnat(btn.dataset.voirChamp))
  );
  container.querySelectorAll("[data-supprimer-champ]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer ce championnat ? (les tournois qui le composent ne sont pas touchés)")) {
        deleteChampionnat(btn.dataset.supprimerChamp);
      }
    })
  );
}

function renderFinaleMatches() {
  const tbody = document.getElementById("finale-table");
  if (!tbody) return;
  const finale = [...matches.filter((m) => m.phase !== "poule")].sort(
    (a, b) => (a.tourIndex ?? 0) - (b.tourIndex ?? 0) || (a.slot ?? 0) - (b.slot ?? 0)
  );
  tbody.innerHTML = finale
    .map((m) =>
      m.bye
        ? `<tr>
      <td>${m.phase}</td>
      <td>${teamName(m.equipeAId)} — qualifié(e) d'office (bye)</td>
      <td>—</td>
    </tr>`
        : `<tr>
      <td>${m.phase}</td>
      <td>${teamName(m.equipeAId)} vs ${teamName(m.equipeBId)}</td>
      <td>${m.scoreA ?? "-"} : ${m.scoreB ?? "-"}</td>
    </tr>`
    )
    .join("");
}

function populateDispoViewSelect() {
  const select = document.getElementById("dispo-view-select");
  if (!select) return;
  const valeurActuelle = select.value;
  select.innerHTML =
    `<option value="combinee">Combinée (toutes les équipes inscrites)</option>` +
    teams.map((t) => `<option value="${t.id}">Équipe : ${t.nom}</option>`).join("");
  if ([...select.options].some((o) => o.value === valeurActuelle)) select.value = valeurActuelle;
}

const adminDispoDates = Grid.buildDateList(new Date(), 21);
const adminDispoTimes = Grid.buildTimeSlots();

function renderAdminDispoGrid() {
  const container = document.getElementById("admin-dispo-grid");
  if (!container) return;
  const mode = document.getElementById("dispo-view-select").value;

  container.innerHTML = "";
  container.style.gridTemplateColumns = Grid.gridTemplateColumns(adminDispoDates.length);
  container.style.gridTemplateRows = Grid.gridTemplateRows(adminDispoTimes.length);
  Grid.renderGridHeaders(container, adminDispoDates);

  function creneauUtilisablePourTerrains(key) {
    if (!sondageTerrainIds.size) return true; // pas de filtre = tout utilisable
    return [...sondageTerrainIds].every((id) => venues.find((v) => v.id === id)?.dispos?.[key] === "available");
  }

  function wireSondageClick(cell, key) {
    if (sondageSelection.has(key)) cell.classList.add("sondage-selected");
    if (modeSondage && !creneauUtilisablePourTerrains(key)) {
      cell.classList.add("sondage-terrain-indispo");
      cell.title = "Terrain(s) sélectionné(s) pas libre(s) à ce créneau — non sondable.";
    }
    cell.addEventListener("click", () => {
      if (!modeSondage) return;
      if (!creneauUtilisablePourTerrains(key)) return; // filtre terrain : créneau non sondable
      if (sondageSelection.has(key)) {
        sondageSelection.delete(key);
        cell.classList.remove("sondage-selected");
      } else {
        sondageSelection.add(key);
        cell.classList.add("sondage-selected");
      }
      document.getElementById("sondage-selection-count").textContent = sondageSelection.size
        ? `${sondageSelection.size} créneau(x) sélectionné(s)`
        : "";
    });
  }

  if (mode === "combinee") {
    const totalEquipes = teams.length || 1;
    Grid.renderHourRows(container, adminDispoDates, adminDispoTimes, (cell, { dateISO, timeLabel }) => {
      const key = Grid.slotKey(dateISO, timeLabel);
      let dispo = 0;
      let pasDispo = 0;
      for (const t of teams) {
        const mark = (t.dispos || {})[key];
        if (mark === "available") dispo++;
        if (mark === "unavailable") pasDispo++;
      }
      if (dispo > 0) {
        const intensite = Math.min(1, dispo / totalEquipes);
        cell.style.background = `rgba(47, 184, 92, ${0.15 + intensite * 0.65})`;
      }
      if (pasDispo > 0) {
        cell.style.boxShadow = "inset 0 -3px 0 var(--rouge)";
      }
      if (dispo || pasDispo) {
        cell.title = `${dispo} équipe(s) dispo, ${pasDispo} pas dispo`;
      }
      wireSondageClick(cell, key);
    });
  } else {
    const team = teams.find((t) => t.id === mode);
    Grid.renderHourRows(container, adminDispoDates, adminDispoTimes, (cell, { dateISO, timeLabel }) => {
      const key = Grid.slotKey(dateISO, timeLabel);
      const mark = team?.dispos?.[key];
      if (mark === "available") cell.classList.add("mark-available");
      if (mark === "unavailable") cell.classList.add("mark-unavailable");
      wireSondageClick(cell, key);
    });
  }
}

function updateSondageStatus() {
  const el = document.getElementById("sondage-tournoi-status");
  if (!el) return;
  const nb = (currentTournament?.sondages || []).length;
  el.textContent = nb
    ? `${nb} créneau(x) actuellement sondé(s) pour ce tournoi (en attente de réponse chez au moins une équipe).`
    : "Aucun créneau sondé en cours pour ce tournoi.";
}

function renderAdmins(admins) {
  const tbody = document.getElementById("admins-table");
  tbody.innerHTML = admins
    .map(
      (a) => `
    <tr>
      <td><input type="checkbox" class="check-admin" value="${a.id}" /></td>
      <td>${a.nom}</td>
      <td><button data-del-admin="${a.id}" class="danger">Retirer</button></td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-del-admin]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Retirer cet administrateur ?")) deleteAdmin(btn.dataset.delAdmin);
    })
  );
}

// ---------- Comptes joueurs (globaux, hub entier) ----------
function equipesLieesAuJoueur(joueurId) {
  return equipesGlobal.filter((e) => (e.membres || []).some((m) => m.type === "compte" && m.joueurId === joueurId));
}

function renderJoueurs() {
  const tbody = document.getElementById("joueurs-table");
  if (!tbody) return;
  const recherche = normaliseNom(document.getElementById("joueurs-recherche")?.value || "");
  const liste = recherche ? joueursGlobal.filter((j) => normaliseNom(j.nom).includes(recherche)) : joueursGlobal;

  tbody.innerHTML =
    liste
      .map((j) => {
        const equipesLiees = equipesLieesAuJoueur(j.id);
        return `
    <tr>
      <td><input type="checkbox" class="check-joueur" value="${j.id}" /></td>
      <td><input data-renommer-joueur="${j.id}" value="${j.nom}" style="width:100%;" /></td>
      <td>${equipesLiees.length ? equipesLiees.map((e) => e.nom).join(", ") : `<span class="muted">aucune</span>`}</td>
      <td>
        ${
          j.revendique === false
            ? `<span class="badge propose">Non revendiqué</span>`
            : `<span class="badge acte">Revendiqué</span> <button data-derevendiquer="${j.id}" class="secondaire">Dé-revendiquer</button>`
        }
      </td>
      <td>
        ${
          !j.disponiblePourArbitrer
            ? `<span class="muted">non intéressé(e)</span>`
            : j.arbitreValide
            ? `<span class="badge acte">Validé</span> <button data-revoquer-arbitre="${j.id}" class="secondaire">Révoquer</button>`
            : `<span class="badge propose">En attente</span> <button data-valider-arbitre="${j.id}">Valider</button>`
        }
      </td>
      <td>
        <button data-reset-password-joueur="${j.id}" class="secondaire">Réinitialiser mot de passe</button>
        <button data-supprimer-joueur="${j.id}" class="danger">Supprimer</button>
      </td>
    </tr>`;
      })
      .join("") || `<p class="muted">${recherche ? "Aucun joueur ne correspond à cette recherche." : "Aucun compte joueur créé pour l'instant."}</p>`;

  tbody.querySelectorAll("[data-renommer-joueur]").forEach((input) =>
    input.addEventListener("change", (e) => updatePlayer(e.target.dataset.renommerJoueur, { nom: e.target.value.trim() }))
  );
  tbody.querySelectorAll("[data-reset-password-joueur]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const nouveau = prompt("Nouveau mot de passe pour ce joueur (à lui communiquer toi-même) :");
      if (nouveau && nouveau.trim()) {
        await updatePlayer(btn.dataset.resetPasswordJoueur, { password: nouveau.trim() });
        alert("Mot de passe mis à jour.");
      }
    })
  );
  tbody.querySelectorAll("[data-supprimer-joueur]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer ce compte joueur ? Il sera aussi retiré des équipes où il était lié (redevient un joueur \"libre\" pour elles, ou disparaît de la liste — l'équipe elle-même n'est pas touchée).")) {
        supprimerJoueur(btn.dataset.supprimerJoueur);
      }
    })
  );
  tbody.querySelectorAll("[data-derevendiquer]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Dé-revendiquer ce compte ? Il redevient réclamable par n'importe qui via \"Revendiquer un profil\" (son mot de passe actuel cesse de fonctionner).")) {
        updatePlayer(btn.dataset.derevendiquer, { password: null, revendique: false });
      }
    })
  );
  tbody.querySelectorAll("[data-valider-arbitre]").forEach((btn) =>
    btn.addEventListener("click", () => updatePlayer(btn.dataset.validerArbitre, { arbitreValide: true }))
  );
  tbody.querySelectorAll("[data-revoquer-arbitre]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Révoquer le statut d'arbitre validé de ce joueur ?")) {
        updatePlayer(btn.dataset.revoquerArbitre, { arbitreValide: false });
      }
    })
  );
}

// Supprime le compte joueur ET nettoie les références qui pointent vers lui
// dans les équipes (sinon on garde un joueurId fantôme dans membres[]).
async function supprimerJoueur(joueurId) {
  const equipesLiees = equipesLieesAuJoueur(joueurId);
  for (const e of equipesLiees) {
    const index = (e.membres || []).findIndex((m) => m.type === "compte" && m.joueurId === joueurId);
    if (index !== -1) await removeEquipeMember(e.id, index);
  }
  await deletePlayer(joueurId);
}

// ===================== IMPORT CSV (tournoi déjà joué) =====================
// Format attendu, 3 fichiers séparés (voir README pour un exemple) :
//   equipes.csv : nom,groupe
//   membres.csv : equipe,nom
//   matchs.csv  : groupe,equipeA,equipeB,date,heureDebut,heureFin,terrain(optionnel)

function formaterDateFr(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function normaliseNom(nom) {
  return (nom || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // enlève les accents (é, à...)
    .trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------- Détection de noms proches (équipes ou joueurs) ----------
// Sert à repérer par exemple "ANAS", "Anas K" et "Anas Kada" comme probable
// même personne écrite différemment selon les fichiers importés — pas de
// fusion automatique, juste un signalement pour corriger à la main.

function distanceLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1]
        ? d[i - 1][j - 1]
        : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}

// Deux noms sont "proches" si l'un est le préfixe de l'autre (ex: "anas"
// dans "anas kada") ou si peu de caractères les séparent (fautes de frappe).
function nomsProches(a, b) {
  const na = normaliseNom(a);
  const nb = normaliseNom(b);
  if (!na || !nb || na === nb) return na === nb && na !== "";
  if (na.length >= 3 && nb.length >= 3 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  const seuil = Math.min(na.length, nb.length) <= 4 ? 1 : 2;
  return distanceLevenshtein(na, nb) <= seuil;
}

// ---- Palmarès global (participation/victoires par joueur, tout le hub) ----
// Pour chaque inscription (équipe ↔ tournoi) du hub entier, on regarde le
// stade atteint par cette équipe dans CE tournoi (stadeAtteintEquipe) et on
// crédite chaque joueur qui en faisait partie — que ce soit via l'effectif
// "compte" vivant de l'équipe (rejoint via code) ou via l'effectif importé
// spécifique à ce tournoi (membresHistorique). Un joueur qui a joué dans
// plusieurs équipes/tournois cumule ses stats sur toutes ses participations.
async function calculerPalmaresGlobal() {
  const inscriptions = await getToutesInscriptions();
  const equipeParId = new Map(equipesGlobal.map((e) => [e.id, e]));
  const joueurParId = new Map(joueursGlobal.map((j) => [j.id, j]));

  const matchsParTournoi = new Map(); // tournamentId -> matchs (cache, un seul fetch par tournoi)
  async function matchsDe(tournamentId) {
    if (!matchsParTournoi.has(tournamentId)) matchsParTournoi.set(tournamentId, await getMatches(tournamentId));
    return matchsParTournoi.get(tournamentId);
  }

  const statsParJoueur = new Map(); // joueurId -> { nom, joues, gagnes, finales }
  function credite(joueurId, nom, champ) {
    if (!joueurId) return;
    if (!statsParJoueur.has(joueurId)) {
      statsParJoueur.set(joueurId, { joueurId, nom, joues: 0, gagnes: 0, finales: 0 });
    }
    statsParJoueur.get(joueurId)[champ]++;
  }

  for (const insc of inscriptions) {
    const equipe = equipeParId.get(insc.equipeId);
    const membresHistorique = insc.membresHistorique || [];
    const membresCompte = equipe ? (equipe.membres || []).filter((m) => m.type === "compte") : [];

    // Union des joueurId de cette équipe pour CE tournoi (historique + compte
    // vivant), dédupliqués — un même joueur ne doit être crédité qu'une fois
    // par tournoi même s'il apparaît des deux côtés.
    const joueurIds = new Set();
    membresHistorique.forEach((m) => m.joueurId && joueurIds.add(m.joueurId));
    membresCompte.forEach((m) => m.joueurId && joueurIds.add(m.joueurId));
    if (!joueurIds.size) continue;

    const matchsDuTournoi = await matchsDe(insc.tournamentId);
    const { stade } = stadeAtteintEquipe(insc.equipeId, matchsDuTournoi);

    for (const joueurId of joueurIds) {
      const nom = joueurParId.get(joueurId)?.nom
        || membresHistorique.find((m) => m.joueurId === joueurId)?.nom
        || membresCompte.find((m) => m.joueurId === joueurId)?.nom
        || "?";
      credite(joueurId, nom, "joues");
      if (stade === "champion") credite(joueurId, nom, "gagnes");
      if (stade === "champion" || stade === "finaliste") credite(joueurId, nom, "finales");
    }
  }

  return [...statsParJoueur.values()].sort((a, b) => b.gagnes - a.gagnes || b.joues - a.joues || a.nom.localeCompare(b.nom));
}

function afficherPalmaresGlobal(stats) {
  const container = document.getElementById("palmares-result");
  if (!stats.length) {
    container.innerHTML = `<p class="muted">Aucune participation trouvée pour l'instant.</p>`;
    return;
  }
  container.innerHTML = `<table>
    <thead><tr><th>#</th><th>Joueur</th><th>Tournois joués</th><th>Tournois gagnés</th><th>Finales atteintes</th></tr></thead>
    <tbody>
      ${stats
        .map(
          (s, i) => `<tr>
            <td>${i + 1}</td>
            <td>${s.nom}${s.gagnes > 0 ? " 🏆" : ""}</td>
            <td>${s.joues}</td>
            <td>${s.gagnes}</td>
            <td>${s.finales}</td>
          </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}

// ---- Détection de noms proches (équipes + joueurs, sur tout le hub) ----
// Trois familles de résultats : équipes (affichage seul), joueurs par
// équipe/tournoi (affichage seul, sert juste à repérer où ça se trouve), et
// comptes joueurs réels (collection "joueurs") avec un vrai bouton
// "Fusionner" puisque ce sont les seuls id qu'on peut réellement fusionner.
async function lancerVerificationDoublons() {
  const container = document.getElementById("doublons-result");
  container.innerHTML = `<p class="muted">Recherche en cours...</p>`;

  const entreesEquipes = equipesGlobal.map((e) => ({ nom: e.nom, source: "équipe" }));
  const clustersEquipes = regrouperNomsProches(entreesEquipes);

  const entreesJoueurs = [];
  equipesGlobal.forEach((e) => (e.membres || []).forEach((m) => entreesJoueurs.push({ nom: m.nom, source: e.nom })));
  const inscriptionsParTournoi = await Promise.all(tournamentsList.map((t) => getInscriptions(t.id)));
  inscriptionsParTournoi.forEach((liste, i) => {
    const nomTournoi = tournamentsList[i].nom;
    liste.forEach((insc) => {
      const equipeId = insc.equipeId || insc.id;
      const nomEquipe = equipesGlobal.find((e) => e.id === equipeId)?.nom || "?";
      (insc.membresHistorique || []).forEach((m) =>
        entreesJoueurs.push({ nom: m.nom, source: `${nomEquipe} — ${nomTournoi}` })
      );
    });
  });
  const clustersJoueurs = regrouperNomsProches(entreesJoueurs);

  // Comptes joueurs réels (collection "joueurs") — c'est là qu'on peut
  // proposer une vraie fusion, avec id, puisque tout membresHistorique/membre
  // "compte" pointe vers un de ces documents.
  const entreesComptes = joueursGlobal.map((j) => ({
    nom: j.nom,
    id: j.id,
    source: j.revendique ? "revendiqué" : "non revendiqué",
  }));
  const clustersComptes = regrouperNomsProches(entreesComptes);

  if (!clustersEquipes.length && !clustersJoueurs.length && !clustersComptes.length) {
    container.innerHTML = `<p class="muted">Aucun nom proche détecté parmi les ${equipesGlobal.length} équipe(s) et les ${joueursGlobal.length} compte(s) joueur.</p>`;
    return;
  }

  let html = "";
  if (clustersComptes.length) {
    html += `<p class="champ-label">Comptes joueurs à fusionner (doublons probables)</p>`;
    html += clustersComptes
      .map((c) => {
        const [base, ...autres] = c.items;
        return `<p class="creneau-row">
          <strong>${base.nom}</strong> <span class="muted">(${base.source})</span>
          ${autres
            .map(
              (i) =>
                `&nbsp;~&nbsp; <strong>${i.nom}</strong> <span class="muted">(${i.source})</span>
                 <button type="button" class="secondaire btn-fusionner-joueur" data-id-a="${base.id}" data-id-b="${i.id}" style="margin-left:6px;">Fusionner avec "${base.nom}"</button>`
            )
            .join("")}
        </p>`;
      })
      .join("");
    html += `<p class="muted" style="margin-bottom:14px;">La fusion garde le compte déjà revendiqué s'il y en a un (mot de passe conservé), déplace tout l'historique du doublon vers le survivant, et le garde en alias. Si les deux comptes sont déjà revendiqués, la fusion est refusée.</p>`;
  }
  if (clustersEquipes.length) {
    html += `<p class="champ-label">Équipes aux noms proches</p>` + clustersEquipes
      .map((c) => `<p class="creneau-row">${c.items.map((i) => `<strong>${i.nom}</strong>`).join(" &nbsp;~&nbsp; ")}</p>`)
      .join("");
  }
  if (clustersJoueurs.length) {
    html += `<p class="champ-label" style="margin-top:14px;">Joueurs aux noms proches (entre toutes les équipes du hub)</p>` + clustersJoueurs
      .map(
        (c) =>
          `<p class="creneau-row">${c.items
            .map((i) => `<strong>${i.nom}</strong> <span class="muted">(${i.source})</span>`)
            .join(" &nbsp;~&nbsp; ")}</p>`
      )
      .join("");
  }
  html += `<p class="muted" style="margin-top:10px;">Pour les équipes et les effectifs par tournoi, rien n'est fusionné automatiquement — vérifie chaque groupe et corrige à la main via "Voir composition".</p>`;
  container.innerHTML = html;

  container.querySelectorAll(".btn-fusionner-joueur").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idA = btn.dataset.idA;
      const idB = btn.dataset.idB;
      if (!confirm("Fusionner ces deux profils joueur ? Cette action est irréversible.")) return;
      btn.disabled = true;
      btn.textContent = "Fusion...";
      try {
        await fusionnerJoueurs(idA, idB);
        await lancerVerificationDoublons();
      } catch (e) {
        alert("Erreur lors de la fusion : " + (e.message || e));
        btn.disabled = false;
        btn.textContent = `Fusionner avec "${btn.closest("p").querySelector("strong").textContent}"`;
      }
    });
  });
}

// Regroupe une liste d'{ nom, source } en clusters de noms mutuellement
// proches (union-find simplifié : chaque nouvel élément rejoint le premier
// cluster existant avec lequel il matche, sinon en crée un nouveau).
function regrouperNomsProches(entrees) {
  const clusters = []; // [{ noms: Set(normalisé), items: [{nom, source}] }]
  for (const entree of entrees) {
    if (!entree.nom || !entree.nom.trim()) continue;
    const cluster = clusters.find((c) => [...c.noms].some((n) => nomsProches(n, entree.nom)));
    if (cluster) {
      cluster.noms.add(normaliseNom(entree.nom));
      cluster.items.push(entree);
    } else {
      clusters.push({ noms: new Set([normaliseNom(entree.nom)]), items: [entree] });
    }
  }
  // Ne garde que les clusters où au moins deux ORTHOGRAPHES différentes
  // apparaissent (sinon c'est juste la même équipe/le même joueur répété
  // normalement, pas un doublon à corriger).
  return clusters.filter((c) => c.noms.size > 1);
}

// Lit un champ d'une ligne CSV en tolérant les variations de casse/accents
// dans l'en-tête (parseCsv met déjà tout en minuscules, mais "équipeA" côté
// utilisateur peut avoir été tapé avec accent ou espace) — évite que tout un
// import échoue silencieusement à cause d'un en-tête mal deviné.
function champCsv(row, ...noms) {
  for (const n of noms) {
    const cle = n.toLowerCase();
    if (row[cle] !== undefined && row[cle] !== "") return row[cle];
  }
  return "";
}

function genererMotDePasseTemp() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // sans 0/o/1/i/l pour éviter la confusion
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[Math.floor(Math.random() * alphabet.length)];
  return mdp;
}

// Parseur CSV minimal : gère les guillemets (champs contenant une virgule),
// suffisant pour des exports Excel/Google Sheets standards — pas besoin
// d'une librairie externe pour un usage aussi simple.
function parseCsv(text) {
  const lignes = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (!lignes.length) return [];

  function parseLigne(ligne) {
    const champs = [];
    let champActuel = "";
    let dansGuillemets = false;
    for (let i = 0; i < ligne.length; i++) {
      const c = ligne[i];
      if (dansGuillemets) {
        if (c === '"' && ligne[i + 1] === '"') {
          champActuel += '"';
          i++;
        } else if (c === '"') {
          dansGuillemets = false;
        } else {
          champActuel += c;
        }
      } else if (c === '"') {
        dansGuillemets = true;
      } else if (c === ",") {
        champs.push(champActuel);
        champActuel = "";
      } else {
        champActuel += c;
      }
    }
    champs.push(champActuel);
    return champs.map((c) => c.trim());
  }

  const entetes = parseLigne(lignes[0]).map((e) => e.toLowerCase());
  return lignes.slice(1).map((ligne) => {
    const valeurs = parseLigne(ligne);
    const obj = {};
    entetes.forEach((entete, i) => (obj[entete] = valeurs[i] ?? ""));
    return obj;
  });
}

function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(parseCsv(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "UTF-8");
  });
}
