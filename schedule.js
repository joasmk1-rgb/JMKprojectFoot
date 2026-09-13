// ===================== SCHEDULE.JS =====================
// Logique pure : répartition en groupes, génération des confrontations
// (round-robin) et attribution heures/terrains. Aucun accès Firestore ici.

// Répartit une liste d'équipes en N groupes le plus équilibré possible
// (serpentin, pour équilibrer si un ordre de "seedeing" est fourni).
export function splitIntoGroups(teams, nbGroupes) {
  const groupes = Array.from({ length: nbGroupes }, () => []);
  teams.forEach((team, i) => {
    const groupeIndex = i % nbGroupes;
    groupes[groupeIndex].push(team);
  });
  return groupes.map((membres, i) => ({
    nom: String.fromCharCode(65 + i), // A, B, C...
    equipes: membres,
  }));
}

// Génère toutes les confrontations d'un groupe en round-robin simple
// (chaque équipe rencontre chaque autre équipe une fois).
export function generateRoundRobin(equipes) {
  const confrontations = [];
  for (let i = 0; i < equipes.length; i++) {
    for (let j = i + 1; j < equipes.length; j++) {
      confrontations.push([equipes[i], equipes[j]]);
    }
  }
  return confrontations;
}

// Attribue heure + terrain à une liste de confrontations, en remplissant
// les terrains en parallèle (round-robin sur les terrains disponibles).
// Retourne des objets prêts à être sauvegardés comme matchs.
export function scheduleMatches({ groupes, nbTerrains, dureeMatch, duréePause, heureDebut, dateDebut }) {
  // 1. construit la liste plate de toutes les confrontations, groupe par groupe
  const toutesConfrontations = [];
  for (const groupe of groupes) {
    const confrontations = generateRoundRobin(groupe.equipes);
    for (const [a, b] of confrontations) {
      toutesConfrontations.push({ groupe: groupe.nom, equipeA: a, equipeB: b });
    }
  }

  // 2. répartit sur les terrains en parallèle, créneau par créneau
  const slotMs = (dureeMatch + duréePause) * 60 * 1000;
  const [h, m] = heureDebut.split(":").map(Number);
  const start = new Date(dateDebut);
  start.setHours(h, m, 0, 0);

  const matches = [];
  let slotIndex = 0;
  for (let i = 0; i < toutesConfrontations.length; i += nbTerrains) {
    const batch = toutesConfrontations.slice(i, i + nbTerrains);
    const slotTime = new Date(start.getTime() + slotIndex * slotMs);
    batch.forEach((c, terrainIndex) => {
      matches.push({
        groupe: c.groupe,
        phase: "poule",
        equipeAId: c.equipeA.id,
        equipeBId: c.equipeB.id,
        terrain: `Terrain ${terrainIndex + 1}`,
        date: dateDebut,
        heure: slotTime.toTimeString().slice(0, 5),
      });
    });
    slotIndex++;
  }
  return matches;
}

// Calcule le classement d'un groupe à partir des matchs joués, selon des
// règles paramétrables. matches doit contenir scoreA/scoreB renseignés
// pour les matchs joués (les autres sont ignorés).
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
      if (y[critere] !== x[critere]) return y[critere] - x[critere];
    }
    return 0;
  });
  return classement;
}
