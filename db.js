// ===================== DB.JS =====================
// Tous les échanges avec Firestore passent par ce fichier.
// Aucun autre fichier ne doit importer directement le SDK Firebase.
//
// ARCHITECTURE (v2) : équipes, terrains et joueurs sont des entités
// GLOBALES, indépendantes de tout tournoi précis — une équipe existe une
// fois, gérée par son capitaine, et s'INSCRIT ensuite à un ou plusieurs
// tournois. Un terrain existe une fois (son calendrier de dispo est réel,
// pas propre à un tournoi) et un tournoi choisit quels terrains il utilise.
// Ce qui est propre à UN tournoi (groupe de poule, statut, paiement d'une
// équipe dans CE tournoi) vit dans une "inscription"
// (tournaments/{id}/inscriptions/{equipeId}), pas sur l'équipe elle-même.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  collectionGroup,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { marksToCreneaux } from "./grid.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Code court (6 caractères) que le capitaine partage à ses joueurs pour
// qu'ils rejoignent l'équipe depuis leur propre compte joueur (hub).
function genererCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I pour éviter la confusion
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// ---------- ADMINISTRATEURS ----------
// Même principe que agenda-conseil : tant qu'aucun admin n'existe, la
// passphrase de config.js sert de clé de démarrage. Dès qu'un premier
// admin est créé, elle cesse de fonctionner (voir tenterLogin côté admin.js).

