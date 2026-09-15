// ===================== SCHEDULE.JS =====================
// Logique pure : calcul du nombre de groupes, répartition, génération des
// confrontations (round-robin, éventuellement aller-retour), attribution
// des créneaux terrain, classement, et qualification pour la phase finale.
// Aucun accès Firestore ici — tout est testable indépendamment.

// Calcule combien de groupes créer pour une taille de groupe visée, à
// partir du nombre RÉEL d'équipes au moment de l'appel (pas fixé à l'avance).
// Ex: 10 équipes, taille visée 4 -> 3 groupes (4,3,3) plutôt que 2 groupes de 5,
// pour rester le plus proche possible de la taille demandée.
export function computeNbGroups(nbEquipes, tailleGroupeVisee) {
  if (nbEquipes <= 0) return 0;
  return Math.max(1, Math.round(nbEquipes / tailleGroupeVisee));
}

// Répartit les équipes en groupes le plus équilibré possible (serpentin).
export function splitIntoGroups(teams, tailleGroupeVisee) {
  const nbGroupes = computeNbGroups(teams.length, tailleGroupeVisee);
  const groupes = Array.from({ length: nbGroupes }, () => []);
  teams.forEach((team, i) => {
    groupes[i % nbGroupes].push(team);
  });
  return groupes.map((membres, i) => ({
    nom: String.fromCharCode(65 + i), // A, B, C...
    equipes: membres,
  }));
}

// Génère les confrontations d'un groupe en round-robin (une fois, ou deux
// fois si allerRetour est vrai — dans ce cas l'ordre équipeA/équipeB
// s'inverse au retour, pratique pour alterner le terrain "à domicile").
export function generateRoundRobin(equipes, allerRetour = false) {
  const confrontations = [];
  for (let i = 0; i < equipes.length; i++) {
    for (let j = i + 1; j < equipes.length; j++) {
      confrontations.push([equipes[i], equipes[j]]);
      if (allerRetour) confrontations.push([equipes[j], equipes[i]]);
    }
  }
  return confrontations;
}

// Durée totale d'un match en minutes, à partir du format (mi-temps).
export function dureeMatchMinutes(nbMiTemps, dureeMiTemps) {
  return nbMiTemps * dureeMiTemps;
}

// Découpe la disponibilité d'un terrain en créneaux successifs de la durée
// d'un match (+ pause), sur une date donnée.
// venue.creneaux : [{ date: "2026-10-01", heureDebut: "09:00", heureFin: "13:00" }, ...]
function buildSlotsForVenue(venue, dureeCreneauMin) {
  const slots = [];
  for (const c of venue.creneaux || []) {
    const [hD, mD] = c.heureDebut.split(":").map(Number);
    const [hF, mF] = c.heureFin.split(":").map(Number);
    const start = new Date(`${c.date}T00:00:00`);
    start.setHours(hD, mD, 0, 0);
    const end = new Date(`${c.date}T00:00:00`);
    end.setHours(hF, mF, 0, 0);

    let cursor = new Date(start);
    while (cursor.getTime() + dureeCreneauMin * 60000 <= end.getTime()) {
      slots.push({
        date: c.date,
        heure: cursor.toTimeString().slice(0, 5),
        terrain: venue.nom,
        timestamp: cursor.getTime(),
      });
      cursor = new Date(cursor.getTime() + dureeCreneauMin * 60000);
    }
  }
  return slots;
}

