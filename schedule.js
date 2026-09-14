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

// Calcule le classement d'un groupe à partir des matchs joués, selon des
// règles paramétrables.
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
// 2èmes/3èmes (etc.) toutes poules confondues, classés par points/diff/buts
// (la confrontation directe n'est pas utilisable ici : des équipes de
// groupes différents ne se sont jamais affrontées).
export function computeQualifiers(classementsParGroupe, nbQualifies) {
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
      if (y.points !== x.points) return y.points - x.points;
      if (y.diffButs !== x.diffButs) return y.diffButs - x.diffButs;
      return y.butsMarques - x.butsMarques;
    });

    for (const c of candidats) {
      if (qualifies.length >= nbQualifies) break;
      qualifies.push(c);
    }
  }

  return qualifies.slice(0, nbQualifies);
}

// Génère un tableau à élimination directe à partir de la liste des
// qualifiés (seeding classique : le mieux classé affronte le moins bien
// classé, etc.), en essayant d'éviter de faire s'affronter deux équipes
// du même groupe de poule au premier tour si une autre option existe.
export function generateKnockoutBracket(qualifies) {
  const n = qualifies.length;
  const gauche = qualifies.slice(0, n / 2);
  const droite = qualifies.slice(n / 2).reverse();

  // essaie, par simples échanges entre paires, d'éviter qu'une paire
  // oppose deux équipes venues du même groupe de poule (si une autre
  // combinaison le permet — sinon on laisse tel quel, ça peut arriver
  // avec peu de groupes/équipes).
  for (let i = 0; i < gauche.length; i++) {
    if (gauche[i].groupe !== droite[i].groupe) continue;
    const jEchange = droite.findIndex((d, j) => j !== i && d.groupe !== gauche[i].groupe && gauche[j].groupe !== droite[i].groupe);
    if (jEchange !== -1) {
      const tmp = droite[i];
      droite[i] = droite[jEchange];
      droite[jEchange] = tmp;
    }
  }

  return gauche.map((g, i) => ({
    phase: nommerPhase(n),
    equipeAId: g.equipeId,
    equipeBId: droite[i].equipeId,
    groupe: null,
  }));
}

function nommerPhase(nbEquipes) {
  if (nbEquipes <= 2) return "finale";
  if (nbEquipes <= 4) return "demi-finale";
  if (nbEquipes <= 8) return "quart-de-finale";
  if (nbEquipes <= 16) return "huitième-de-finale";
  return "phase-finale";
}