export async function getAdmins() {
  const snap = await getDocs(collection(db, "admins"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function watchAdmins(callback) {
  return onSnapshot(collection(db, "admins"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function createAdmin(nom, password) {
  const ref = await addDoc(collection(db, "admins"), {
    nom,
    password,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function deleteAdmin(adminId) {
  await deleteDoc(doc(db, "admins", adminId));
}

// ---------- JOUEURS (comptes individuels du hub) ----------
// Compte joueur indépendant de toute équipe ou tournoi, avec son mot de
// passe personnel et sa propre dispo. Il rejoint une ou plusieurs équipes
// via leur code (voir plus bas).

export async function createPlayer(nom, password) {
  const ref = await addDoc(collection(db, "joueurs"), {
    nom,
    password,
    revendique: true, // un compte créé de zéro par son propriétaire est déjà "à lui"
    dispos: {}, // { "date|heure": "available"|"unavailable" }
    blocages: [], // créneaux bloqués récurrents : { jour: 0-6, heureDebut, heureFin, motif }
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// ---------- Comptes pré-créés à l'import (à revendiquer) ----------
// Chaque membre importé par CSV obtient directement un vrai compte joueur
// dans le hub, sans mot de passe — "revendique: false". N'importe qui peut
// ensuite le retrouver par son nom et le revendiquer en lui donnant un mot
// de passe ; une fois revendiqué, il devient un compte normal et personne
// d'autre ne peut plus le reprendre.
export async function createPlayerNonRevendique(nom) {
  const ref = await addDoc(collection(db, "joueurs"), {
    nom,
    password: null,
    revendique: false,
    dispos: {},
    blocages: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function chercherProfilsNonRevendiques(recherche) {
  const cible = normaliseNomSimple(recherche);
  if (!cible) return [];
  const snap = await getDocs(query(collection(db, "joueurs"), where("revendique", "==", false)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((j) => normaliseNomSimple(j.nom).includes(cible));
}

// Retourne true si la revendication a réussi, false si le profil a déjà
// été revendiqué entre-temps (course entre deux personnes) ou n'existe plus.
export async function revendiquerProfil(joueurId, password) {
  const ref = doc(db, "joueurs", joueurId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().revendique) return false;
  await updateDoc(ref, { password, revendique: true });
  return true;
}

export async function findPlayerByPassword(password) {
  const snap = await getDocs(collection(db, "joueurs"));
  const match = snap.docs.find((d) => d.data().password === password);
  return match ? { id: match.id, ...match.data() } : null;
}

export async function getPlayer(playerId) {
  const snap = await getDoc(doc(db, "joueurs", playerId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function setPlayerAvailability(playerId, marks) {
  await updateDoc(doc(db, "joueurs", playerId), { dispos: marks });
}

export function watchPlayers(callback) {
  return onSnapshot(collection(db, "joueurs"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function updatePlayer(playerId, patch) {
  await updateDoc(doc(db, "joueurs", playerId), patch);
}

export async function deletePlayer(playerId) {
  await deleteDoc(doc(db, "joueurs", playerId));
}

// ---------- ARBITRAGE (extension du compte joueur, pas un compte à part) ----------
// Un joueur coche "je suis dispo pour arbitrer" (disponiblePourArbitrer),
// l'admin valide (arbitreValide) avant qu'il n'ait accès à quoi que ce soit
// — évite qu'un compte fraîchement créé s'attribue des matchs sans contrôle.
// Une fois validé, il voit tous les matchs planifiés (date connue) sans
// arbitre assigné, toutes équipes/tournois confondus (collectionGroup), et
// peut s'y assigner lui-même.

export async function getMatchsArbitrablesDisponibles() {
  const snap = await getDocs(query(collectionGroup(db, "matches"), where("arbitreId", "==", null)));
  return snap.docs
    .map((d) => ({ id: d.id, tournamentId: d.ref.parent.parent.id, ...d.data() }))
    .filter((m) => m.date && m.heure && !m.bye); // seulement les matchs déjà planifiés, un vrai match (pas un bye)
}

export async function getMesMatchsArbitre(joueurId) {
  const snap = await getDocs(query(collectionGroup(db, "matches"), where("arbitreId", "==", joueurId)));
  return snap.docs.map((d) => ({ id: d.id, tournamentId: d.ref.parent.parent.id, ...d.data() }));
}

export async function getPlayersByIds(ids) {
  const uniques = [...new Set(ids)];
  const resultats = await Promise.all(uniques.map((id) => getPlayer(id)));
  return resultats.filter((p) => p !== null);
}

// ---------- ÉQUIPES (globales, comme les joueurs) ----------
// Une équipe se crée une fois : nom, mot de passe capitaine, effectif,
// dispo, préférence terrain — tout est géré par le capitaine et reste
// valable pour tous les tournois auxquels elle s'inscrit ensuite.

export async function createEquipe(data) {
  const ref = await addDoc(collection(db, "equipes"), {
    nom: data.nom,
    capitainePassword: data.capitainePassword,
    codeEquipe: genererCode(),
    preferenceTerrain: data.preferenceTerrain || null,
    // Le "capitaine" n'a plus de droits particuliers sur l'équipe par
    // rapport aux autres membres liés (comptes joueurs) — ces deux champs
    // servent UNIQUEMENT à savoir qui contacter en cas de besoin.
    capitaineNom: data.capitaineNom || null,
    capitaineContact: data.capitaineContact || null,
    membres: data.membres || [], // { type: "libre"|"compte", nom, poste?, numero?, piedFort?, joueurId? }
    demandesAdhesion: [], // { joueurId, nom, dateDemande } — en attente d'acceptation par un membre déjà lié
    dispos: {}, // { "date|heure": "available"|"unavailable" }
    sondagesJoueurs: [], // créneaux sondés auprès des coéquipiers
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchEquipes(callback) {
  return onSnapshot(collection(db, "equipes"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getEquipes() {
  const snap = await getDocs(collection(db, "equipes"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Recherche, dans TOUTES les équipes du hub, les membres "libres" (sans
// compte — typiquement issus d'un import CSV d'un ancien tournoi) dont le
// nom correspond exactement (insensible à la casse/accents) à celui donné
// — sert à proposer à un joueur de relier son compte à son historique.
function normaliseNomSimple(nom) {
  return (nom || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// Cherche parmi TOUS les effectifs importés par tournoi (membresHistorique
// de chaque inscription — voir plus bas) une personne enregistrée sous ce
// nom sans compte lié, pour proposer au joueur de s'auto-associer à sa
// première connexion. On regarde aussi, par sécurité/rétrocompatibilité,
// l'ancien emplacement (équipe globale) au cas où un membre "libre" s'y
// trouverait encore.
export async function trouverParticipationsLibres(nom) {
  const cible = normaliseNomSimple(nom);
  if (!cible) return [];
  const resultats = [];

  const [inscriptionsSnap, equipesSnap, tournamentsSnap] = await Promise.all([
    getDocs(collectionGroup(db, "inscriptions")),
    getDocs(collection(db, "equipes")),
    getDocs(collection(db, "tournaments")),
  ]);
  const equipeNomParId = new Map(equipesSnap.docs.map((d) => [d.id, d.data().nom]));
  const tournamentNomParId = new Map(tournamentsSnap.docs.map((d) => [d.id, d.data().nom]));

  inscriptionsSnap.docs.forEach((d) => {
    const tournamentId = d.ref.parent.parent.id;
    const equipeId = d.id;
    (d.data().membresHistorique || []).forEach((m, index) => {
      if (m.type === "libre" && normaliseNomSimple(m.nom) === cible) {
        resultats.push({
          tournamentId,
          equipeId,
          equipeNom: equipeNomParId.get(equipeId) || "?",
          tournamentNom: tournamentNomParId.get(tournamentId) || "?",
          index,
          nomMembre: m.nom,
        });
      }
    });
  });

  // Rétrocompatibilité : anciens imports pas encore migrés vers le nouveau
  // système (avant la séparation par tournoi).
  equipesSnap.docs.forEach((d) => {
    (d.data().membres || []).forEach((m, index) => {
      if (m.type === "libre" && normaliseNomSimple(m.nom) === cible) {
        resultats.push({ tournamentId: null, equipeId: d.id, equipeNom: d.data().nom, tournamentNom: null, index, nomMembre: m.nom });
      }
    });
  });

  return resultats;
}

// Convertit un membre "libre" (issu d'un import CSV) trouvé dans
// l'effectif d'UN tournoi précis en membre "compte" lié au joueur qui vient
// de s'auto-associer. tournamentId === null = ancien emplacement (équipe
// globale), gardé pour rétrocompatibilité.
export async function lierMembreLibre(tournamentId, equipeId, index, joueur) {
  const ref = tournamentId
    ? doc(db, "tournaments", tournamentId, "inscriptions", equipeId)
    : doc(db, "equipes", equipeId);
  const champ = tournamentId ? "membresHistorique" : "membres";
  const snap = await getDoc(ref);
  const liste = [...(snap.data()?.[champ] || [])];
  if (!liste[index] || liste[index].type !== "libre") return; // a changé entre-temps, on n'écrase rien
  liste[index] = { type: "compte", joueurId: joueur.id, nom: liste[index].nom };
  await updateDoc(ref, { [champ]: liste });
}

// ---------- Effectif rattaché à une inscription (par tournoi) ----------
// Les membres importés par CSV ("libre", sans compte) sont attachés à
// l'inscription équipe+tournoi, pas à l'équipe globale : la même équipe qui
// revient dans plusieurs tournois a ainsi un effectif distinct à chaque
// fois. Le compte joueur "réel" (rejoint via code d'invitation) reste lui
// sur l'équipe globale (addEquipeMember/removeEquipeMember plus bas) —
// c'est un effectif vivant, pas un instantané historique par tournoi.
export async function addInscriptionMembre(tournamentId, equipeId, member) {
  const ref = doc(db, "tournaments", tournamentId, "inscriptions", equipeId);
  const snap = await getDoc(ref);
  const membresHistorique = [...(snap.data()?.membresHistorique || []), member];
  await updateDoc(ref, { membresHistorique });
}

export async function removeInscriptionMembre(tournamentId, equipeId, index) {
  const ref = doc(db, "tournaments", tournamentId, "inscriptions", equipeId);
  const snap = await getDoc(ref);
  const membresHistorique = (snap.data()?.membresHistorique || []).filter((_, i) => i !== index);
  await updateDoc(ref, { membresHistorique });
}

export async function getEquipe(equipeId) {
  const snap = await getDoc(doc(db, "equipes", equipeId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function updateEquipe(equipeId, patch) {
  await updateDoc(doc(db, "equipes", equipeId), patch);
}

export async function deleteEquipe(equipeId) {
  await deleteDoc(doc(db, "equipes", equipeId));
}

export async function addEquipeMember(equipeId, member) {
  const ref = doc(db, "equipes", equipeId);
  const snap = await getDoc(ref);
  const membres = snap.data().membres || [];
  membres.push(member);
  await updateDoc(ref, { membres });
}

export async function removeEquipeMember(equipeId, index) {
  const ref = doc(db, "equipes", equipeId);
  const snap = await getDoc(ref);
  const membres = (snap.data().membres || []).filter((_, i) => i !== index);
  await updateDoc(ref, { membres });
}

export async function setEquipeAvailability(equipeId, marks) {
  await updateDoc(doc(db, "equipes", equipeId), { dispos: marks });
}

// Authentifie un capitaine par le mot de passe de son équipe — une seule
// lecture (la collection équipes est globale, plus besoin de scanner tous
// les tournois comme avant).
export async function findEquipeByPassword(password) {
  const snap = await getDocs(collection(db, "equipes"));
  const match = snap.docs.find((d) => d.data().capitainePassword === password);
  return match ? { id: match.id, ...match.data() } : null;
}

// Trouve une équipe par son code d'invitation, pour qu'un joueur du hub la
// rejoigne depuis son propre compte.
export async function findEquipeByCode(code) {
  const snap = await getDocs(collection(db, "equipes"));
  const match = snap.docs.find((d) => d.data().codeEquipe === code);
  return match ? { id: match.id, ...match.data() } : null;
}

// Liste toutes les équipes (parmi la collection globale) dont ce joueur
// fait partie en tant que membre "compte" lié.
// Équipes où ce joueur apparaît dans l'effectif importé d'UN tournoi précis
// (membresHistorique) — typiquement après une revendication de profil —
// distinct de getEquipesForPlayer ci-dessous qui ne regarde que l'effectif
// "compte" vivant de l'équipe (rejoint via code d'invitation).
export async function getEquipesHistoriquesPourJoueur(joueurId) {
  const inscriptionsSnap = await getDocs(collectionGroup(db, "inscriptions"));
  const equipeIds = new Set();
  inscriptionsSnap.docs.forEach((d) => {
    const estMembre = (d.data().membresHistorique || []).some((m) => m.joueurId === joueurId);
    if (estMembre) equipeIds.add(d.id);
  });
  const resultats = await Promise.all([...equipeIds].map((id) => getEquipe(id)));
  return resultats.filter((e) => e !== null);
}

export async function getEquipesForPlayer(joueurId) {
  const snap = await getDocs(collection(db, "equipes"));
  return snap.docs
    .filter((d) => (d.data().membres || []).some((m) => m.type === "compte" && m.joueurId === joueurId))
    .map((d) => ({ id: d.id, ...d.data() }));
}

// ---------- Palmarès global ----------
// Toutes les inscriptions (équipe ↔ tournoi) du hub entier, avec le nom du
// tournoi déjà attaché — sert de base brute au calcul du palmarès global par
// joueur (participations/victoires), fait ensuite côté admin.js avec
// stadeAtteintEquipe (schedule.js) et les matchs de chaque tournoi.
export async function getToutesInscriptions() {
  const [inscriptionsSnap, tournamentsSnap] = await Promise.all([
    getDocs(collectionGroup(db, "inscriptions")),
    getDocs(collection(db, "tournaments")),
  ]);
  const tournamentParId = new Map(tournamentsSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  return inscriptionsSnap.docs
    .map((d) => {
      const tournamentId = d.ref.parent.parent.id;
      const tournoi = tournamentParId.get(tournamentId);
      if (!tournoi) return null; // inscription orpheline (tournoi supprimé entre-temps)
      return { equipeId: d.id, tournamentId, tournoi, ...d.data() };
    })
    .filter((r) => r !== null);
}

// ---------- Fusion de deux profils joueur (doublons/alias) ----------
// Fusionne "idASupprimer" dans "idPrincipal" — sauf si les deux comptes sont
// déjà revendiqués (deux vraies personnes distinctes avec un mot de passe,
// on refuse de choisir à leur place). Si l'un des deux est revendiqué, c'est
// TOUJOURS lui qui survit, peu importe l'ordre passé en argument. Le nom du
// profil supprimé est gardé en alias sur le survivant, et toutes les
// références (effectifs par tournoi, effectif "compte" vivant, arbitrages)
// sont réécrites vers le survivant avant suppression du doublon.
export async function fusionnerJoueurs(idPrincipal, idASupprimer) {
  const [snapA, snapB] = await Promise.all([
    getDoc(doc(db, "joueurs", idPrincipal)),
    getDoc(doc(db, "joueurs", idASupprimer)),
  ]);
  if (!snapA.exists() || !snapB.exists()) throw new Error("Un des deux profils n'existe plus.");
  const a = { id: snapA.id, ...snapA.data() };
  const b = { id: snapB.id, ...snapB.data() };
  if (a.revendique && b.revendique) {
    throw new Error("Les deux profils sont déjà revendiqués (deux comptes réels) — fusion refusée.");
  }

  const survivant = a.revendique ? a : b.revendique ? b : a; // si aucun n'est revendiqué, on garde l'ordre demandé
  const perdant = survivant.id === a.id ? b : a;

  const aliases = [...new Set([...(survivant.aliases || []), perdant.nom, ...(perdant.aliases || [])])].filter(
    (nom) => normaliseNomSimple(nom) !== normaliseNomSimple(survivant.nom)
  );
  await updateDoc(doc(db, "joueurs", survivant.id), { aliases });

  // Réécrit toutes les références au profil perdant dans les inscriptions
  // (membresHistorique par tournoi + arbitrage sur les matchs).
  const inscriptionsSnap = await getDocs(collectionGroup(db, "inscriptions"));
  for (const d of inscriptionsSnap.docs) {
    const membresHistorique = d.data().membresHistorique || [];
    if (!membresHistorique.some((m) => m.joueurId === perdant.id)) continue;
    const maj = membresHistorique.map((m) => (m.joueurId === perdant.id ? { ...m, joueurId: survivant.id } : m));
    await updateDoc(d.ref, { membresHistorique: maj });
  }

  // Effectif "compte" vivant sur les équipes globales.
  const equipesSnap = await getDocs(collection(db, "equipes"));
  for (const d of equipesSnap.docs) {
    const membres = d.data().membres || [];
    if (!membres.some((m) => m.joueurId === perdant.id)) continue;
    const maj = membres.map((m) => (m.joueurId === perdant.id ? { ...m, joueurId: survivant.id } : m));
    await updateDoc(d.ref, { membres: maj });
  }

  // Arbitrages déjà assignés au profil perdant.
  const matchsSnap = await getDocs(query(collectionGroup(db, "matches"), where("arbitreId", "==", perdant.id)));
  for (const d of matchsSnap.docs) {
    await updateDoc(d.ref, { arbitreId: survivant.id });
  }

  await deleteDoc(doc(db, "joueurs", perdant.id));
  return survivant.id;
}

// ---------- Demandes d'adhésion à une équipe (inscription publique) ----------
// Sur la page publique, un joueur sans équipe peut demander à rejoindre une
// équipe déjà inscrite à un tournoi plutôt que de saisir un code — la
// demande atterrit en attente, et n'IMPORTE QUEL membre déjà lié à
// l'équipe (pas seulement le "capitaine" contact) peut l'accepter/refuser,
// puisque tous les membres liés ont les mêmes droits de gestion.

export async function demanderAdhesion(equipeId, { joueurId, nom }) {
  const ref = doc(db, "equipes", equipeId);
  const snap = await getDoc(ref);
  const equipe = snap.data();
  const dejaMembre = (equipe.membres || []).some((m) => m.type === "compte" && m.joueurId === joueurId);
  const dejaDemande = (equipe.demandesAdhesion || []).some((d) => d.joueurId === joueurId);
  if (dejaMembre || dejaDemande) return; // pas de doublon
  const demandesAdhesion = [...(equipe.demandesAdhesion || []), { joueurId, nom, dateDemande: new Date().toISOString() }];
  await updateDoc(ref, { demandesAdhesion });
}

export async function accepterAdhesion(equipeId, joueurId) {
  const ref = doc(db, "equipes", equipeId);
  const snap = await getDoc(ref);
  const equipe = snap.data();
  const demande = (equipe.demandesAdhesion || []).find((d) => d.joueurId === joueurId);
  if (!demande) return;
  const demandesAdhesion = (equipe.demandesAdhesion || []).filter((d) => d.joueurId !== joueurId);
  const membres = [...(equipe.membres || []), { type: "compte", joueurId, nom: demande.nom }];
  await updateDoc(ref, { demandesAdhesion, membres });
}

export async function refuserAdhesion(equipeId, joueurId) {
  const ref = doc(db, "equipes", equipeId);
  const snap = await getDoc(ref);
  const demandesAdhesion = (snap.data().demandesAdhesion || []).filter((d) => d.joueurId !== joueurId);
  await updateDoc(ref, { demandesAdhesion });
}

// ---------- TERRAINS (globaux) ----------
// Un terrain existe une fois, avec sa propre grille de dispo réelle
// (peinte comme pour les équipes/joueurs) — un tournoi choisit ensuite
// lesquels il utilise (tournament.terrainIds).

export async function createTerrain(nom) {
  const ref = await addDoc(collection(db, "terrains"), {
    nom,
    dispos: {}, // { "date|heure": "available"|"unavailable" }
    creneaux: [], // plages continues calculées depuis "dispos", consommées par scheduleMatches
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchTerrains(callback) {
  return onSnapshot(collection(db, "terrains"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getTerrains() {
  const snap = await getDocs(collection(db, "terrains"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function deleteTerrain(terrainId) {
  await deleteDoc(doc(db, "terrains", terrainId));
}

export async function setTerrainAvailability(terrainId, marks) {
  const creneaux = marksToCreneaux(marks);
  await updateDoc(doc(db, "terrains", terrainId), { dispos: marks, creneaux });
}

// ---------- TOURNOIS ----------

export async function createTournament(data) {
  const ref = await addDoc(collection(db, "tournaments"), {
    nom: data.nom,
    sport: data.sport || "football",
    statut: "préparation", // préparation | en_cours | terminé
    dateDebut: data.dateDebut || null, // date du tournoi (ou premier jour si plusieurs) — affichée sur la page publique
    dateFin: data.dateFin || null, // optionnel, si le tournoi s'étale sur plusieurs jours
    inscriptionsOuvertes: data.historique ? false : data.inscriptionsOuvertes !== false, // permet de fermer les inscriptions publiques sans supprimer le tournoi
    historique: data.historique || false, // tournoi déjà joué (importé depuis un ancien document) plutôt qu'un tournoi en cours/à venir
    tailleGroupeVisee: data.tailleGroupeVisee || 4, // ex: 4 -> le nb de groupes se recalcule tout seul selon le nb réel d'équipes inscrites
    nbMiTemps: data.nbMiTemps || 2,
    dureeMiTemps: data.dureeMiTemps || 10,
    duréePause: data.duréePause || 5,
    allerRetour: data.allerRetour || false,
    nbQualifiesPhaseFinale: data.nbQualifiesPhaseFinale || null, // null = pas de phase finale prévue
    terrainIds: [], // terrains (globaux) utilisés par ce tournoi
    sondages: [], // créneaux sondés auprès des équipes inscrites (façon Doodle)
    regleClassement: data.regleClassement || {
      pointsVictoire: 3,
      pointsNul: 1,
      pointsDefaite: 0,
      criteres: ["points", "diffButs", "butsMarques", "fairplayScore"],
    },
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchTournaments(callback) {
  return onSnapshot(
    query(collection(db, "tournaments"), orderBy("createdAt", "desc")),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getTournament(tournamentId) {
  const snap = await getDoc(doc(db, "tournaments", tournamentId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function updateTournament(tournamentId, patch) {
  await updateDoc(doc(db, "tournaments", tournamentId), patch);
}

export async function deleteTournament(tournamentId) {
  const inscriptionsSnap = await getDocs(collection(db, "tournaments", tournamentId, "inscriptions"));
  for (const d of inscriptionsSnap.docs) await deleteDoc(d.ref);
  const matchesSnap = await getDocs(collection(db, "tournaments", tournamentId, "matches"));
  for (const d of matchesSnap.docs) await deleteDoc(d.ref);
  await deleteDoc(doc(db, "tournaments", tournamentId));
}

// ---------- CHAMPIONNATS (regroupement de plusieurs tournois) ----------
// Un championnat cumule les résultats de plusieurs tournois dans un seul
// classement (façon classement de saison) — entièrement personnalisable :
// Joas choisit lui-même quels tournois en font partie, et si les matchs de
// phase finale comptent en plus des matchs de poule ou non.
export async function createChampionnat(data) {
  const ref = await addDoc(collection(db, "championnats"), {
    nom: data.nom,
    tournamentIds: data.tournamentIds || [],
    inclurePhaseFinale: data.inclurePhaseFinale !== false,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchChampionnats(callback) {
  return onSnapshot(
    query(collection(db, "championnats"), orderBy("createdAt", "desc")),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function updateChampionnat(championnatId, patch) {
  await updateDoc(doc(db, "championnats", championnatId), patch);
}

export async function deleteChampionnat(championnatId) {
  await deleteDoc(doc(db, "championnats", championnatId));
}

// ---------- INSCRIPTIONS (équipe ↔ tournoi) ----------
// Ce qui n'a de sens que POUR ce tournoi précis : groupe de poule, statut,
// paiement. Une équipe peut avoir une inscription différente dans chaque
// tournoi auquel elle participe.

export async function inscrireEquipe(tournamentId, equipeId) {
  await setDoc(doc(db, "tournaments", tournamentId, "inscriptions", equipeId), {
    equipeId,
    groupe: null,
    statut: "en_attente", // en_attente | confirmée | forfait
    statutPaiement: "non_payé", // non_payé | payé
    createdAt: serverTimestamp(),
  });
}

export async function estInscrite(tournamentId, equipeId) {
  const snap = await getDoc(doc(db, "tournaments", tournamentId, "inscriptions", equipeId));
  return snap.exists();
}

export function watchInscriptions(tournamentId, callback) {
  return onSnapshot(collection(db, "tournaments", tournamentId, "inscriptions"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function updateInscription(tournamentId, equipeId, patch) {
  await updateDoc(doc(db, "tournaments", tournamentId, "inscriptions", equipeId), patch);
}

export async function desinscrireEquipe(tournamentId, equipeId) {
  await deleteDoc(doc(db, "tournaments", tournamentId, "inscriptions", equipeId));
}

// Liste, pour une équipe donnée, toutes ses inscriptions (tous tournois
// confondus) — pas de requête Firestore native possible sur des
// sous-collections séparées, donc on parcourt les tournois un par un
// (en parallèle) comme pour findTeamByPassword historiquement.
export async function getInscriptionsForEquipe(equipeId) {
  const tournaments = await getDocs(collection(db, "tournaments"));
  const resultats = await Promise.all(
    tournaments.docs.map(async (t) => {
      const snap = await getDoc(doc(db, "tournaments", t.id, "inscriptions", equipeId));
      return snap.exists() ? { tournamentId: t.id, tournamentNom: t.data().nom, ...snap.data() } : null;
    })
  );
  return resultats.filter((r) => r !== null);
}

// ---------- MATCHS ----------

export async function saveMatches(tournamentId, matches) {
  // matches: liste d'objets { equipeAId, equipeBId, groupe, phase, terrain, date, heure },
  // avec éventuellement déjà statut/scoreA/scoreB fournis (ex: un match "bye"
  // généré déjà qualifié d'office) — dans ce cas on respecte ces valeurs
  // plutôt que d'écraser avec les valeurs par défaut "à jouer".
  const results = [];
  for (const m of matches) {
    const ref = await addDoc(collection(db, "tournaments", tournamentId, "matches"), {
      statut: "proposé", // proposé | acté
      statutMatch: "à_jouer", // à_jouer | joué | interrompu | forfait | reporté
      scoreA: null,
      scoreB: null,
      evenements: [], // { type: "but"|"carton_jaune"|"carton_rouge", equipe, joueur?, minute?, motif? }
      arbitreId: null, // joueur (compte) qui s'est assigné pour arbitrer ce match
      ...m,
      createdAt: serverTimestamp(),
    });
    results.push(ref.id);
  }
  return results;
}

export async function clearMatches(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "matches"));
  for (const d of snap.docs) {
    await deleteDoc(d.ref);
  }
}

export async function getInscriptions(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "inscriptions"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getMatches(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "matches"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function watchMatches(tournamentId, callback) {
  return onSnapshot(
    collection(db, "tournaments", tournamentId, "matches"),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function deleteMatch(tournamentId, matchId) {
  await deleteDoc(doc(db, "tournaments", tournamentId, "matches", matchId));
}

export async function updateMatch(tournamentId, matchId, patch) {
  await updateDoc(doc(db, "tournaments", tournamentId, "matches", matchId), patch);
}

export async function setMatchResult(tournamentId, matchId, { scoreA, scoreB, evenements, statutMatch }) {
  await updateDoc(doc(db, "tournaments", tournamentId, "matches", matchId), {
    scoreA,
    scoreB,
    evenements: evenements || [],
    statutMatch: statutMatch || "joué",
  });
}

export async function actMatch(tournamentId, matchId) {
  await updateDoc(doc(db, "tournaments", tournamentId, "matches", matchId), { statut: "acté" });
}