// Attribue heure + terrain à toutes les confrontations de tous les groupes,
// en respectant les disponibilités réelles déclarées par terrain (venues),
// qui peuvent s'étaler sur un ou plusieurs jours.
// venues: [{ nom, creneaux: [{date, heureDebut, heureFin}] }]
export function scheduleMatches({ groupes, venues, nbMiTemps, dureeMiTemps, duréePause, allerRetour }) {
  const dureeMatch = dureeMatchMinutes(nbMiTemps, dureeMiTemps);
  const dureeCreneau = dureeMatch + duréePause;

  // 1. tous les créneaux disponibles, toutes venues confondues, triés
  // chronologiquement (les terrains "avancent" chacun à leur rythme).
  let creneauxDisponibles = [];
  for (const venue of venues) {
    creneauxDisponibles.push(...buildSlotsForVenue(venue, dureeCreneau));
  }
  creneauxDisponibles.sort((a, b) => a.timestamp - b.timestamp);

  // 2. liste plate de toutes les confrontations de poule
  const toutesConfrontations = [];
  for (const groupe of groupes) {
    const confrontations = generateRoundRobin(groupe.equipes, allerRetour);
    for (const [a, b] of confrontations) {
      toutesConfrontations.push({ groupe: groupe.nom, equipeA: a, equipeB: b });
    }
  }

  // 3. affecte un créneau à chaque confrontation, dans l'ordre, en évitant
  // qu'une équipe joue deux matchs sur le même créneau exact (best effort :
  // si aucun créneau libre à ce moment pour cette équipe, prend le suivant).
  const matches = [];
  const occupePar = new Map(); // timestamp -> Set(equipeId) déjà engagées à ce moment

  for (const conf of toutesConfrontations) {
    let placé = false;
    for (const creneau of creneauxDisponibles) {
      const occupees = occupePar.get(creneau.timestamp) || new Set();
      if (occupees.has(conf.equipeA.id) || occupees.has(conf.equipeB.id)) continue;
      if (creneau.pris) continue;

      creneau.pris = true;
      occupees.add(conf.equipeA.id);
      occupees.add(conf.equipeB.id);
      occupePar.set(creneau.timestamp, occupees);

      matches.push({
        groupe: conf.groupe,
        phase: "poule",
        equipeAId: conf.equipeA.id,
        equipeBId: conf.equipeB.id,
        terrain: creneau.terrain,
        date: creneau.date,
        heure: creneau.heure,
      });
      placé = true;
      break;
    }
    if (!placé) {
      matches.push({
        groupe: conf.groupe,
        phase: "poule",
        equipeAId: conf.equipeA.id,
        equipeBId: conf.equipeB.id,
        terrain: "À PLANIFIER (pas assez de créneaux)",
        date: null,
        heure: null,
      });
    }
  }
  return matches;
}

// Compte les cartons d'une équipe dans un match à partir de ses événements
// (m.evenements: { type: "but"|"carton_jaune"|"carton_rouge", equipe, ... }).
// Le score de fair-play est négatif (0 = aucun carton) pour rester cohérent
// avec le tri générique "plus grand = mieux classé" utilisé partout ailleurs.
const PENALITE_JAUNE = 1;
const PENALITE_ROUGE = 3;

function compterCartons(stats, matches) {
  for (const m of matches) {
    for (const ev of m.evenements || []) {
      const s = stats[ev.equipe];
      if (!s) continue;
      if (ev.type === "carton_jaune") s.cartonsJaunes++;
      else if (ev.type === "carton_rouge") s.cartonsRouges++;
    }
  }
  for (const s of Object.values(stats)) {
    s.fairplayScore = -(s.cartonsJaunes * PENALITE_JAUNE + s.cartonsRouges * PENALITE_ROUGE);
  }
}

