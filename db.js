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

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// ---------- TOURNOIS ----------

export async function createTournament(data) {
  const ref = await addDoc(collection(db, "tournaments"), {
    nom: data.nom,
    sport: data.sport || "football",
    statut: "préparation", // préparation | en_cours | terminé
    nbGroupes: data.nbGroupes,
    nbTerrains: data.nbTerrains,
    dureeMatch: data.dureeMatch,
    duréePause: data.duréePause,
    heureDebut: data.heureDebut,
    dateDebut: data.dateDebut,
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

// Authentifie un capitaine par le mot de passe de son équipe (parmi toutes
// les équipes de tous les tournois, comme les membres d'agenda-conseil).
export async function findTeamByPassword(password) {
  const tournaments = await getDocs(collection(db, "tournaments"));
  for (const t of tournaments.docs) {
    const teams = await getDocs(collection(db, "tournaments", t.id, "teams"));
    const match = teams.docs.find((d) => d.data().capitainePassword === password);
    if (match) {
      return { tournamentId: t.id, teamId: match.id, ...match.data() };
    }
  }
  return null;
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
