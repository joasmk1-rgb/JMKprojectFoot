// ===================== DB.JS =====================
// Tous les échanges avec Firestore passent par ce fichier.
// Aucun autre fichier ne doit importer directement le SDK Firebase.

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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { marksToCreneaux } from "./grid.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// ---------- ADMINISTRATEURS ----------
// Même principe que agenda-conseil : tant qu'aucun admin n'existe, la
// passphrase de config.js sert de clé de démarrage. Dès qu'un premier
// admin est créé, elle cesse de fonctionner (voir isAdminBootstrap /
// findAdminByPassword, utilisés ensemble côté admin.js).

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

export async function findAdminByPassword(password) {
  const admins = await getAdmins();
  return admins.find((a) => a.password === password) || null;
}

// ---------- TOURNOIS ----------

export async function createTournament(data) {
  const ref = await addDoc(collection(db, "tournaments"), {
    nom: data.nom,
    sport: data.sport || "football",
    statut: "préparation", // préparation | en_cours | terminé
    tailleGroupeVisee: data.tailleGroupeVisee, // ex: 4 -> le nb de groupes se recalcule tout seul selon le nb réel d'équipes
    nbMiTemps: data.nbMiTemps,
    dureeMiTemps: data.dureeMiTemps,
    duréePause: data.duréePause,
    allerRetour: data.allerRetour || false,
    nbQualifiesPhaseFinale: data.nbQualifiesPhaseFinale || null, // null = pas de phase finale prévue
    regleClassement: data.regleClassement || {
      pointsVictoire: 3,
      pointsNul: 1,
      pointsDefaite: 0,
      criteres: ["points", "diffButs", "butsMarques"],
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

// ---------- EQUIPES ----------

export async function createTeam(tournamentId, data) {
  const ref = await addDoc(collection(db, "tournaments", tournamentId, "teams"), {
    nom: data.nom,
    groupe: data.groupe || null,
    statut: "en_attente", // en_attente | confirmée | forfait
    statutPaiement: "non_payé", // non_payé | payé
    capitainePassword: data.capitainePassword,
    preferenceTerrain: data.preferenceTerrain || null,
    membres: [], // { type: "libre"|"user", nom, poste, numero, userId? }
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchTeams(tournamentId, callback) {
  return onSnapshot(
    collection(db, "tournaments", tournamentId, "teams"),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getTeams(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "teams"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function updateTeam(tournamentId, teamId, patch) {
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), patch);
}

export async function deleteTeam(tournamentId, teamId) {
  await deleteDoc(doc(db, "tournaments", tournamentId, "teams", teamId));
}

export async function addTeamMember(tournamentId, teamId, member) {
  const teamRef = doc(db, "tournaments", tournamentId, "teams", teamId);
  const snap = await getDoc(teamRef);
  const membres = snap.data().membres || [];
  membres.push(member);
  await updateDoc(teamRef, { membres });
}

export async function removeTeamMember(tournamentId, teamId, index) {
  const teamRef = doc(db, "tournaments", tournamentId, "teams", teamId);
  const snap = await getDoc(teamRef);
  const membres = (snap.data().membres || []).filter((_, i) => i !== index);
  await updateDoc(teamRef, { membres });
}

// Remplace entièrement les dispos d'une équipe (objet { "date|heure":
// "available"|"unavailable" }). Le capitaine (ou l'admin pour son compte)
// enregistre en une fois après un geste de marquage (clic/glissé ou
// marquage rapide), pas créneau par créneau.
export async function setTeamAvailability(tournamentId, teamId, marks) {
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), { dispos: marks });
}

// Authentifie un capitaine par le mot de passe de son équipe (parmi toutes
// les équipes de tous les tournois, comme les membres d'agenda-conseil).
export async function findTeamByPassword(password) {
  const tournaments = await getDocs(collection(db, "tournaments"));
  // interroge tous les tournois en parallèle plutôt qu'un par un (beaucoup
  // plus rapide dès qu'il y a plusieurs tournois existants)
  const resultats = await Promise.all(
    tournaments.docs.map(async (t) => {
      const teams = await getDocs(collection(db, "tournaments", t.id, "teams"));
      const match = teams.docs.find((d) => d.data().capitainePassword === password);
      return match ? { tournamentId: t.id, teamId: match.id, ...match.data() } : null;
    })
  );
  return resultats.find((r) => r !== null) || null;
}

// ---------- TERRAINS (VENUES) ----------
// Un terrain a une liste de créneaux de disponibilité réelle
// { date: "2026-10-01", heureDebut: "09:00", heureFin: "13:00" }.
// Ça permet un tournoi sur un seul jour ou étalé sur plusieurs, terrain par
// terrain, sans supposer une seule plage horaire commune à tous.

export async function createVenue(tournamentId, nom) {
  const ref = await addDoc(collection(db, "tournaments", tournamentId, "venues"), {
    nom,
    creneaux: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchVenues(tournamentId, callback) {
  return onSnapshot(collection(db, "tournaments", tournamentId, "venues"), (snap) =>
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function deleteVenue(tournamentId, venueId) {
  await deleteDoc(doc(db, "tournaments", tournamentId, "venues", venueId));
}

export async function addVenueSlot(tournamentId, venueId, slot) {
  const ref = doc(db, "tournaments", tournamentId, "venues", venueId);
  const snap = await getDoc(ref);
  const creneaux = snap.data().creneaux || [];
  creneaux.push(slot); // { date, heureDebut, heureFin }
  await updateDoc(ref, { creneaux });
}

export async function removeVenueSlot(tournamentId, venueId, index) {
  const ref = doc(db, "tournaments", tournamentId, "venues", venueId);
  const snap = await getDoc(ref);
  const creneaux = (snap.data().creneaux || []).filter((_, i) => i !== index);
  await updateDoc(ref, { creneaux });
}

// Remplace entièrement les dispos peintes d'un terrain (mêmes "marks" que
// les équipes : { "date|heure": "available"|"unavailable" }) et recalcule
// automatiquement les "creneaux" (plages continues) utilisés par
// scheduleMatches, en fusionnant les cases "available" consécutives.
export async function setVenueAvailability(tournamentId, venueId, marks) {
  const creneaux = marksToCreneaux(marks);
  await updateDoc(doc(db, "tournaments", tournamentId, "venues", venueId), {
    dispos: marks,
    creneaux,
  });
}

export async function getVenues(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "venues"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------- MATCHS ----------

export async function saveMatches(tournamentId, matches) {
  // matches: liste d'objets { equipeAId, equipeBId, groupe, phase, terrain, date, heure }
  const results = [];
  for (const m of matches) {
    const ref = await addDoc(collection(db, "tournaments", tournamentId, "matches"), {
      ...m,
      statut: "proposé", // proposé | acté
      statutMatch: "à_jouer", // à_jouer | joué | interrompu | forfait | reporté
      scoreA: null,
      scoreB: null,
      evenements: [], // { type: "but"|"carton_jaune"|"carton_rouge", equipe, joueur?, minute?, motif? }
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