// Calcule le classement d'un groupe à partir des matchs joués, selon des
// règles paramétrables. criteres est une liste ordonnée parmi : "points",
// "diffButs", "butsMarques", "fairplayScore" (moins de cartons = mieux
// classé), "confrontationDirecte" (ignoré ici, seulement pertinent en tri
// intra-groupe déjà géré par les critères précédents).
export function computeStandings(equipes, matches, regleClassement) {
  const { pointsVictoire, pointsNul, pointsDefaite, criteres } = regleClassement;

  const stats = {};
  for (const eq of equipes) {
    stats[eq.id] = {
      equipeId: eq.id,
      nom: eq.nom,
      joues: 0,
      victoires: 0,
      nuls: 0,
      defaites: 0,
      butsMarques: 0,
      butsEncaisses: 0,
      diffButs: 0,
      points: 0,
      cartonsJaunes: 0,
      cartonsRouges: 0,
      fairplayScore: 0,
    };
  }

  for (const m of matches) {
    if (m.scoreA === null || m.scoreA === undefined || m.scoreB === null || m.scoreB === undefined) continue;
    const a = stats[m.equipeAId];
    const b = stats[m.equipeBId];
    if (!a || !b) continue;

    a.joues++;
    b.joues++;
    a.butsMarques += m.scoreA;
    a.butsEncaisses += m.scoreB;
    b.butsMarques += m.scoreB;
    b.butsEncaisses += m.scoreA;

    if (m.scoreA > m.scoreB) {
      a.victoires++;
      a.points += pointsVictoire;
      b.defaites++;
      b.points += pointsDefaite;
    } else if (m.scoreA < m.scoreB) {
      b.victoires++;
      b.points += pointsVictoire;
      a.defaites++;
      a.points += pointsDefaite;
    } else {
      a.nuls++;
      b.nuls++;
      a.points += pointsNul;
      b.points += pointsNul;
    }
  }

  for (const s of Object.values(stats)) {
    s.diffButs = s.butsMarques - s.butsEncaisses;
  }
  compterCartons(stats, matches);

  const classement = Object.values(stats);
  classement.sort((x, y) => {
    for (const critere of criteres) {
      if (critere === "confrontationDirecte") continue; // seulement intra-groupe, déjà départagé par les autres critères ici
      if (y[critere] !== x[critere]) return y[critere] - x[critere];
    }
    return 0;
  });
  return classement;
}

// Détermine les équipes qualifiées pour la phase finale : tous les premiers
// de chaque groupe automatiquement, puis complète avec les meilleurs
// 2èmes/3èmes (etc.) toutes poules confondues, classés selon la même
// cascade de critères que le classement de groupe (points/diff/buts/
// fair-play...) — la confrontation directe est ignorée ici : des équipes de
// groupes différents ne se sont jamais affrontées.
export function computeQualifiers(classementsParGroupe, nbQualifies, criteres = ["points", "diffButs", "butsMarques", "fairplayScore"]) {
  // classementsParGroupe: [{ groupe: "A", classement: [...] }, ...] (classement trié, position 0 = 1er)
  const qualifies = [];

  // 1. tous les 1ers de groupe d'abord
  for (const g of classementsParGroupe) {
    if (g.classement[0]) qualifies.push({ ...g.classement[0], groupe: g.groupe, position: 1 });
  }

  // 2. puis les 2èmes, 3èmes... toutes poules confondues, classés entre eux
  let rang = 1; // index dans le classement (0 = 1er, 1 = 2ème...)
  while (qualifies.length < nbQualifies) {
    rang++;
    const candidats = classementsParGroupe
      .filter((g) => g.classement[rang - 1])
      .map((g) => ({ ...g.classement[rang - 1], groupe: g.groupe, position: rang }));
    if (candidats.length === 0) break; // plus personne à repêcher

    candidats.sort((x, y) => {
      for (const critere of criteres) {
        if (critere === "confrontationDirecte") continue;
        if (y[critere] !== x[critere]) return y[critere] - x[critere];
      }
      return 0;
    });

    for (const c of candidats) {
      if (qualifies.length >= nbQualifies) break;
      qualifies.push(c);
    }
  }

  return qualifies.slice(0, nbQualifies);
}

function nommerPhase(nbEquipes) {
  if (nbEquipes <= 2) return "finale";
  if (nbEquipes <= 4) return "demi-finale";
  if (nbEquipes <= 8) return "quart-de-finale";
  if (nbEquipes <= 16) return "huitième-de-finale";
  return "phase-finale";
}

function prochainePuissanceDe2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Ordre de seeding classique d'un tableau à élimination directe (1 vs N,
// puis 2 vs N-1 côté opposé, etc. — récursif), pour une taille qui DOIT
// être une puissance de 2. seedOrder(8) = [1,8,4,5,2,7,3,6] : les paires
// consécutives (1,8) (4,5) (2,7) (3,6) sont les 4 quarts, et le nichage
// garantit que le vainqueur de (1,8) retombe sur le vainqueur de (4,5) au
// tour suivant, comme un vrai tableau à élimination directe.
function seedOrder(taille) {
  if (taille === 1) return [1];
  const prec = seedOrder(taille / 2);
  const out = [];
  for (const s of prec) {
    out.push(s);
    out.push(taille + 1 - s);
  }
  return out;
}

