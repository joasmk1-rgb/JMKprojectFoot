import { ADMIN_PASSPHRASE } from "./config.js";
import {
  createTournament, watchTournaments, getTournament, updateTournament,
  createTeam, watchTeams, updateTeam, deleteTeam, addTeamMember, removeTeamMember,
  saveMatches, clearMatches, watchMatches, setMatchResult, actMatch,
  getAdmins, watchAdmins, createAdmin, deleteAdmin, findAdminByPassword,
  createVenue, watchVenues, deleteVenue, addVenueSlot, removeVenueSlot,
} from "./db.js";
import {
  computeNbGroups, splitIntoGroups, scheduleMatches, computeStandings,
  computeQualifiers, generateKnockoutBracket,
} from "./schedule.js";

// ---------- AUTH (bootstrap verrouillable, comme agenda-conseil) ----------
const loginScreen = document.getElementById("login-screen");
const app = document.getElementById("app");
let currentAdmin = null; // { id, nom } une fois connecté

document.getElementById("btn-login").addEventListener("click", async () => {
  const pass = document.getElementById("admin-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  // 1. essaie d'abord de matcher un admin déjà créé
  const admin = await findAdminByPassword(pass);
  if (admin) {
    currentAdmin = admin;
    loginScreen.hidden = true;
    app.hidden = false;
    init();
    return;
  }

  // 2. sinon, la passphrase de démarrage ne marche QUE s'il n'existe
  // encore aucun admin (bootstrap). Dès qu'un admin existe, elle est morte.
  const admins = await getAdmins();
  if (admins.length === 0 && pass === ADMIN_PASSPHRASE) {
    currentAdmin = null; // pas encore un vrai admin, juste le bootstrap
    loginScreen.hidden = true;
    app.hidden = false;
    init();
    return;
  }

  errorEl.textContent = "Mot de passe incorrect.";
});

// ---------- ETAT ----------
let currentTournamentId = null;
let currentTournament = null;
let teams = [];
let matches = [];
let venues = [];

let initDone = false;

function init() {
  // ⚠️ init() peut être appelée plusieurs fois (si l'utilisateur clique
  // plusieurs fois sur "Se connecter", ou re-tente une connexion) — sans
  // cette garde, tous les écouteurs de clic étaient réattachés à chaque
  // fois, ce qui multipliait les équipes/terrains créés à un seul clic.
  if (initDone) return;
  initDone = true;

  watchAdmins(renderAdmins);

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
    const nbQualifiesRaw = document.getElementById("nt-nbqualifies").value;
    const id = await createTournament({
      nom: document.getElementById("nt-nom").value,
      tailleGroupeVisee: Number(document.getElementById("nt-taillegroupe").value),
      nbMiTemps: Number(document.getElementById("nt-nbmitemps").value),
      dureeMiTemps: Number(document.getElementById("nt-dureemitemps").value),
      duréePause: Number(document.getElementById("nt-pause").value),
      allerRetour: document.getElementById("nt-allerretour").checked,
      nbQualifiesPhaseFinale: nbQualifiesRaw ? Number(nbQualifiesRaw) : null,
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

  document.getElementById("btn-add-admin").addEventListener("click", async () => {
    const nom = document.getElementById("ad-nom").value.trim();
    const password = document.getElementById("ad-password").value.trim();
    if (!nom || !password) return alert("Nom et mot de passe obligatoires.");
    await createAdmin(nom, password);
    document.getElementById("ad-nom").value = "";
    document.getElementById("ad-password").value = "";
    alert("Administrateur ajouté. S'il s'agit du premier, le mot de passe de démarrage ne fonctionne plus.");
  });

  document.getElementById("btn-add-team").addEventListener("click", async () => {
    const nom = document.getElementById("eq-nom").value.trim();
    const password = document.getElementById("eq-password").value.trim();
    if (!nom || !password) return alert("Nom et mot de passe capitaine obligatoires.");
    await createTeam(currentTournamentId, { nom, capitainePassword: password });
    document.getElementById("eq-nom").value = "";
    document.getElementById("eq-password").value = "";
  });

  document.getElementById("btn-add-venue").addEventListener("click", async () => {
    const nom = document.getElementById("ter-nom").value.trim();
    if (!nom) return alert("Nom du terrain obligatoire.");
    await createVenue(currentTournamentId, nom);
    document.getElementById("ter-nom").value = "";
  });

  document.getElementById("btn-generate-schedule").addEventListener("click", async () => {
    if (!teams.length) return alert("Ajoute d'abord des équipes.");
    if (!venues.length || venues.every((v) => !v.creneaux?.length)) {
      return alert("Déclare d'abord au moins un créneau de disponibilité dans l'onglet Terrains.");
    }
    const groupes = splitIntoGroups(teams, currentTournament.tailleGroupeVisee);
    for (const g of groupes) {
      for (const eq of g.equipes) {
        if (eq.groupe !== g.nom) await updateTeam(currentTournamentId, eq.id, { groupe: g.nom });
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
      `${generated.length} matchs générés en ${groupes.length} groupes.` +
        (nonPlaces ? `\n⚠️ ${nonPlaces} match(s) n'ont pas pu être placés faute de créneaux disponibles.` : "")
    );
  });

  document.getElementById("btn-clear-schedule").addEventListener("click", async () => {
    if (confirm("Effacer tous les matchs générés ?")) await clearMatches(currentTournamentId);
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
}

// Abonnements Firestore actifs pour le tournoi actuellement affiché — on
// les coupe avant de resouscrire, sinon changer de tournoi (ou rappeler
// selectTournament) empile les écouteurs et déclenche des rendus en double.
let unsubTeams = null;
let unsubMatches = null;
let unsubVenues = null;

function selectTournament(id) {
  currentTournamentId = id;
  document.getElementById("select-tournament").value = id;
  document.getElementById("tabs").hidden = false;

  if (unsubTeams) unsubTeams();
  if (unsubMatches) unsubMatches();
  if (unsubVenues) unsubVenues();

  getTournament(id).then((t) => {
    currentTournament = t;
    renderTeams();
  });

  unsubTeams = watchTeams(id, (list) => {
    teams = list;
    renderTeams();
  });

  unsubMatches = watchMatches(id, (list) => {
    matches = list;
    renderMatches();
    renderFinaleMatches();
  });

  unsubVenues = watchVenues(id, (list) => {
    venues = list;
    renderVenues();
  });
}

function renderTeams() {
  if (currentTournament) {
    const nbGroupes = computeNbGroups(teams.length, currentTournament.tailleGroupeVisee);
    document.getElementById("groupes-preview").textContent = teams.length
      ? `Avec ${teams.length} équipe(s) et une taille de groupe visée de ${currentTournament.tailleGroupeVisee}, le calendrier générera ${nbGroupes} groupe(s). Ce nombre se recalcule automatiquement à chaque ajout/retrait d'équipe.`
      : "Ajoute des équipes pour voir combien de groupes seront générés.";
  }

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
    .filter((m) => m.phase === "poule")
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

function renderVenues() {
  const container = document.getElementById("venues-container");
  container.innerHTML = venues
    .map(
      (v) => `
    <div class="card">
      <h2>${v.nom} <button data-del-venue="${v.id}" class="danger" style="float:right;">Supprimer le terrain</button></h2>
      <div class="grille-form">
        <input type="date" data-slot-date="${v.id}" />
        <input type="time" data-slot-debut="${v.id}" value="09:00" />
        <input type="time" data-slot-fin="${v.id}" value="13:00" />
        <button data-add-slot="${v.id}">+ Ajouter ce créneau</button>
      </div>
      <table>
        <thead><tr><th>Date</th><th>De</th><th>À</th><th></th></tr></thead>
        <tbody>
          ${(v.creneaux || [])
            .map(
              (c, i) => `<tr>
              <td>${c.date}</td><td>${c.heureDebut}</td><td>${c.heureFin}</td>
              <td><button data-del-slot="${v.id}:${i}" class="danger">Retirer</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
    )
    .join("") || `<p class="muted">Aucun terrain déclaré pour l'instant.</p>`;

  container.querySelectorAll("[data-del-venue]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Supprimer ce terrain et toutes ses dispos ?")) deleteVenue(currentTournamentId, btn.dataset.delVenue);
    })
  );

  container.querySelectorAll("[data-add-slot]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const venueId = btn.dataset.addSlot;
      const date = container.querySelector(`[data-slot-date="${venueId}"]`).value;
      const heureDebut = container.querySelector(`[data-slot-debut="${venueId}"]`).value;
      const heureFin = container.querySelector(`[data-slot-fin="${venueId}"]`).value;
      if (!date || !heureDebut || !heureFin) return alert("Renseigne date, heure de début et heure de fin.");
      await addVenueSlot(currentTournamentId, venueId, { date, heureDebut, heureFin });
    })
  );

  container.querySelectorAll("[data-del-slot]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const [venueId, index] = btn.dataset.delSlot.split(":");
      removeVenueSlot(currentTournamentId, venueId, Number(index));
    })
  );
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

function renderAdmins(admins) {
  const tbody = document.getElementById("admins-table");
  tbody.innerHTML = admins
    .map(
      (a) => `
    <tr>
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
