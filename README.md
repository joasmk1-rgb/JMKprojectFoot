# Site de tournoi — MVP module "gestion de tournoi"

Premier module du hub foot : équipes → groupes → calendrier généré automatiquement → résultats → classement calculé tout seul. Même stack qu'agenda-conseil (HTML/CSS/JS vanilla, Firebase/Firestore, GitHub Pages).

## Ce qui est fait dans cette version

- **admin.html** : créer un tournoi (nb groupes, nb terrains, durée de match, pause, date/heure de début), ajouter des équipes (avec mot de passe capitaine), générer automatiquement les groupes + toutes les confrontations de poule + heure/terrain, encoder les résultats, voir le classement par groupe (recalculé automatiquement).
- **index.html** : calendrier et classement publics, + connexion capitaine (mot de passe de l'équipe) pour voir ses prochains matchs, gérer la composition de son équipe (joueurs avec nom/poste/numéro/pied fort), et indiquer sa préférence de terrain.
- Un match a un statut **proposé** (juste généré) ou **acté** (figé par l'admin) — pour l'instant "acter" ne fait que marquer le statut ; la mécanique de demande de changement + recalcul n'est pas encore construite (prochaine étape).

## Ce qui n'est PAS encore fait (volontairement, pour garder ce premier module simple)

- Rôle **arbitre** (dispos, invitations, encodage buts/cartons pendant le match) — prochain module.
- **Dispos d'équipe en créneaux** (grille façon agenda-conseil) — pour l'instant seule la préférence de terrain (texte libre) existe côté capitaine.
- **Demandes de changement** sur un match acté + recalcul automatique.
- **Phases finales** (qualification automatique poule → élimination directe).
- **Mode "joueur libre"/hub** (comptes joueurs, matchmaking, foot à 5, entraînements).
- Vrai système de comptes (pour l'instant : mot de passe unique par équipe, comme les membres d'agenda-conseil).

## 1. Créer un projet Firebase (identique à agenda-conseil)

1. [console.firebase.google.com](https://console.firebase.google.com) → "Ajouter un projet" → nom (ex: `site-tournoi`) → créer.
2. **Build → Firestore Database** → "Créer une base de données" → région proche → mode production.
3. Onglet **Règles** → colle le contenu de `firestore.rules` → "Publier".
4. **Paramètres du projet** (⚙️) → **Général** → "Vos applications" → `</>` (Web) → recopie les 6 valeurs dans `firebase-config.js`.

## 2. Démarrer

Ouvre `admin.html`, tape le mot de passe temporaire `tournoi2026` (dans `config.js`) pour débloquer l'accès une seule fois.

Va dans l'onglet **Administrateurs** et ajoute-toi (nom + mot de passe personnel). ⚠️ Dès qu'au moins un administrateur est créé, le mot de passe `tournoi2026` cesse définitivement de fonctionner (même si quelqu'un lit le code) — exactement comme dans agenda-conseil. À partir de là, la connexion admin se fait uniquement avec les mots de passe personnels des administrateurs créés. Tu peux ajouter ou retirer des administrateurs à tout moment depuis cet onglet.

Crée ensuite ton premier tournoi, ajoute tes équipes, génère le calendrier.

Donne à chaque capitaine le mot de passe que tu as choisi pour son équipe : il se connecte sur `index.html` avec ce mot de passe pour voir ses matchs et gérer sa compo.

## 3. Héberger sur GitHub Pages

Identique à agenda-conseil : pousse tous les fichiers sur un dépôt GitHub, active GitHub Pages (branche `main`, dossier racine). Site public : `index.html` — admin : `admin.html` (à ne pas partager).

## Prochaines étapes possibles (à prioriser ensemble)

1. Rôle arbitre (dispos, invitations à un match, encodage buts/cartons/score/statut).
2. Grille de dispos par créneau côté capitaine (comme agenda-conseil), utilisée par le générateur de calendrier pour ne proposer que des créneaux où les deux équipes sont dispos.
3. Demande de changement sur un match acté + recalcul.
4. Phases finales avec qualification automatique.
5. Mode hub/matchmaking (joueurs libres, comptes enrichis, foot à 5, entraînements).