// Génère le PREMIER tour d'un tableau à élimination directe à partir de la
// liste des qualifiés, pour n'importe quelle taille jusqu'à 16 (pas
// seulement les puissances de 2) : les mieux classés (qualifies[0], [1]...)
// reçoivent un "bye" (qualification directe au tour suivant, sans jouer) si
// l'effectif ne tombe pas juste — pratique classique des coupes à effectif
// impair. qualifies doit déjà être trié du mieux classé au moins bien classé
// (c'est l'ordre renvoyé par computeQualifiers).
export function generateKnockoutBracket(qualifies) {
  const n = qualifies.length;
  if (n < 2) return [];
  const taille = prochainePuissanceDe2(n);
  const nbByes = taille - n;

  // seed 1..n = équipes réelles (dans l'ordre de force) ; seed n+1..taille
  // = emplacements "bye" — donnés aux emplacements les moins forts du
  // tableau complété, ce qui revient à exempter les nbByes meilleures
  // équipes réelles de devoir jouer un premier tour contre un adversaire.
  const slots = seedOrder(taille).map((seed) => (seed <= n ? qualifies[seed - 1] : null));

  const matchs = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (a && b) {
      matchs.push({
        phase: nommerPhase(taille),
        tourIndex: 0,
        slot: i / 2,
        equipeAId: a.equipeId,
        equipeBId: b.equipeId,
        groupe: null,
        bye: false,
      });
    } else {
      // Bye : l'équipe présente est qualifiée d'office, pas de vrai match.
      const presente = a || b;
      matchs.push({
        phase: nommerPhase(taille),
        tourIndex: 0,
        slot: i / 2,
        equipeAId: presente.equipeId,
        equipeBId: null,
        groupe: null,
        bye: true,
        statut: "acté",
        scoreA: null,
        scoreB: null,
      });
    }
  }
  if (nbByes > 0) {
    matchs._nbByes = nbByes; // info non persistée, utile pour le message admin
  }
  return matchs;
}

// Calcule le vainqueur d'un match de phase finale (bye ou score décisif).
// Renvoie null si le match n'a pas encore de résultat exploitable (pas de
// score, ou match nul sans tirs au but — impossible à trancher seul).
function vainqueurMatch(m) {
  if (m.bye) return m.equipeAId;
  if (m.scoreA === null || m.scoreA === undefined || m.scoreB === null || m.scoreB === undefined) return null;
  if (m.scoreA === m.scoreB) return null; // nul : il faut une séance de tirs au but encodée comme un score décisif
  return m.scoreA > m.scoreB ? m.equipeAId : m.equipeBId;
}

// À partir de tous les matchs d'un même tour (même tourIndex, triés par
// slot), génère le tour suivant. Renvoie { pret: false } si un match du tour
// n'a pas encore de résultat exploitable, { champion: equipeId, matchs: [] }
// si c'était la finale, ou { matchs: [...] } pour le tour suivant à créer.
export function genererTourSuivant(matchsDuTour) {
  const tries = [...matchsDuTour].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const vainqueurs = [];
  for (const m of tries) {
    const v = vainqueurMatch(m);
    if (!v) return { pret: false };
    vainqueurs.push(v);
  }
  if (vainqueurs.length <= 1) {
    return { champion: vainqueurs[0] || null, matchs: [] };
  }
  const tourSuivant = (tries[0]?.tourIndex ?? 0) + 1;
  const matchs = [];
  for (let i = 0; i < vainqueurs.length; i += 2) {
    matchs.push({
      phase: nommerPhase(vainqueurs.length),
      tourIndex: tourSuivant,
      slot: i / 2,
      equipeAId: vainqueurs[i],
      equipeBId: vainqueurs[i + 1],
      groupe: null,
      bye: false,
    });
  }
  return { matchs };
}
