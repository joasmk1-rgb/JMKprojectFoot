import { ADMIN_PASSPHRASE } from "./config.js";
import {
  createTournament, watchTournaments, getTournament, updateTournament,
  createEquipe, watchEquipes, updateEquipe, deleteEquipe, setEquipeAvailability, addEquipeMember,
  inscrireEquipe, watchInscriptions, updateInscription, desinscrireEquipe,
  createTerrain, watchTerrains, deleteTerrain, setTerrainAvailability,
  saveMatches, clearMatches, watchMatches, setMatchResult, actMatch, deleteMatch,
  getAdmins, watchAdmins, createAdmin, deleteAdmin,
} from "./db.js";
import {
  computeNbGroups, splitIntoGroups, scheduleMatches, computeStandings,
  computeQualifiers, generateKnockoutBracket,
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

let initDone = false;

function init() {
  // ⚠️ init() peut être appelée plusieurs fois (si l'utilisateur clique
  // plusieurs fois sur "Se connecter", ou re-tente une connexion) — sans
  // cette garde, tous les écouteurs de clic étaient réattachés à chaque
  // fois, ce qui multipliait les équipes/terrains créés à un seul clic.
  if (initDone) return;
  initDone = true;

  watchAdmins(renderAdmins);

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
    const btn = document.getElementById("btn-create-tournament");
    const nom = document.getElementById("nt-nom").value.trim();
    if (!nom) return alert("Le nom du tournoi est obligatoire.");
    btn.disabled = true;
    btn.textContent = "Création...";
    try {
      const nbQualifiesRaw = document.getElementById("nt-nbqualifies").value;
      const id = await createTournament({
        nom,
        tailleGroupeVisee: Number(document.getElementById("nt-taillegroupe").value),
        nbMiTemps: Number(document.getElementById("nt-nbmitemps").value),
        dureeMiTemps: Number(document.getElementById("nt-dureemitemps").value),
        duréePause: Number(document.getElementById("nt-pause").value),
        allerRetour: document.getElementById("nt-allerretour").checked,
        nbQualifiesPhaseFinale: nbQualifiesRaw ? Number(nbQualifiesRaw) : null,
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
    if (!currentTournamentId) return alert("Sélectionne ou crée d'abord un tournoi.");

    const fileEquipes = document.getElementById("imp-file-equipes").files[0];
    const fileMembres = document.getElementById("imp-file-membres").files[0];
    const fileMatchs = document.getElementById("imp-file-matchs").files[0];
    if (!fileEquipes && !fileMembres && !fileMatchs) {
      return alert("Choisis au moins un fichier CSV à importer (équipes, membres et/ou matchs).");
    }

    const btn = document.getElementById("btn-import-tournoi");
    const resultEl = document.getElementById("import-result");
    importEnCours = true;
    btn.disabled = true;
    btn.textContent = "Import en cours...";
    resultEl.textContent = "";

    try {
      const [rowsEquipes, rowsMembres, rowsMatchs] = await Promise.all([
        fileEquipes ? readCsvFile(fileEquipes) : Promise.resolve([]),
        fileMembres ? readCsvFile(fileMembres) : Promise.resolve([]),
        fileMatchs ? readCsvFile(fileMatchs) : Promise.resolve([]),
      ]);

      // 1. Équipes : réutilise une équipe existante du hub si le nom
      // correspond déjà (insensible à la casse), sinon la crée avec un mot
      // de passe capitaine temporaire à communiquer manuellement — puis
      // l'inscrit à ce tournoi avec son groupe.
      const nomVersId = new Map(equipesGlobal.map((e) => [normaliseNom(e.nom), e.id]));
      const nouveauxMotsDePasse = [];
      for (const row of rowsEquipes) {
        const nom = (row.nom || "").trim();
        if (!nom) continue;
        const cle = normaliseNom(nom);
        let equipeId = nomVersId.get(cle);
        if (!equipeId) {
          const motDePasse = genererMotDePasseTemp();
          equipeId = await createEquipe({ nom, capitainePassword: motDePasse });
          nomVersId.set(cle, equipeId);
          nouveauxMotsDePasse.push(`${nom} → ${motDePasse}`);
        }
        const dejaInscrite = teams.some((t) => t.id === equipeId);
        if (!dejaInscrite) await inscrireEquipe(currentTournamentId, equipeId);
        if (row.groupe && row.groupe.trim()) {
          await updateInscription(currentTournamentId, equipeId, { groupe: row.groupe.trim() });
        }
      }

      // 2. Membres : ajoutés en "libre" (sans compte), en évitant les
      // doublons si le même import est relancé deux fois.
      let nbMembresAjoutes = 0;
      const equipesFraiches = rowsMembres.length ? await Promise.all(
        [...new Set(rowsMembres.map((r) => normaliseNom(r.equipe || "")))]
          .filter((cle) => nomVersId.has(cle))
          .map((cle) => nomVersId.get(cle))
      ) : [];
      for (const row of rowsMembres) {
        const cleEquipe = normaliseNom(row.equipe || "");
        const nomMembre = (row.nom || "").trim();
        if (!nomMembre || !nomVersId.has(cleEquipe)) continue;
        const equipeId = nomVersId.get(cleEquipe);
        const equipeFraiche = equipesGlobal.find((e) => e.id === equipeId);
        const dejaMembre = (equipeFraiche?.membres || []).some(
          (m) => normaliseNom(m.nom) === normaliseNom(nomMembre)
        );
        if (dejaMembre) continue;
        await addEquipeMember(equipeId, { type: "libre", nom: nomMembre });
        nbMembresAjoutes++;
      }

      // 3. Matchs : créés directement avec les horaires du fichier (pas de
      // recalcul via le générateur auto). Le terrain vient de la colonne
      // "terrain" du CSV si présente, sinon du champ texte de secours.
      const terrainParDefaut = document.getElementById("imp-terrain-defaut").value.trim();
      const nomsIntrouvables = new Set();
      const matchsAImporter = [];
      for (const row of rowsMatchs) {
        const idA = nomVersId.get(normaliseNom(row.equipeA || ""));
        const idB = nomVersId.get(normaliseNom(row.equipeB || ""));
        if (!idA) nomsIntrouvables.add(row.equipeA);
        if (!idB) nomsIntrouvables.add(row.equipeB);
        if (!idA || !idB) continue;
        matchsAImporter.push({
          equipeAId: idA,
          equipeBId: idB,
          groupe: (row.groupe || "").trim() || null,
          phase: "poule",
          terrain: (row.terrain || "").trim() || terrainParDefaut || "À préciser",
          date: (row.date || "").trim() || null,
          heure: (row.heureDebut || row.heure || "").trim() || null,
        });
      }
      if (matchsAImporter.length) await saveMatches(currentTournamentId, matchsAImporter);

      const lignes = [
        `${rowsEquipes.length} équipe(s) traitée(s) dans le fichier équipes.`,
        `${nbMembresAjoutes} membre(s) ajouté(s).`,
        `${matchsAImporter.length} match(s) importé(s)${rowsMatchs.length > matchsAImporter.length ? ` (${rowsMatchs.length - matchsAImporter.length} ignoré(s), équipe introuvable)` : ""}.`,
      ];
      if (nouveauxMotsDePasse.length) {
        lignes.push(`Nouvelles équipes créées avec mot de passe temporaire à communiquer au capitaine :`);
        lignes.push(...nouveauxMotsDePasse);
      }
      if (nomsIntrouvables.size) {
        lignes.push(`⚠️ Noms d'équipe introuvables dans le fichier matchs (vérifie l'orthographe vs le fichier équipes) : ${[...nomsIntrouvables].join(", ")}`);
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

    const qualifies = computeQualifiers(classementsParGroupe, currentTournament.nbQualifiesPhaseFinale);
    if (qualifies.length < currentTournament.nbQualifiesPhaseFinale) {
      if (!confirm(`Seulement ${qualifies.length} équipe(s) qualifiable(s) trouvée(s) (au lieu de ${currentTournament.nbQualifiesPhaseFinale}). Continuer quand même ?`)) return;
    }

    const bracket = generateKnockoutBracket(qualifies.map((q) => ({ equipeId: q.equipeId, groupe: q.groupe })));
    const withPlaceholders = bracket.map((m) => ({ ...m, terrain: "À définir", date: null, heure: null }));
    await saveMatches(currentTournamentId, withPlaceholders);
    alert(`Phase finale générée : ${bracket.length} match(s).`);
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
  document.getElementById("tabs").hidden = false;

  if (unsubInscriptions) unsubInscriptions();
  if (unsubMatches) unsubMatches();

  getTournament(id).then((t) => {
    currentTournament = t;
    recomputeVenues();
    renderTeams();
    renderTerrainsDisponibles();
  });

  unsubInscriptions = watchInscriptions(id, (list) => {
    inscriptions = list;
    recomputeTeams();
  });

  unsubMatches = watchMatches(id, (list) => {
    matches = list;
    renderMatches();
    renderFinaleMatches();
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
      };
    })
    .filter((t) => t !== null);
  renderTeams();
  populateDispoViewSelect();
  if (!document.getElementById("tab-dispos").hidden && document.getElementById("dispo-scope-select").value === "equipes") {
    renderAdminDispoGrid();
  }
}

// Reconstruit "venues" = terrains globaux utilisés par ce tournoi
// (tournament.terrainIds), avec leurs créneaux déjà calculés côté terrain.
function recomputeVenues() {
  const ids = new Set(currentTournament?.terrainIds || []);
  venues = terrainsGlobal.filter((t) => ids.has(t.id));
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
        </select>
      </td>
      <td>
        <select data-team-paiement="${t.id}" class="paiement-select">
          <option value="non_payé" ${t.statutPaiement === "non_payé" ? "selected" : ""}>Non payé</option>
          <option value="payé" ${t.statutPaiement === "payé" ? "selected" : ""}>Payé</option>
        </select>
      </td>
      <td>${(t.membres || []).length} joueur(s)</td>
      <td><button data-desinscrire="${t.id}" class="danger">Désinscrire</button></td>
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
      <span>${e.nom}</span>
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

function renderFinaleMatches() {
  const tbody = document.getElementById("finale-table");
  if (!tbody) return;
  const finale = matches.filter((m) => m.phase !== "poule");
  tbody.innerHTML = finale
    .map(
      (m) => `<tr>
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

  function wireSondageClick(cell, key) {
    if (sondageSelection.has(key)) cell.classList.add("sondage-selected");
    cell.addEventListener("click", () => {
      if (!modeSondage) return;
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

// ===================== IMPORT CSV (tournoi déjà joué) =====================
// Format attendu, 3 fichiers séparés (voir README pour un exemple) :
//   equipes.csv : nom,groupe
//   membres.csv : equipe,nom
//   matchs.csv  : groupe,equipeA,equipeB,date,heureDebut,heureFin,terrain(optionnel)

function normaliseNom(nom) {
  return (nom || "").trim().toLowerCase().replace(/\s+/g, " ");
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
