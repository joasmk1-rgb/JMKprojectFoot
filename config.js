// ===================== CONFIGURATION =====================
// Le fichier à modifier pour personnaliser le comportement du site.

export const CONFIG = {
  // Granularité par défaut des créneaux horaires pour un match (en minutes)
  defaultMatchDuration: 15,
  defaultBreakDuration: 5, // pause / transition entre deux matchs sur un même terrain
};

// Grille de disponibilité des équipes/arbitres (mécanisme repris
// d'agenda-conseil) : plage horaire affichée et granularité des créneaux
// cliquables, et sur combien de jours à partir d'aujourd'hui la grille
// s'affiche (défile horizontalement au-delà).
export const DISPO_CONFIG = {
  dayStartHour: 8,
  dayEndHour: 22,
  slotMinutes: 30,
  rangeDays: 21,
};

// Mot de passe temporaire de démarrage pour la page admin (admin.html).
// Il ne sert qu'UNE fois, au tout début : dès qu'un administrateur est
// créé depuis le panneau "Administrateurs", ce mot de passe fixe cesse
// définitivement de fonctionner (même si quelqu'un lit ce fichier).
export const ADMIN_PASSPHRASE = "tournoi2026";
