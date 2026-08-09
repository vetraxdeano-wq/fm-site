/**
 * MOTEUR DE SIMULATION INSTANTANÉE DE MATCH — FM Web
 * ----------------------------------------------------
 * Implémente le pipeline en 10 étapes du cahier des charges.
 * Écrit en fonctions pures (faciles à tester isolément), orchestrées
 * par `simulerMatch()` à la fin du fichier.
 *
 * Entrées attendues (déjà chargées depuis Supabase, pas de fetch ici
 * pour garder les fonctions pures et testables) :
 *  - club: ligne de `game_clubs` (+ jointure `clubs` pour reputation/niveau_pct)
 *  - joueurs: lignes de `game_players` (categorie = 'equipe_a') du club
 *  - tactique: ligne de `tactiques` (formation, compositions, instructions)
 *  - coach: ligne de `game_staff` de l'entraîneur assigné à equipe_a (peut être null)
 *  - contexte: { domicile: bool, enjeu: 0-1, meteo: 'normale'|'pluie'|'canicule'|'neige' }
 *
 * Sortie de `simulerMatch()` : un objet prêt à être persisté dans
 * `calendrier.score_domicile`, `calendrier.score_exterieur` et
 * `calendrier.stats` (jsonb).
 */

'use strict';

// ============================================================
// UTILITAIRES
// ============================================================

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function moyenne(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Bruit gaussien approximé (somme de 3 uniformes ~ forme cloche bornée à
 * ±3 écarts-types). ATTENTION à la normalisation : la somme brute
 * (R1+R2+R3-1.5) a un écart-type réel de 0.5, PAS 1 — sans le facteur *2
 * ci-dessous, tous les appelants du fichier recevaient deux fois MOINS de
 * dispersion que le paramètre `ecartType` ne le laissait penser. C'était
 * l'une des causes principales des stats de match trop resserrées et trop
 * similaires d'un match à l'autre (possession, danger, tirs, cartons du jour
 * du joueur...) : chaque source de variabilité du moteur était de facto
 * amputée de moitié. Avec le *2, `ecartType` est bien l'écart-type réellement
 * obtenu par l'appelant.
 */
function bruitGaussien(ecartType = 1) {
  const u = Math.random() + Math.random() + Math.random() - 1.5;
  return u * 2 * ecartType;
}

/** Tirage pondéré : items = [{ item, poids }], renvoie un item. */
function tirageAlPondere(entrees) {
  const total = entrees.reduce((s, e) => s + Math.max(0, e.poids), 0);
  if (total <= 0) return entrees.length ? entrees[0].item : null;
  let r = Math.random() * total;
  for (const e of entrees) {
    r -= Math.max(0, e.poids);
    if (r <= 0) return e.item;
  }
  return entrees[entrees.length - 1].item;
}

/** Tirage Bernoulli. */
function proba(p) {
  return Math.random() < clamp(p, 0, 1);
}

/** Tirage d'un nombre d'événements ~Poisson(lambda), sans dépendance externe. */
function tiragePoisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

function minuteAleatoire() {
  // légère surreprésentation en fin de mi-temps (fatigue) et fin de match
  return clamp(Math.round(bruitGaussien(28) + 46), 1, 90);
}

// ============================================================
// MAPPING RÔLES (issus de tactiques.compositions[].role)
// GB = gardien, D = défenseur, MD = milieu défensif/relayeur,
// M = milieu central classique (box-to-box, entre MD et MO),
// MO = milieu offensif (inclut les ailiers/attaquants de couloir, MOD/MOG),
// AL = arrière latéral, BT = buteur/attaquant de pointe
// ============================================================

const PROFILS_ROLE = {
  GB: {
    categorie: 'gardien',
    // attr_1c1 ("un contre un") est une vraie stat de gardien (duel face à
    // l'attaquant lancé seul) — elle appartient ici, pas côté attaquant.
    attributsCles: ['reflexes', 'placement', 'sorties_dans_surface', 'communication', 'agilite', 'concentration', 'attr_1c1'],
    poidsButeur: 0.001,
    poidsPasseur: 0.05,
    poidsCarton: 0.3,
  },
  D: {
    categorie: 'defenseur',
    attributsCles: ['marquage', 'tacles', 'anticipation', 'placement', 'jeu_de_tete', 'puissance', 'concentration'],
    poidsButeur: 0.6,
    poidsPasseur: 0.5,
    poidsCarton: 1.1,
  },
  MD: {
    categorie: 'milieu',
    attributsCles: ['tacles', 'anticipation', 'passes', 'endurance', 'agressivite', 'placement', 'decisions'],
    poidsButeur: 0.7,
    poidsPasseur: 1.0,
    poidsCarton: 1.4,
  },
  M: {
    // Milieu central classique (MC) : entre le relayeur/destructeur (MD) et
    // le meneur offensif (MO), un profil box-to-box equilibre — ni aussi
    // defensif qu'un MD, ni aussi tourne vers le but qu'un MO. Utilise par
    // les formations avec un vrai double/triple axe central (4-4-2,
    // 4-4-2 Diamant Axial, 4-3-3 MD Jeu large, 5-3-2 MD AL...).
    categorie: 'milieu',
    attributsCles: ['passes', 'controle_de_balle', 'vision_du_jeu', 'endurance', 'decisions', 'placement', 'technique'],
    poidsButeur: 1.0,
    poidsPasseur: 1.3,
    poidsCarton: 1.1,
  },
  MO: {
    categorie: 'milieu_offensif',
    attributsCles: ['technique', 'dribbles', 'passes', 'vision_du_jeu', 'controle_de_balle', 'finition'],
    poidsButeur: 1.4,
    poidsPasseur: 1.6,
    poidsCarton: 0.8,
  },
  AL: {
    // Arrière Latéral (poste_brut "AL (G/D)") : un défenseur de couloir, un peu plus
    // porté vers l'attaque qu'un axial pur (montées, centres) mais qui reste
    // fondamentalement un défenseur — ne pas confondre avec un ailier offensif
    // (les vrais ailiers/attaquants de couloir sont les postes "MO" latéraux, MOD/MOG).
    categorie: 'defenseur',
    attributsCles: ['marquage', 'tacles', 'placement', 'anticipation', 'vitesse', 'endurance', 'centres'],
    poidsButeur: 0.6,
    poidsPasseur: 0.9,
    poidsCarton: 1.0,
  },
  BT: {
    categorie: 'attaquant',
    // attr_1c1 retiré (c'est une stat de gardien, cf. GB ci-dessus) : remplacé
    // par vitesse, pertinente pour un avant-centre qui se joue de la ligne défensive.
    attributsCles: ['finition', 'sang_froid', 'appels_de_balle', 'jeu_de_tete', 'vitesse', 'technique'],
    poidsButeur: 3.2,
    poidsPasseur: 0.7,
    poidsCarton: 0.7,
  },
};

function profilRole(role) {
  return PROFILS_ROLE[role] || PROFILS_ROLE.MD;
}

/**
 * Axe de poste défense → attaque, utilisé pour juger de la cohérence d'un
 * remplacement (un attaquant doit remplacer un attaquant/ailier, pas un
 * défenseur ou un milieu défensif, et inversement). Le gardien n'y figure
 * pas : il n'est jamais concerné par un changement de champ dans ce modèle.
 */
const ORDRE_AXE_POSTE = ['defenseur', 'milieu', 'milieu_offensif', 'attaquant'];
function axePoste(role) {
  const idx = ORDRE_AXE_POSTE.indexOf(profilRole(role).categorie);
  return idx === -1 ? 2 : idx;
}

/**
 * Déduit un rôle générique (clé de PROFILS_ROLE) à partir de `poste_brut`
 * (ex. "AL/M (G), MO (GC), BT (C)") pour un joueur qui n'a PAS de slot de
 * composition assigné — typiquement un remplaçant pris sur le banc, dont on
 * a besoin d'estimer la note/le poids buteur-passeur-carton sans tactique.
 */
const MAP_TOKEN_ROLE = { GB: 'GB', D: 'D', DL: 'D', MD: 'MD', M: 'MD', MO: 'MO', AL: 'AL', BT: 'BT' };

function inferRolePrincipal(joueurRow) {
  const brut = joueurRow?.poste_brut || '';
  const premierSegment = brut.split(',')[0] || '';
  const tokenPoste = premierSegment.split('(')[0].trim();
  const premierToken = tokenPoste.split('/')[0].trim().toUpperCase();
  return MAP_TOKEN_ROLE[premierToken] || 'MD';
}

/**
 * Un joueur peut-il tenir le rôle `role` (clé PROFILS_ROLE, ex. "MO", "BT") ?
 * Contrairement à inferRolePrincipal (qui ne regarde que le tout premier
 * poste listé, pour estimer un rôle par défaut sur le banc), celle-ci
 * parcourt TOUT `poste_brut` (ex. "AL/M (G), MO (GC), BT (C)") pour savoir
 * si le joueur est éligible à un poste précis de la compo — utilisé pour
 * choisir un remplaçant au même poste qu'un titulaire désigné.
 */
function joueurPeutJouerRole(joueurRow, role) {
  const brut = joueurRow?.poste_brut || '';
  const segments = brut.split(',');
  for (const segment of segments) {
    const tokenPoste = segment.split('(')[0].trim();
    const tokens = tokenPoste.split('/').map((t) => t.trim().toUpperCase());
    for (const token of tokens) {
      if (MAP_TOKEN_ROLE[token] === role) return true;
    }
  }
  return false;
}

/**
 * Rôles "proches" d'un rôle donné, tactiquement acceptables en dépannage
 * quand AUCUN joueur de l'effectif n'est tagué pour le rôle exact (cas d'un
 * effectif trop juste sur un poste précis, ex: un seul "AL" dans tout le
 * groupe) — sans ce repli, le slot restait explicitement "Poste non pourvu"
 * et l'équipe démarrait le match à 10 ou 9, MÊME sans aucun blessé/suspendu
 * (bug observé : effectif Salernitana au complet, poste laissé vide faute de
 * candidat exactement tagué). Le gardien et l'attaquant de pointe n'ont pas
 * de repli : jouer un joueur de champ dans les buts (ou l'inverse) reste un
 * cas d'urgence bien plus rare/dégradé qu'un latéral dépanné en défenseur
 * axial ou un milieu offensif reculé d'un cran, donc volontairement exclu ici.
 */
const ROLES_PROCHES = {
  GB: [],
  D: ['AL'],
  AL: ['D'],
  MD: ['MO'],
  MO: ['MD'],
  BT: [],
};

/**
 * Un joueur est-il disponible pour un rôle, en repli, si aucun joueur de
 * l'effectif ne porte le tag exact ? Renvoie true pour un rôle tactiquement
 * proche (cf. ROLES_PROCHES) — ne dit rien sur le rôle exact, à tester en
 * premier via `joueurPeutJouerRole`.
 */
function joueurPeutJouerRoleEnRepli(joueurRow, role) {
  return (ROLES_PROCHES[role] || []).some((r) => joueurPeutJouerRole(joueurRow, r));
}

/**
 * Filtre l'effectif dispo pour un rôle donné (hors blessés/suspendus/déjà
 * utilisés), en essayant d'abord le tag exact puis, seulement si personne ne
 * correspond, les rôles proches (cf. ROLES_PROCHES) — c'est ce repli qui
 * évite les "Poste non pourvu" évitables quand l'effectif est juste sur un
 * poste précis mais a des joueurs compatibles à côté.
 * @returns {{ pool: Array, enRepli: boolean }}
 */
function poolDisponiblePourRole(role, joueurs, idsExclus) {
  const exclus = new Set(idsExclus);
  const dispo = joueurs.filter(
    (j) => !exclus.has(j.id) && (j.blessure_jours ?? 0) === 0 && j.statut_special !== 'Sus'
  );
  const exact = dispo.filter((j) => joueurPeutJouerRole(j, role));
  if (exact.length) return { pool: exact, enRepli: false };
  const repli = dispo.filter((j) => joueurPeutJouerRoleEnRepli(j, role));
  return { pool: repli, enRepli: repli.length > 0 };
}

// ============================================================
// PROFIL TACTIQUE DES ÉQUIPES (style, mentalité, pressing, ligne)
// Alimente le mismatch tactique (étape 1bis) à partir de `tactiques`
// (style_tactique, mentalite, type_pressing, instructions.ligne/rythme).
// ============================================================

/** Axes 0-1 (sauf mention contraire) par grande famille de style de jeu. */
const AXES_STYLE = {
  Gegenpress: { possession: 0.45, directness: 0.5, pressing: 0.95, risque: 0.75 },
  'Contrôle de la possession': { possession: 0.9, directness: 0.15, pressing: 0.35, risque: 0.3 },
  'Jeu ultra-défensif': { possession: 0.25, directness: 0.3, pressing: 0.15, risque: 0.05 },
  'Tiki-Taka vertical': { possession: 0.8, directness: 0.5, pressing: 0.45, risque: 0.55 },
  'Tiki-Taka': { possession: 0.95, directness: 0.1, pressing: 0.3, risque: 0.35 },
  'Jeu sur les ailes': { possession: 0.55, directness: 0.55, pressing: 0.4, risque: 0.5 },
  Catenaccio: { possession: 0.3, directness: 0.35, pressing: 0.15, risque: 0.05 },
  'Contre-attaques fluides': { possession: 0.3, directness: 0.8, pressing: 0.3, risque: 0.55 },
  'Longs ballons devant': { possession: 0.2, directness: 0.95, pressing: 0.35, risque: 0.5 },
  'Contre-attaques directes': { possession: 0.25, directness: 0.9, pressing: 0.25, risque: 0.6 },
  '-': { possession: 0.5, directness: 0.5, pressing: 0.4, risque: 0.4 },
};
const STYLE_DEFAUT = AXES_STYLE['-'];

const MENTALITE_AXE = { 'Très prudent': -2, Prudent: -1, Équilibré: 0, Offensive: 1, Aventureux: 2 };
const PRESSING_AXE = { 'Moins souvent': -0.15, Équilibré: 0, 'Plus souvent': 0.15 };
const LIGNE_AXE = { Basse: -1, Médiane: 0, Haute: 1 };
const RYTHME_AXE = { Lent: -1, Modéré: 0, Rapide: 1 };

/** Traduit une ligne `tactiques` (style, mentalité, pressing, instructions) en profil numérique comparable. */
function profilTactique(tactique) {
  const base = AXES_STYLE[tactique?.style_tactique] || STYLE_DEFAUT;
  const mentaliteAxe = MENTALITE_AXE[tactique?.mentalite] ?? 0;
  const pressingAxe = PRESSING_AXE[tactique?.type_pressing] ?? 0;
  const ligneAxe = LIGNE_AXE[tactique?.instructions?.ligne] ?? 0;
  const rythmeAxe = RYTHME_AXE[tactique?.instructions?.rythme] ?? 0;

  return {
    possession: clamp(base.possession + mentaliteAxe * 0.04, 0, 1),
    directness: clamp(base.directness + mentaliteAxe * 0.03 + rythmeAxe * 0.08, 0, 1),
    pressing: clamp(base.pressing + pressingAxe * 0.35, 0, 1),
    risque: clamp(base.risque + mentaliteAxe * 0.08, 0, 1),
    ligne: ligneAxe,
    mentaliteAxe,
  };
}

/**
 * Mismatch tactique de l'équipe "pour" contre l'équipe "adverse" : combine
 * trois lectures classiques du jeu (pressing qui casse la possession adverse,
 * ligne haute exposée à un jeu direct/rapide, écart de mentalité qui ouvre
 * ou ferme le match), le tout modulé par le niveau tactique du coach qui
 * exécute le plan et amorti par la capacité d'adaptation du coach adverse.
 *
 * @returns {{ bonusDanger: number, malusExposition: number }} deltas (points, échelle ~0-100) à appliquer au danger/attaque de l'équipe "pour".
 */
function calculerMismatchTactique(profilPour, profilAdverse, niveauCoachPour, niveauCoachAdverse) {
  // Pressing qui prend le dessus sur une équipe qui cherche à construire au sol
  const ecartPressingPossession = profilPour.pressing - profilAdverse.possession;
  const bonusRecuperationHaute = clamp(ecartPressingPossession, -0.5, 0.5) * 6;

  // Ligne défensive haute exposée si l'adversaire joue vite et direct
  const expositionDansLeDos = profilAdverse.directness * clamp(profilPour.ligne, 0, 1);
  const malusLigneHaute = expositionDansLeDos * 5;

  // Écart de mentalité : plus le fossé est grand, plus l'équipe la plus entreprenante prend l'ascendant
  const ecartMentalite = profilPour.mentaliteAxe - profilAdverse.mentaliteAxe;
  const bonusPriseDeRisque = clamp(ecartMentalite, -4, 4) * 0.8;

  const facteurExecution = clamp(0.5 + niveauCoachPour * 0.6, 0.5, 1.15);
  const facteurAdaptationAdverse = clamp(1.15 - niveauCoachAdverse * 0.3, 0.75, 1.1);

  const bonusDanger = (bonusRecuperationHaute + bonusPriseDeRisque) * facteurExecution * facteurAdaptationAdverse;
  const malusExposition = malusLigneHaute * facteurExecution;

  return {
    bonusDanger: clamp(bonusDanger, -8, 8),
    malusExposition: clamp(malusExposition, 0, 8),
  };
}

// ============================================================
// ÉTAPE 1 — FORCE DES ÉQUIPES
// ============================================================

/**
 * Note individuelle (0-100) d'un joueur pour le contexte du match,
 * à partir de son CA (niveau_actuel), ses attributs clés selon son
 * rôle dans la compo, sa forme, son moral et une pénalité de blessure.
 */
function noteJoueurMatch(joueurRow, role) {
  const profil = profilRole(role);
  const attrs = profil.attributsCles
    .map((a) => joueurRow[a])
    .filter((v) => typeof v === 'number');
  const noteAttributs = attrs.length ? moyenne(attrs) * 5 : 50; // attributs 1-20 -> /100

  const ca = clamp(joueurRow.niveau_actuel ?? joueurRow.ca ?? 100, 1, 200) / 2; // -> /100
  const forme = clamp(joueurRow.forme ?? 100, 0, 150) / 100; // multiplicateur ~0.5-1.5
  const moral = clamp(joueurRow.moral ?? 100, 0, 150) / 100;

  // Le CA est plus discriminant que la moyenne des attributs bruts (qui reste
  // souvent élevée même pour un joueur de bas niveau) : on lui donne plus de poids.
  let note = noteAttributs * 0.4 + ca * 0.6;

  // Étirement de l'écart autour d'un point central pour éviter que les niveaux
  // très différents (National vs. classe mondiale) ne s'écrasent trop entre eux.
  const CENTRE = 50;
  const FACTEUR_ETIREMENT = 1.35;
  note = CENTRE + (note - CENTRE) * FACTEUR_ETIREMENT;

  note *= 0.85 + 0.15 * forme; // la forme pèse pour 15%
  note *= 0.92 + 0.08 * moral; // le moral pèse pour 8%

  // Régularité (attribut 1-20, ex. joueurs.regularite / players.regularite) : un joueur peu
  // régulier livre des prestations beaucoup plus dispersées d'un match à l'autre qu'un joueur
  // très régulier. Écart-type ~1.5 pt pour regularite=20, ~11 pts pour regularite=1.
  const regularite = clamp(joueurRow.regularite ?? 11, 1, 20);
  const ecartTypeJournalier = clamp(13 - regularite * 0.55, 1.5, 12);
  note += bruitGaussien(ecartTypeJournalier * 0.4);

  if ((joueurRow.blessure_jours ?? 0) > 0) note *= 0.5; // ne devrait pas être titulaire, garde-fou

  return clamp(note, 1, 100);
}

/**
 * Force globale d'une équipe pour le match : agrège joueurs titulaires
 * (via tactique.compositions), la cohésion tactique, le staff et le contexte.
 *
 * @param {object} p
 * @param {Array}  p.compositions - tactique.compositions (11 entrées avec player_id, role)
 * @param {Array}  p.joueurs - game_players du club (pour retrouver les attributs par id)
 * @param {object} p.tactique - ligne tactiques (connaissance_tactique, instructions)
 * @param {object} p.coach - ligne game_staff jointe à `staff` (niveau_tactique, niveau_attaque,
 *   niveau_defense, adaptabilite) ou null. NB : ces attributs vivent sur `staff` (via
 *   tactique.coach_staff_ref), pas sur `game_staff` — la couche de fetch doit faire la jointure.
 * @param {object} p.club - ligne clubs/game_clubs (reputation, niveau_pct, capacite_stade, affluence_moyenne)
 * @param {object} [p.groupe] - ligne `dynamique_groupe` du club (note_globale 0-100) ou null
 * @param {object} p.contexte - { domicile, enjeu (0-1), meteo }
 */
function calculerForceEquipe({ compositions, joueurs, tactique, coach, club, groupe, contexte }) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));

  const titulairesNotes = compositions.map((slot) => {
    const jr = joueursParId.get(slot.player_id);
    if (!jr) return { slot, note: 50, categorie: profilRole(slot.role).categorie };
    return { slot, note: noteJoueurMatch(jr, slot.role), categorie: profilRole(slot.role).categorie, joueur: jr };
  });

  const noteEffectif = moyenne(titulairesNotes.map((t) => t.note));

  // Dynamique de groupe (table dynamique_groupe : moral, ancienneté, leadership, stabilité du
  // coach, cohésion linguistique...) synthétisée en une note 0-100 déjà calculée côté dashboard.
  const dynGroupe = clamp((groupe?.note_globale ?? 60) / 100, 0.3, 1.15);

  // Cohésion collective : familiarité tactique (fit_score moyen des slots), connaissance
  // tactique du coach, et dynamique de groupe de l'effectif.
  const fitScoreMoyen = moyenne(compositions.map((c) => c.fit_score ?? 2)) / 3; // fit_score 0-3
  const connaissanceTactique = clamp((tactique?.connaissance_tactique ?? 12) / 20, 0, 1);
  const cohesion = clamp(0.5 + 0.22 * fitScoreMoyen + 0.13 * connaissanceTactique + 0.15 * dynGroupe, 0.5, 1.2);

  // Staff : niveau tactique du coach module la note d'ensemble
  const niveauCoach = coach
    ? clamp(((coach.niveau_tactique ?? 12) + (coach.niveau_attaque ?? 12) + (coach.niveau_defense ?? 12)) / 3 / 20, 0.4, 1)
    : 0.7;
  const adaptabiliteCoach = coach ? clamp((coach.adaptabilite ?? 12) / 20, 0.3, 1) : 0.6;

  // Contexte : avantage du terrain modulé par le taux de remplissage du stade et l'enjeu du
  // match (plus le stade est plein et l'enjeu élevé, plus le public pèse), et par la dynamique
  // de groupe du club recevant (un vestiaire en délicatesse profite moins de la ferveur du public).
  // À l'extérieur, une dynamique de groupe fragile pèse un peu plus lourd (moins de solidarité loin de ses bases).
  const remplissageStade = club?.capacite_stade
    ? clamp((club.affluence_moyenne ?? club.capacite_stade * 0.7) / club.capacite_stade, 0.25, 1)
    : 0.7;
  const ferveurPublique = 0.5 + remplissageStade * 0.5; // 0.625 - 1
  // Poids de l'avantage domicile/extérieur relevé (avant : 1.02-1.17 dom /
  // 0.9-0.99 ext, un écart trop resserré pour bien peser dans la force
  // finale). Les coefficients de ferveur/enjeu/dynGroupe sont eux aussi
  // relevés, et le plancher extérieur abaissé (0.9 -> 0.84) pour qu'un
  // déplacement difficile (vestiaire fragile, faible ferveur adverse) pèse
  // vraiment sur une équipe déjà moins bien classée.
  const bonusDomicile = contexte?.domicile
    ? clamp(1 + 0.075 * ferveurPublique + 0.04 * (contexte?.enjeu ?? 0) + 0.04 * (dynGroupe - 0.7), 1.03, 1.22)
    : clamp(0.97 - 0.045 * (1 - dynGroupe), 0.84, 0.98);
  const facteurEnjeu = 1 - (contexte?.enjeu ?? 0) * 0.04; // grosse pression = petite baisse de rendement moyen
  const facteurMeteo = contexte?.meteo && contexte.meteo !== 'normale' ? 0.97 : 1;

  const noteGlobale = clamp(
    noteEffectif * cohesion * (0.85 + 0.15 * niveauCoach) * bonusDomicile * facteurEnjeu * facteurMeteo,
    1,
    100
  );

  // Sous-notes utiles pour la suite (domination/occasions)
  const parCategorie = (cat) => {
    const notes = titulairesNotes.filter((t) => t.categorie === cat).map((t) => t.note);
    return notes.length ? moyenne(notes) : noteEffectif;
  };

  return {
    noteGlobale,
    noteAttaque: (parCategorie('attaquant') * 0.42 + parCategorie('milieu_offensif') * 0.58),
    noteMilieu: (parCategorie('milieu') * 0.5 + parCategorie('milieu_offensif') * 0.5),
    noteDefense: (parCategorie('defenseur') * 0.7 + parCategorie('milieu') * 0.3),
    noteGardien: parCategorie('gardien'),
    titulairesNotes,
    niveauCoach,
    adaptabiliteCoach,
  };
}

// ============================================================
// ÉTAPE 2 — DOMINATION
// ============================================================

/**
 * Détermine possession / intensité de chaque équipe à partir de leur force.
 * Une équipe plus forte domine statistiquement plus souvent, sans certitude.
 *
 * @param {object} [mismatchDom] - { bonusDanger, malusExposition } du point de vue du domicile (cf. calculerMismatchTactique)
 * @param {object} [mismatchExt] - idem côté extérieur
 * @param {object} [profilDom] - profilTactique(domicile.tactique), pour l'axe possession du style
 * @param {object} [profilExt] - profilTactique(exterieur.tactique), idem extérieur
 */
function calculerDomination(forceDom, forceExt, mismatchDom = null, mismatchExt = null, profilDom = null, profilExt = null) {
  const diff = forceDom.noteGlobale - forceExt.noteGlobale; // typiquement -60..+60
  const bruit = bruitGaussien(6); // variabilité match à match
  const diffAjuste = diff + bruit;

  // Possession "de force" : l'équipe la plus forte tend à avoir plus le
  // ballon. Coefficient relevé (0.58 -> 0.70) pour qu'un vrai mismatch (type
  // PSG-Metz) se traduise par une possession très nettement déséquilibrée,
  // pas un simple 58-42 qui gomme l'écart réel de niveau.
  const possessionForceDom = 50 + diffAjuste * 0.70;

  // Possession "de style" : jusqu'ici le style tactique (Tiki-Taka, Longs
  // ballons devant, Contre-attaques directes...) ne pesait QUE sur le danger
  // via calculerMismatchTactique, jamais sur la possession elle-même — deux
  // équipes de force égale mais de philosophie opposée finissaient donc
  // systématiquement autour de 50-50, ce qui n'a pas de sens (une équipe en
  // "Longs ballons devant" cherche activement MOINS le ballon).
  const ecartStylePossession = (profilDom?.possession ?? 0.5) - (profilExt?.possession ?? 0.5); // ~-0.75..0.75 en pratique
  const possessionStyleDom = 50 + ecartStylePossession * 40;

  // Le style pèse un peu moins que la force pure, mais reste un contributeur
  // net (avant : poids nul). Bornes élargies (14-86 au lieu de 22-78) pour
  // permettre aux vrais mismatchs (force ET style alignés) de sortir des
  // possessions très déséquilibrées, comme en vrai.
  const possessionBrute = possessionForceDom * 0.62 + possessionStyleDom * 0.38;
  // Bornes élargies (14-86 -> 8-92) : un très gros mismatch de force (grosse
  // écurie à domicile contre lanterne rouge à l'extérieur) doit pouvoir
  // produire une possession très largement à sens unique, cohérente avec
  // l'écrasement statistique attendu dans ce cas.
  const possessionDom = clamp(possessionBrute, 8, 92);
  const possessionExt = 100 - possessionDom;

  // Pression/occasions dépendent surtout de l'attaque adverse vs milieu/défense, ajustées par
  // le mismatch tactique (pressing qui casse la construction adverse, ligne haute exposée, écart
  // de mentalité qui ouvre le match).
  const ajustDom = (mismatchDom?.bonusDanger ?? 0) - (mismatchExt?.malusExposition ?? 0);
  const ajustExt = (mismatchExt?.bonusDanger ?? 0) - (mismatchDom?.malusExposition ?? 0);

  // Choc de forme du jour : LA source de variabilité "physionomie du match",
  // un par équipe, tiré une seule fois puis réutilisé partout où cette équipe
  // intervient (danger ci-dessous, ET les perfs individuelles côté
  // simulerMatch/calculerNotesJoueurs) — plutôt que d'avoir un bruit
  // indépendant à chaque métrique, ce qui décorrèle artificiellement les
  // stats d'équipe et les stats individuelles d'un même match (une équipe qui
  // écrase le match côté stats globales doit aussi gagner davantage de duels
  // individuels ce jour-là, pas un tirage complètement déconnecté).
  const chocFormeDom = bruitGaussien(9);
  const chocFormeExt = bruitGaussien(9);

  // Coefficient et bornes relevés (0.5 -> 0.62, 15-92 -> 8-96), en miroir de
  // la possession ci-dessus : un gros écart d'attaque/défense doit se voir
  // nettement dans le danger généré, pas être écrasé par le plafond.
  const dangerDom = clamp(50 + (forceDom.noteAttaque - forceExt.noteDefense) * 0.62 + ajustDom + chocFormeDom, 8, 96);
  const dangerExt = clamp(50 + (forceExt.noteAttaque - forceDom.noteDefense) * 0.62 + ajustExt + chocFormeExt, 8, 96);

  return {
    possession: { domicile: Math.round(possessionDom), exterieur: Math.round(possessionExt) },
    danger: { domicile: dangerDom, exterieur: dangerExt },
    chocForme: { domicile: chocFormeDom, exterieur: chocFormeExt },
  };
}

// ============================================================
// ÉTAPE 3 — STATISTIQUES DU MATCH
// ============================================================

/** Génère un bloc de stats cohérent pour UNE équipe à partir de sa domination. */
function genererStatsEquipe(possessionPct, dangerScore, forceAttaque, forceDefenseAdverse) {
  // Occasions franches : proportionnelles au danger créé
  const occasionsFranches = clamp(Math.round(dangerScore / 11 + bruitGaussien(0.6)), 0, 10);

  // Tirs totaux >= occasions franches (les occasions franches sont un sous-ensemble des tirs)
  const tirsBonus = tiragePoisson(clamp(dangerScore / 22, 0.3, 5));
  const tirs = occasionsFranches + tirsBonus;

  // Tirs cadrés : dépend de la qualité technique de l'attaque (pas juste du
  // volume). Base et multiplicateur relevés (0.25->0.32, 0.35->0.4) pour que
  // le volume moyen de tirs cadrés colle à un match réel (~4-5/équipe) —
  // sans ce relevage, le taux de conversion resserré (cf calculerButsEquipe)
  // faisait chuter la moyenne de buts sous les standards du foot réel.
  const precisionAttaque = clamp(forceAttaque / 100, 0.2, 0.95);
  let tirsCadres = 0;
  for (let i = 0; i < tirs; i++) if (proba(0.32 + precisionAttaque * 0.4)) tirsCadres++;
  tirsCadres = Math.min(tirsCadres, tirs);

  const corners = clamp(Math.round(dangerScore / 16 + bruitGaussien(1)), 0, 12);
  const horsJeu = clamp(Math.round((forceAttaque / 100) * 3 + bruitGaussien(1)), 0, 8);
  const centres = clamp(Math.round(corners * 1.3 + dangerScore / 10 + bruitGaussien(1.5)), 0, 30);

  // Passes réussies : corrélées à la possession et au niveau technique
  const passesReussies = clamp(Math.round(possessionPct * 4.2 + (forceAttaque - 50) * 1.5 + bruitGaussien(15)), 120, 750);

  const fautes = clamp(Math.round(10 - possessionPct / 12 + bruitGaussien(1.5)), 3, 20);

  // Arrêts du gardien adverse ≈ tirs cadrés qui ne finissent pas au fond (calculés après les buts, cf étape 4)
  return {
    possession: Math.round(possessionPct),
    tirs,
    tirs_cadres: tirsCadres,
    occasions_franches: occasionsFranches,
    corners,
    hors_jeu: horsJeu,
    passes_reussies: passesReussies,
    centres,
    fautes,
  };
}

function genererStatistiques(domination, forceDom, forceExt) {
  const statsDom = genererStatsEquipe(domination.possession.domicile, domination.danger.domicile, forceDom.noteAttaque, forceExt.noteDefense);
  const statsExt = genererStatsEquipe(domination.possession.exterieur, domination.danger.exterieur, forceExt.noteAttaque, forceDom.noteDefense);
  return { domicile: statsDom, exterieur: statsExt };
}

/**
 * Recale les stats d'équipe (générées à l'étape 3, donc AVANT que les buts ne
 * soient connus à l'étape 4) sur la physionomie du score final. Sans ce
 * correctif, le score et les stats sont deux tirages quasi indépendants : un
 * 4-0 pouvait afficher une possession 52-48, ce qui n'arrive jamais dans un
 * vrai match — un tel écart de buts laisse presque toujours une trace nette
 * sur la possession, le volume de tirs, etc.
 *
 * La correction est bornée et partiellement aléatoire (pas un simple
 * "forçage" déterministe) pour laisser passer les scénarios plausibles mais
 * atypiques : une victoire clinique à contre-courant du jeu (peu de
 * possession, décisif sur ses seules occasions) doit rester possible, juste
 * beaucoup plus rare qu'avant.
 */
function recalibrerStatsSelonScore(stats, scoreDom, scoreExt) {
  const margeButs = scoreDom - scoreExt;
  if (margeButs === 0) return; // match nul : rien à recaler

  const gagnant = margeButs > 0 ? 'domicile' : 'exterieur';
  const perdant = gagnant === 'domicile' ? 'exterieur' : 'domicile';
  const butsGagnant = gagnant === 'domicile' ? scoreDom : scoreExt;
  const marge = Math.abs(margeButs);

  // Amplitude plafonnée et amortie (racine) : un 5-0 n'est pas 2.5x plus
  // "lopsided" qu'un 2-0 en termes de possession — la différence marginale
  // se réduit avec l'écart de buts, comme dans la réalité. Plafond relevé
  // (16 -> 20) pour matcher les nouvelles bornes de possession de l'étape 2
  // (8-92 au lieu de 14-86) : un match à sens unique (mismatch de force ET
  // score qui va avec) doit pouvoir afficher une domination écrasante.
  const ampleurBase = clamp(Math.sqrt(marge) * 7.5, 0, 20);
  // Facteur aléatoire : laisse ~20-30% des gros écarts se dérouler sans
  // correction extrême (le fameux "score flatteur" ou la victoire clinique).
  const facteurAlea = clamp(0.5 + Math.random() * 0.7, 0.5, 1.2);
  const skewPossession = ampleurBase * facteurAlea;

  const nouvellePossGagnant = clamp(stats[gagnant].possession + skewPossession, 8, 92);
  stats[gagnant].possession = Math.round(nouvellePossGagnant);
  stats[perdant].possession = Math.round(100 - stats[gagnant].possession);

  // Munitions offensives du vainqueur : un taux de conversion sur tirs
  // cadrés crédible tourne autour de 40-55%, jamais un quasi 1-pour-1comme
  // pouvaient le laisser passer les anciens tirages indépendants (ex. "5
  // tirs cadrés, 4 buts"). On garantit donc un minimum de tirs cadrés (et de
  // tirs tout court) cohérent avec le nombre de buts marqués.
  const tauxConversionPlancher = 0.42 + Math.random() * 0.15;
  const cadresMin = Math.ceil(butsGagnant / tauxConversionPlancher);
  if (stats[gagnant].tirs_cadres < cadresMin) {
    const ajoutCadres = cadresMin - stats[gagnant].tirs_cadres;
    stats[gagnant].tirs_cadres = cadresMin;
    stats[gagnant].tirs += ajoutCadres + tiragePoisson(1.2); // + quelques tirs non cadrés en plus
  }
  stats[gagnant].occasions_franches = clamp(
    Math.max(stats[gagnant].occasions_franches, Math.ceil(butsGagnant * 0.7)),
    0,
    stats[gagnant].tirs_cadres
  );

  // Le perdant d'une correction lourde (3 buts d'écart ou plus) a
  // statistiquement moins pesé offensivement : léger tassement de son volume
  // de tirs, jamais jusqu'à zéro (garde une trame de match plausible — même
  // une équipe qui prend 4 n'est pas restée sans se procurer une occasion).
  if (marge >= 3) {
    // Tassement accentué (pente 0.08 -> 0.11, plancher 0.6 -> 0.48) : une
    // équipe ULTRA dominée (gros mismatch de force qui débouche sur une
    // déroute) doit voir son volume offensif vraiment fondre, pas juste
    // légèrement s'éroder — jusqu'ici un 5-0 gardait encore l'essentiel de
    // son volume de tirs, ce qui ne racontait pas la même histoire qu'un
    // match à sens unique.
    const tassement = clamp(1 - (marge - 2) * 0.11, 0.48, 1);
    stats[perdant].tirs = Math.max(1, Math.round(stats[perdant].tirs * tassement));
    stats[perdant].tirs_cadres = Math.min(stats[perdant].tirs_cadres, stats[perdant].tirs);
    stats[perdant].occasions_franches = Math.min(stats[perdant].occasions_franches, stats[perdant].tirs);
    // Les passes/corners suivent la même débâcle : un perdant écrasé qui ne
    // voit quasi plus le ballon touche aussi moins de corners que la
    // moyenne générée à l'étape 3 (avant que le score ne soit connu).
    stats[perdant].corners = Math.max(0, Math.round(stats[perdant].corners * tassement));
  }

  // Les passes réussies suivent la possession recalibrée (même logique que
  // dans genererStatsEquipe : ~4.2 passes par point de possession).
  stats[gagnant].passes_reussies = clamp(Math.round(stats[gagnant].passes_reussies + skewPossession * 4), 120, 750);
  stats[perdant].passes_reussies = clamp(Math.round(stats[perdant].passes_reussies - skewPossession * 3), 120, 750);

  // Garde-fou final : tirs >= tirs cadrés doit toujours tenir après ces ajustements.
  stats.domicile.tirs = Math.max(stats.domicile.tirs, stats.domicile.tirs_cadres);
  stats.exterieur.tirs = Math.max(stats.exterieur.tirs, stats.exterieur.tirs_cadres);
}

// ============================================================
// ÉTAPE 4 — CALCUL DES BUTS
// ============================================================

/**
 * Repère, parmi les titulaires attaquants/milieux offensifs (BT/MO — les
 * "purs" buteurs, ailiers compris), le meilleur instinct de but individuel
 * (finition, sang-froid, jeu de tête, un-contre-un), ramené sur 0-100. Sert
 * à tirer la qualité de finition d'une équipe au-delà de sa seule moyenne
 * collective : un vrai grand avant-centre change la donne même dans une
 * attaque par ailleurs quelconque.
 */
function meilleurInstinctButeur(titulairesNotes) {
  const candidats = titulairesNotes.filter((t) => t.categorie === 'attaquant' || t.categorie === 'milieu_offensif');
  if (!candidats.length) return 50;

  const scores = candidats.map((t) => {
    const jr = t.joueur;
    if (!jr) return 50;
    const finition = jr.finition ?? 10;
    const sangFroid = jr.sang_froid ?? 10;
    const jeuDeTete = jr.jeu_de_tete ?? 10;
    const appelsDeBalle = jr.appels_de_balle ?? 10;
    const instinct = finition * 0.45 + sangFroid * 0.35 + jeuDeTete * 0.1 + appelsDeBalle * 0.1; // /20
    return clamp(instinct * 5, 1, 100); // -> /100
  });

  return Math.max(...scores);
}

/**
 * Qualité aérienne défensive d'une équipe (moyenne jeu de tête + puissance de
 * ses défenseurs titulaires, D et AL) — sert à réduire spécifiquement la
 * probabilité qu'un but de la tête (corner/coup de pied arrêté) soit inscrit
 * par l'équipe adverse : une défense qui gagne bien ses duels aériens encaisse
 * moins de buts de ce type précis, même si sa qualité défensive générale
 * (qui fixe déjà le nombre total de buts encaissés) reste inchangée.
 */
function qualiteAerienneDefense(titulairesNotes) {
  const defenseurs = titulairesNotes.filter((t) => t.categorie === 'defenseur');
  if (!defenseurs.length) return 50;

  const scores = defenseurs.map((t) => {
    const jr = t.joueur;
    if (!jr) return 50;
    const jeuDeTete = jr.jeu_de_tete ?? 10;
    const puissance = jr.puissance ?? 10;
    return clamp((jeuDeTete * 0.7 + puissance * 0.3) * 5, 1, 100); // /20 -> /100
  });

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Convertit les occasions franches en buts, occasion par occasion, selon la
 * qualité de finition de l'équipe (attaque collective ET meilleur finisseur
 * individuel) contre la défense adverse dans son ensemble (défenseurs +
 * gardien, pas juste le gardien).
 * Retourne { buts, arrets } pour l'équipe attaquante.
 */
/**
 * Convertit les occasions franches en buts, occasion par occasion, selon la
 * qualité de finition de l'équipe (attaque collective ET meilleur finisseur
 * individuel) contre la défense adverse dans son ensemble (défenseurs +
 * gardien, pas juste le gardien).
 *
 * `minuteExpulsionEquipe`/`minuteExpulsionAdverse` (optionnels) : si l'une
 * des deux équipes a un joueur expulsé, chaque occasion est resituée sur les
 * 90 minutes pour savoir si l'expulsion est déjà survenue à cet instant :
 *  - sa propre expulsion réduit sa qualité de finition (animation collective
 *    dégradée, options offensives en moins) pour le reste du match ;
 *  - l'expulsion adverse réduit la qualité défensive adverse (plus d'espaces,
 *    défense prise à 10) pour le reste du match.
 * Ne modifie pas le NOMBRE d'occasions généré (fixé plus tôt, indépendamment
 * des cartons) — seulement leur taux de conversion à partir de l'expulsion.
 *
 * Retourne { buts, arrets } pour l'équipe attaquante.
 */
function calculerButsEquipe(statsEquipe, forceAttaque, meilleurFinisseur, qualiteDefenseAdverse, contexte, minuteExpulsionEquipe = null, minuteExpulsionAdverse = null) {
  // Seul un tir CADRÉ peut finir au fond des filets : c'est lui qui borne le
  // nombre d'occasions à convertir, jamais les occasions franches prises
  // isolément (une occasion franche peut très bien finir non cadrée).
  // Avant ce correctif, nbOccasionsAConvertir pouvait dépasser tirs_cadres
  // (il prenait le plus grand des deux), et le score final était ensuite
  // tronqué en aval par un simple Math.min(buts, tirs_cadres) — ce troncage
  // gonflait artificiellement le taux de conversion affiché et produisait des
  // lignes de stats irréalistes du type "5 tirs cadrés, 4 buts".
  const nbTirsCadres = Math.max(0, Math.round(statsEquipe.tirs_cadres));
  // Parmi ces tirs cadrés, certains sont des occasions franches (plus
  // faciles à convertir) ; le reste, des tentatives cadrées plus disputées
  // (finition à distance, angle fermé...) — la finition de match doit
  // distinguer les deux plutôt que traiter chaque tir cadré à égalité.
  const nbFranchesCadrees = clamp(Math.round(statsEquipe.occasions_franches), 0, nbTirsCadres);

  let buts = 0;
  let arrets = 0;

  // Le meilleur finisseur tire la qualité de finition au-delà de la seule
  // moyenne d'équipe (45% de poids) : un grand avant-centre pèse lourd même
  // dans une attaque autrement moyenne.
  const qualiteFinitionBase = clamp((forceAttaque * 0.45 + meilleurFinisseur * 0.55) / 100, 0.1, 0.98);
  const qualiteDefenseBase = clamp(qualiteDefenseAdverse / 100, 0.1, 0.95);
  const facteurPression = 1 - (contexte?.enjeu ?? 0) * 0.05;

  for (let i = 0; i < nbTirsCadres; i++) {
    const estOccasionFranche = i < nbFranchesCadrees;

    // Répartit les tentatives uniformément sur les 90 minutes pour situer
    // chacune par rapport aux éventuelles expulsions.
    const minuteOccasion = ((i + 0.5) / nbTirsCadres) * 90;

    let qualiteFinition = qualiteFinitionBase;
    let qualiteDefense = qualiteDefenseBase;
    if (minuteExpulsionEquipe !== null && minuteOccasion >= minuteExpulsionEquipe) {
      qualiteFinition *= 0.8;
    }
    if (minuteExpulsionAdverse !== null && minuteOccasion >= minuteExpulsionAdverse) {
      qualiteDefense *= 0.78;
    }

    // Base différenciée : une occasion franche cadrée (0.27) se transforme
    // nettement plus souvent qu'un tir cadré "disputé" (0.16). Coefficient
    // d'écart relevé (0.5 -> 0.62) et plafond légèrement remonté (0.58 ->
    // 0.63) : contre une défense très inférieure (gros mismatch), la
    // qualité de finition doit peser plus lourd pour que le score final
    // traduise vraiment la correction, pas seulement le volume de tirs.
    const base = estOccasionFranche ? 0.31 : 0.17;
    const probaBut = clamp(base + (qualiteFinition - qualiteDefense) * 0.62, 0.05, 0.63) * facteurPression;
    if (proba(probaBut)) {
      buts++;
    } else if (proba(0.55)) {
      arrets++; // tir cadré mais arrêté
    }
    // sinon : tir contré / repoussé, ni but ni arrêt
  }

  return { buts, arrets };
}

// ============================================================
// ÉTAPE 4bis — BANC ET REMPLACEMENTS (5 max)
// ============================================================

/**
 * Sélectionne les meilleurs remplaçants disponibles (joueurs équipe_a du club
 * qui ne sont PAS dans les 11 titulaires), au plus `max` (5, règle du jeu).
 * `joueurs` doit contenir tout l'effectif équipe_a du club (pas que les titulaires).
 */
function selectionnerBanc(compositions, joueurs, max = 5) {
  const idsTitulaires = new Set(compositions.map((c) => c.player_id));
  const candidats = joueurs.filter(
    (j) => !idsTitulaires.has(j.id) && (j.blessure_jours ?? 0) <= 0 && j.statut_special !== 'Sus'
  );

  const evalues = candidats.map((jr) => {
    const role = inferRolePrincipal(jr);
    return { joueur: jr, role, note: noteJoueurMatch(jr, role) };
  });
  evalues.sort((a, b) => b.note - a.note);
  return evalues.slice(0, max);
}

/**
 * Génère jusqu'à 5 changements pour une équipe.
 *
 * Deux sources de changement, fusionnées et plafonnées à 5 au total (règle du jeu) :
 *  1. `sortiesForcees` (prioritaires) : joueurs blessés dont la blessure exige une
 *     sortie immédiate (cf. ÉTAPE 8). Remplacés dès que possible par le meilleur
 *     profil dispo au poste le plus proche (cas du gardien : cherché dans TOUT le
 *     banc, y compris les gardiens, normalement exclus des rotations classiques).
 *     Si le banc est épuisé ou les 5 fenêtres déjà utilisées, l'équipe termine
 *     avec un joueur diminué (pas de changement possible).
 *  2. Changements tactiques normaux : minute d'entrée croissante au fil du match,
 *     remplaçant très majoritairement un profil offensif (attaquant/ailier en
 *     priorité, puis milieu/latéral) — jamais le gardien, quasi jamais un
 *     défenseur central (D), qui ne sort qu'en cas de blessure/sortie forcée
 *     (repli sur D uniquement si aucun autre profil n'est plus disponible).
 *     Un coach mieux noté tactiquement et plus adaptable change un peu plus
 *     tôt ; un coach moins bon change plus tard, de façon moins optimale, et
 *     utilise parfois moins de ses fenêtres restantes.
 */
/**
 * Fatigue accumulée en cours de match pour un joueur donné à une minute
 * donnée : dépend de sa forme d'avant-match (condition physique de départ)
 * ET de son endurance (attribut, vitesse à laquelle il s'essouffle), le tout
 * croissant avec la minute actuelle — un joueur en méforme et peu endurant
 * doit sortir nettement plus volontiers en fin de match qu'un joueur increvable.
 */
function fatigueEnCoursDeMatch(jr, minute) {
  const forme = clamp(jr?.forme ?? 100, 0, 100);
  const endurance = clamp(jr?.endurance ?? 12, 1, 20);
  const rythme = (1.6 - endurance / 20) * (1.3 - (forme / 100) * 0.6);
  return 1 + clamp(minute / 90, 0, 1) * rythme * 1.8;
}

function genererRemplacements(compositions, banc, joueursParId, niveauCoach = 0.7, adaptabiliteCoach = 0.6, sortiesForcees = []) {
  const dejaSorti = new Set();
  const dejaEntre = new Set();
  const remplacements = [];

  // 1) Sorties forcées (blessure à sortie immédiate) — priorité absolue sur le banc.
  for (const sortie of sortiesForcees) {
    if (remplacements.length >= 5) break;
    const slot = compositions.find((c) => c.slot_id === sortie.slot_id);
    if (!slot || dejaSorti.has(slot.player_id)) continue;

    const estGardien = slot.role === 'GB';
    const candidats = estGardien
      ? banc.filter((b) => b.role === 'GB' && !dejaEntre.has(b.joueur.id))
      : banc.filter((b) => b.role !== 'GB' && !dejaEntre.has(b.joueur.id));
    if (!candidats.length) continue; // pas de doublure dispo : l'équipe termine diminuée à ce poste

    const axeSortant = axePoste(slot.role);
    let entrant = candidats[0];
    let meilleurScore = Infinity;
    for (const c of candidats) {
      const distance = estGardien ? 0 : Math.abs(axePoste(c.role) - axeSortant);
      const score = distance * 1000 - c.note;
      if (score < meilleurScore) {
        meilleurScore = score;
        entrant = c;
      }
    }

    dejaSorti.add(slot.player_id);
    dejaEntre.add(entrant.joueur.id);
    remplacements.push({
      minute: sortie.minute,
      slot_id: slot.slot_id,
      role: slot.role,
      sortant_id: slot.player_id,
      sortant_nom: slot.player_nom,
      entrant_id: entrant.joueur.id,
      entrant_nom: entrant.joueur.nom,
      raison: 'blessure',
    });
  }

  // 2) Changements tactiques normaux, sur le budget de fenêtres restant.
  const budgetRestant = 5 - remplacements.length;
  const bancEligible = banc.filter((b) => b.role !== 'GB' && !dejaEntre.has(b.joueur.id));
  if (budgetRestant > 0 && bancEligible.length) {
    const qualitePlan = clamp((niveauCoach + adaptabiliteCoach) / 2, 0.3, 1);
    const nbSubs = clamp(Math.round(2 + qualitePlan * 2 + bruitGaussien(0.8)), 1, Math.min(budgetRestant, bancEligible.length));

    for (let i = 0; i < nbSubs; i++) {
      const entrant = bancEligible[i];
      if (!entrant) break;

      // Sorties tactiques normales : quasi jamais un défenseur central (D) —
      // en match réel, un central ne sort que sur blessure/rouge, jamais en
      // changement de routine. Repli sur D uniquement si aucun autre profil
      // n'est dispo (cas extrême, fin de banc/beaucoup de sorties déjà faites).
      // Un slot "non pourvu" (player_id null) ne correspond à personne sur le
      // terrain : jamais éligible comme sortant d'un changement tactique (bug
      // de même famille que pour les buteurs/passeurs/cartons, cf. compositionEffective).
      let candidatsSortants = compositions.filter((c) => c.player_id != null && c.role !== 'GB' && c.role !== 'D' && !dejaSorti.has(c.player_id));
      if (!candidatsSortants.length) {
        candidatsSortants = compositions.filter((c) => c.player_id != null && c.role !== 'GB' && !dejaSorti.has(c.player_id));
      }
      if (!candidatsSortants.length) break;

      // Remplacement cohérent : la distance de poste avec l'entrant reste un
      // critère, mais la priorité de sortie par poste domine — les changements
      // réels sont très majoritairement offensifs (attaquant/ailier fatigué,
      // changement de plan de jeu), assez souvent au milieu (MD compris),
      // plus rarement chez les latéraux. Tirage pondéré (pas un simple
      // argmin) pour éviter un ordre trop rigide/déterministe.
      // Minute calculée AVANT le choix du sortant : sert aussi à évaluer la
      // fatigue accumulée à cet instant précis du match.
      const minuteBase = 58 + i * 7 - qualitePlan * 8;
      const minute = clamp(Math.round(minuteBase + bruitGaussien(6)), 46, 90);

      const PRIORITE_SORTIE = { BT: 4, MO: 3.2, MD: 2.6, AL: 1.3 };
      const axeEntrant = axePoste(entrant.role);
      const poidsSortie = candidatsSortants.map((c) => {
        const priorite = PRIORITE_SORTIE[c.role] ?? 0.5;
        const distancePoste = Math.abs(axePoste(c.role) - axeEntrant);
        const bonusPosition = 1 + Math.max(0, 2 - distancePoste) * 0.25;
        const facteurFatigue = fatigueEnCoursDeMatch(joueursParId.get(c.player_id), minute);
        return { item: c, poids: priorite * bonusPosition * facteurFatigue };
      });
      const sortant = tirageAlPondere(poidsSortie) ?? candidatsSortants[0];
      dejaSorti.add(sortant.player_id);
      dejaEntre.add(entrant.joueur.id);

      remplacements.push({
        minute,
        slot_id: sortant.slot_id,
        role: sortant.role,
        sortant_id: sortant.player_id,
        sortant_nom: sortant.player_nom,
        entrant_id: entrant.joueur.id,
        entrant_nom: entrant.joueur.nom,
        raison: 'tactique',
      });
    }
  }

  return remplacements.sort((a, b) => a.minute - b.minute);
}

/**
 * Renvoie la composition "effective" sur le terrain à une minute donnée :
 * les titulaires déjà remplacés à cette minute sont substitués par leur entrant
 * (même slot/rôle — hypothèse simplificatrice : changement poste pour poste).
 * `expulsions` (optionnel) : joueurs déjà exclus (carton rouge/2e jaune) à
 * cette minute — retirés du onze, sans remplaçant (l'équipe joue à 10).
 */
function compositionEffective(compositionsBase, remplacements, minute, expulsions = []) {
  let base = compositionsBase;

  if (remplacements?.length) {
    const actifs = remplacements.filter((r) => r.minute <= minute);
    if (actifs.length) {
      const parSlot = new Map(actifs.map((r) => [r.slot_id, r]));
      base = base.map((slot) => {
        const rempl = parSlot.get(slot.slot_id);
        return rempl ? { ...slot, player_id: rempl.entrant_id, player_nom: rempl.entrant_nom } : slot;
      });
    }
  }

  if (expulsions?.length) {
    const dehors = new Set(expulsions.filter((e) => e.minute <= minute).map((e) => e.player_id));
    if (dehors.size) base = base.filter((slot) => !dehors.has(slot.player_id));
  }

  // Un slot "non pourvu" (player_id null, cf. choisirCompositionDuJour /
  // assurerCompositionSansDoublon quand aucun candidat compatible n'était
  // disponible pour ce poste) ne correspond à personne sur le terrain : il ne
  // doit jamais pouvoir être tiré comme buteur, passeur ou fautif (bug observé :
  // "Poste non pourvu" crédité d'un but/une passe). compositionEffective est le
  // seul point d'entrée utilisé pour ces tirages (buts, passes, cartons) — le
  // filtrer ici les corrige tous en une fois.
  return base.filter((slot) => slot.player_id != null);
}

// ============================================================
// ÉTAPE 5 & 6 — BUTEURS ET PASSEURS
// ============================================================

function tirerJoueurPondere(compositions, joueursParId, poidsFn) {
  const entrees = compositions.map((slot) => {
    const jr = joueursParId.get(slot.player_id);
    const profil = profilRole(slot.role);
    const noteAttr = jr ? noteJoueurMatch(jr, slot.role) : 50;
    return { item: slot, poids: poidsFn(profil, noteAttr, jr) };
  });
  return tirageAlPondere(entrees);
}

/**
 * Instinct de but (0-1), spécifique au type de finition attendu pour la
 * catégorie du poste — les stats qui font marquer un attaquant ne sont pas
 * celles qui font marquer un défenseur ou un milieu :
 *  - attaquant/milieu_offensif : finition pure + sang-froid devant le but.
 *  - défenseur (D et AL) : quasiment toujours sur coup de pied arrêté
 *    (corner, coup franc) — jeu de tête et gabarit priment, la finition
 *    "pure" compte peu.
 *  - milieu : frappes davantage lointaines — technique de frappe et
 *    puissance plutôt que le sang-froid d'un buteur de surface.
 */
function instinctButeurParRole(categorie, jr) {
  const finition = jr?.finition ?? 10;
  const sangFroid = jr?.sang_froid ?? 10;
  const jeuDeTete = jr?.jeu_de_tete ?? 10;
  const technique = jr?.technique ?? 10;
  const puissance = jr?.puissance ?? 10;

  switch (categorie) {
    case 'attaquant':
    case 'milieu_offensif':
      return (finition * 0.6 + sangFroid * 0.4) / 20;
    case 'defenseur':
      return (jeuDeTete * 0.65 + puissance * 0.2 + finition * 0.15) / 20;
    case 'milieu':
      return (technique * 0.5 + puissance * 0.3 + finition * 0.2) / 20;
    default:
      return (finition * 0.5 + sangFroid * 0.5) / 20;
  }
}

function attribuerButeur(compositions, joueursParId, qualiteDefenseAdverse = 0.5, qualiteAerienneAdverse = 50) {
  return tirerJoueurPondere(compositions, joueursParId, (profil, note, jr) => {
    const instinctButeur = clamp(instinctButeurParRole(profil.categorie, jr), 0.1, 1);

    // Une défense adverse faible profite surtout aux vrais finisseurs (BT/MO,
    // poidsButeur élevé) — un défenseur qui marque occasionnellement n'en
    // profite presque pas. Effet cumulatif avec calculerButsEquipe : contre
    // une défense faible, l'équipe marque déjà plus ET son buteur naturel en
    // capte une part encore plus grande.
    const affiniteButeur = clamp((profil.poidsButeur - 0.6) / 2.6, 0, 1);
    const bonusDefenseFaible = 1 + clamp((0.5 - qualiteDefenseAdverse) * 4, -0.3, 2.2) * affiniteButeur;

    // Spécifique aux buts de défenseur (têtes sur corner/coup de pied arrêté,
    // cf. instinctButeurParRole) : une défense adverse aérienne solide (bons
    // de la tête) réduit spécifiquement ce type de but, indépendamment de sa
    // qualité défensive générale déjà prise en compte plus haut.
    const facteurAerienAdverse = profil.categorie === 'defenseur' ? clamp(1.5 - qualiteAerienneAdverse / 100, 0.4, 1.3) : 1;

    return profil.poidsButeur * (0.3 + instinctButeur * 1.05) * (0.6 + note / 100) * bonusDefenseFaible * facteurAerienAdverse;
  });
}

/**
 * `typeButeur` : 'tete' quand le but vient d'un défenseur (D/AL) — dans ce
 * modèle, ces buts sont quasi toujours des têtes sur corner (un défenseur ne
 * monte jamais dans la surface adverse sur un centre de jeu ouvert de son
 * équipe). Dans ce cas, le centre vient du meilleur tireur de corner
 * actuellement sur le terrain (attribut `corners`) — choix déterministe du
 * spécialiste, pas un tirage pondéré : en match réel, c'est quasi toujours
 * le même joueur qui tire les corners d'une équipe.
 * Hors tête de défenseur (attaquants/milieux...), la passe reste un tirage
 * pondéré classique où l'attribut `centres` (jeu ouvert) profite surtout aux
 * attaquants qui montent dans la surface.
 */
function attribuerPasseur(compositions, joueursParId, slotButeur, typeButeur = null) {
  // ~22% des buts n'ont pas de passeur (action individuelle, penalty, CSC...)
  if (proba(0.22)) return null;

  const candidats = compositions.filter((c) => c.slot_id !== slotButeur.slot_id);
  if (!candidats.length) return null;

  if (typeButeur === 'tete') {
    let meilleur = candidats[0];
    let meilleurCorners = -1;
    for (const c of candidats) {
      const jr = joueursParId.get(c.player_id);
      const corners = jr?.corners ?? 5;
      if (corners > meilleurCorners) {
        meilleurCorners = corners;
        meilleur = c;
      }
    }
    return meilleur;
  }

  return tirerJoueurPondere(candidats, joueursParId, (profil, note, jr) => {
    const creativite = ((jr?.vision_du_jeu ?? 10) + (jr?.passes ?? 10) + (jr?.centres ?? 10)) / 3;
    return profil.poidsPasseur * (0.5 + creativite / 20) * (0.6 + note / 100);
  });
}

/**
 * Désigne l'auteur d'un but contre son camp côté équipe ADVERSE (celle qui va
 * "encaisser" le point au tableau d'affichage malgré elle). En réalité, un
 * CSC vient quasi toujours d'un défenseur ou d'un latéral qui dévie
 * malencontreusement un centre/tir dans ses propres filets (dégagement raté,
 * déviation sous pression), très rarement un attaquant — et, désormais,
 * exceptionnellement un gardien (relance ratée, sortie manquée, dégagement
 * contré qui repart dans ses propres cages). Le gardien reste inclus avec un
 * poids volontairement minuscule (cf. plus bas) : ça doit rester un événement
 * rarissime, pas une source réaliste de CSC au même titre qu'un défenseur.
 */
function attribuerAuteurCSC(compositionsAdverse, joueursParIdAdverse) {
  const candidatsDefense = compositionsAdverse.filter((c) => {
    const cat = profilRole(c.role).categorie;
    return cat === 'defenseur' || cat === 'milieu';
  });
  const gardien = compositionsAdverse.filter((c) => profilRole(c.role).categorie === 'gardien');
  const pool = candidatsDefense.length
    ? [...candidatsDefense, ...gardien]
    : [...compositionsAdverse.filter((c) => profilRole(c.role).categorie !== 'gardien'), ...gardien];
  if (!pool.length) return null;

  return tirerJoueurPondere(pool, joueursParIdAdverse, (profil, note) => {
    if (profil.categorie === 'gardien') {
      // Poids fixe, très faible (bévue rarissime) et volontairement
      // indépendant de la note du jour : un gardien voit déjà ses erreurs se
      // traduire via arrêts manqués/buts encaissés ailleurs dans le moteur,
      // ce poids ne doit pas grimper significativement même un jour sans.
      return 0.04;
    }
    // Nettement plus fréquent chez un défenseur/latéral (plus exposé aux
    // dégagements et déviations dans sa propre surface) qu'un milieu.
    const facteurPoste = profil.categorie === 'defenseur' ? 1.4 : 1;
    // Un joueur en méforme ce jour-là (note plus basse) commet un peu plus
    // d'erreurs de ce type — effet volontairement discret, pas déterminant.
    const facteurForme = clamp(1.25 - note / 130, 0.6, 1.25);
    return facteurPoste * facteurForme;
  });
}

function genererButeursEtPasseurs(nbButs, compositions, joueurs, gameClubId, remplacements = [], qualiteDefenseAdverse = 0.5, qualiteAerienneAdverse = 50, expulsions = [], adverse = null) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const joueursParIdAdverse = adverse ? new Map(adverse.joueurs.map((j) => [j.id, j])) : null;
  const evenements = [];

  for (let i = 0; i < nbButs; i++) {
    const minute = minuteAleatoire();
    // expulsions : un joueur déjà expulsé à cette minute ne peut plus être
    // buteur NI passeur — corrige le bug où un joueur pouvait marquer après
    // son propre carton rouge (compositionEffective l'exclut du onze effectif).
    const compoAuMoment = compositionEffective(compositions, remplacements, minute, expulsions);

    // Petite chance de but contre son camp : un joueur de l'équipe ADVERSE
    // dévie malencontreusement dans ses propres filets. Taux réaliste (les
    // CSC représentent grosso modo 2 à 3% des buts marqués en football pro) ;
    // légèrement plus fréquent quand la défense concernée est déjà fébrile
    // (qualiteDefenseAdverse basse, subie par CETTE équipe qui attaque —
    // une défense en difficulté commet aussi plus d'erreurs de ce type).
    const probaCSC = clamp(0.018 + (0.5 - qualiteDefenseAdverse) * 0.03, 0.008, 0.045);
    if (adverse && joueursParIdAdverse && proba(probaCSC)) {
      const compoAdverseAuMoment = compositionEffective(
        adverse.compositions,
        adverse.remplacements ?? [],
        minute,
        adverse.expulsions ?? []
      );
      const slotCSC = attribuerAuteurCSC(compoAdverseAuMoment, joueursParIdAdverse);
      if (slotCSC) {
        evenements.push({
          minute,
          game_club_id: adverse.gameClubId, // club du joueur auteur du CSC (celui qui encaisse)
          equipe_creditee_game_club_id: gameClubId, // club dont le score est crédité par ce but
          buteur_id: slotCSC.player_id,
          buteur_nom: slotCSC.player_nom,
          passeur_id: null,
          passeur_nom: null,
          est_csc: true,
        });
        continue; // ce but est comptabilisé, passe au suivant
      }
      // pas de candidat valable côté adverse (effectif vide) : on retombe
      // sur un but "normal" ci-dessous plutôt que de perdre le but.
    }

    const slotButeur = attribuerButeur(compoAuMoment, joueursParId, qualiteDefenseAdverse, qualiteAerienneAdverse);
    if (!slotButeur) continue;
    const typeButeur = profilRole(slotButeur.role).categorie === 'defenseur' ? 'tete' : null;
    const slotPasseur = attribuerPasseur(compoAuMoment, joueursParId, slotButeur, typeButeur);

    evenements.push({
      minute,
      game_club_id: gameClubId,
      equipe_creditee_game_club_id: gameClubId,
      buteur_id: slotButeur.player_id,
      buteur_nom: slotButeur.player_nom,
      passeur_id: slotPasseur ? slotPasseur.player_id : null,
      passeur_nom: slotPasseur ? slotPasseur.player_nom : null,
      est_csc: false,
    });
  }

  return evenements.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 7 — CARTONS
// ============================================================

/**
 * Génère les cartons d'une équipe. Traite les fautes dans l'ORDRE
 * CHRONOLOGIQUE des minutes (pas dans l'ordre de tirage) : un joueur déjà
 * expulsé (rouge direct ou 2e jaune) ne peut plus être crédité d'une faute
 * ultérieure, ni donc d'un nouveau carton — il n'est plus sur le terrain.
 */
function genererCartonsEquipe(fautes, compositions, joueurs, gameClubId, remplacements = []) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const cartons = [];
  const dejaJaune = new Set();
  const expulses = new Set();

  const minutesFautes = Array.from({ length: fautes }, () => minuteAleatoire()).sort((a, b) => a - b);

  for (const minute of minutesFautes) {
    // ~18% des fautes donnent un carton jaune
    if (!proba(0.18)) continue;

    const expulsionsActuelles = [...expulses].map((id) => ({ player_id: id, minute: 0 }));
    const compoAuMoment = compositionEffective(compositions, remplacements, minute, expulsionsActuelles);

    const slot = tirerJoueurPondere(compoAuMoment, joueursParId, (profil, note, jr) => {
      const agressivite = jr?.agressivite ?? 10;
      const tacles = jr?.tacles ?? 10;
      return profil.poidsCarton * (0.4 + (agressivite + tacles) / 40);
    });
    if (!slot) continue;

    if (dejaJaune.has(slot.player_id)) {
      cartons.push({ minute, game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'deuxieme_jaune' });
      expulses.add(slot.player_id);
    } else {
      dejaJaune.add(slot.player_id);
      cartons.push({ minute, game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'jaune' });
      // petite chance de carton rouge direct indépendant (tacle très dangereux)
      if (proba(0.015)) {
        cartons.push({ minute: clamp(minute + 1, 1, 90), game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'rouge_direct' });
        expulses.add(slot.player_id);
      }
    }
  }

  return cartons.sort((a, b) => a.minute - b.minute);
}

/** Extrait, pour une liste de cartons, la minute d'expulsion de chaque joueur expulsé (rouge direct ou 2e jaune). */
function extraireExpulsions(cartons) {
  const parJoueur = new Map();
  for (const c of cartons) {
    if (c.type !== 'rouge_direct' && c.type !== 'deuxieme_jaune') continue;
    if (!parJoueur.has(c.player_id)) parJoueur.set(c.player_id, c.minute);
  }
  return [...parJoueur.entries()].map(([player_id, minute]) => ({ player_id, minute }));
}

/**
 * Un joueur expulsé ne peut évidemment plus être remplacé après coup (il n'y
 * a pas de "remplaçant" à un carton rouge, l'équipe finit à 10) : purge tout
 * changement tactique qui aurait été programmé pour son slot après sa
 * propre expulsion — la sélection des remplacements (étape 4bis) est
 * générée avant que les cartons ne soient connus, donc ce conflit est
 * possible et doit être nettoyé après coup.
 */
function purgerRemplacementsApresExpulsion(remplacements, expulsions) {
  if (!expulsions.length) return remplacements;
  const minuteExpulsionParJoueur = new Map(expulsions.map((e) => [e.player_id, e.minute]));
  return remplacements.filter((r) => {
    const minuteExpulsion = minuteExpulsionParJoueur.get(r.sortant_id);
    return minuteExpulsion === undefined || r.minute <= minuteExpulsion;
  });
}

// ============================================================
// ÉTAPE 8 — BLESSURES
// ============================================================

/**
 * Catalogue des blessures du jeu, par catégorie de gravité. `partDesBlessures`
 * = poids de tirage de la catégorie elle-même (~45/30/18/6/1, cf. doc fournie).
 * Dans chaque catégorie, `poids` = poids de tirage de la blessure précise.
 * `jMin`/`jMax` = durée d'indisponibilité en jours (semaines/mois convertis à
 * 7j/30j). `sortieImmediate` = la blessure exige-t-elle une sortie immédiate
 * (remplacement) ou le joueur peut-il terminer la rencontre ?
 */
const CATALOGUE_BLESSURES = {
  tres_legere: {
    partDesBlessures: 45,
    items: [
      { nom: 'Contusion légère', poids: 12, jMin: 1, jMax: 3, sortieImmediate: false },
      { nom: 'Coup au tibia', poids: 8, jMin: 1, jMax: 3, sortieImmediate: false },
      { nom: 'Coup à la cuisse', poids: 8, jMin: 1, jMax: 4, sortieImmediate: false },
      { nom: 'Coup à la cheville', poids: 7, jMin: 1, jMax: 4, sortieImmediate: false },
      { nom: 'Coup au genou', poids: 6, jMin: 2, jMax: 5, sortieImmediate: false },
      { nom: 'Hématome', poids: 6, jMin: 2, jMax: 6, sortieImmediate: false },
      { nom: 'Courbatures importantes', poids: 5, jMin: 1, jMax: 3, sortieImmediate: false },
      { nom: 'Fatigue musculaire', poids: 5, jMin: 2, jMax: 5, sortieImmediate: false },
      { nom: 'Raideur musculaire', poids: 5, jMin: 1, jMax: 4, sortieImmediate: false },
      { nom: 'Légère gêne au mollet', poids: 4, jMin: 2, jMax: 5, sortieImmediate: false },
      { nom: 'Légère gêne aux adducteurs', poids: 4, jMin: 2, jMax: 5, sortieImmediate: false },
      { nom: 'Douleur au dos', poids: 4, jMin: 2, jMax: 6, sortieImmediate: false },
      { nom: 'Douleur cervicale', poids: 3, jMin: 2, jMax: 5, sortieImmediate: false },
      { nom: 'Douleur à la hanche', poids: 3, jMin: 2, jMax: 6, sortieImmediate: false },
      { nom: 'Ampoule importante', poids: 2, jMin: 1, jMax: 3, sortieImmediate: false },
    ],
  },
  legere: {
    partDesBlessures: 30,
    items: [
      { nom: 'Élongation du mollet', poids: 8, jMin: 5, jMax: 12, sortieImmediate: true },
      { nom: 'Élongation des ischio-jambiers', poids: 8, jMin: 7, jMax: 14, sortieImmediate: true },
      { nom: 'Élongation des quadriceps', poids: 7, jMin: 7, jMax: 14, sortieImmediate: true },
      { nom: 'Élongation des adducteurs', poids: 7, jMin: 7, jMax: 14, sortieImmediate: true },
      { nom: 'Entorse légère de la cheville', poids: 7, jMin: 7, jMax: 21, sortieImmediate: true },
      { nom: 'Entorse légère du genou', poids: 6, jMin: 14, jMax: 21, sortieImmediate: true },
      { nom: 'Tendinite rotulienne', poids: 5, jMin: 7, jMax: 21, sortieImmediate: false },
      { nom: "Tendinite d'Achille", poids: 4, jMin: 14, jMax: 28, sortieImmediate: false },
      { nom: 'Tendinite des adducteurs', poids: 4, jMin: 14, jMax: 28, sortieImmediate: false },
      { nom: 'Inflammation du genou', poids: 4, jMin: 7, jMax: 21, sortieImmediate: false },
      { nom: 'Contracture du mollet', poids: 4, jMin: 5, jMax: 10, sortieImmediate: false },
      { nom: 'Contracture des ischios', poids: 4, jMin: 5, jMax: 10, sortieImmediate: false },
      { nom: 'Contracture des quadriceps', poids: 4, jMin: 5, jMax: 10, sortieImmediate: false },
      { nom: 'Douleur lombaire', poids: 3, jMin: 7, jMax: 14, sortieImmediate: false },
      { nom: 'Pubalgie légère', poids: 3, jMin: 14, jMax: 28, sortieImmediate: false },
    ],
  },
  moyenne: {
    partDesBlessures: 18,
    items: [
      { nom: 'Claquage des ischio-jambiers', poids: 8, jMin: 21, jMax: 42, sortieImmediate: true },
      { nom: 'Claquage des quadriceps', poids: 7, jMin: 21, jMax: 42, sortieImmediate: true },
      { nom: 'Claquage du mollet', poids: 7, jMin: 14, jMax: 35, sortieImmediate: true },
      { nom: 'Déchirure des adducteurs', poids: 6, jMin: 28, jMax: 56, sortieImmediate: true },
      { nom: 'Entorse moyenne de la cheville', poids: 6, jMin: 21, jMax: 42, sortieImmediate: true },
      { nom: 'Entorse moyenne du genou', poids: 5, jMin: 28, jMax: 56, sortieImmediate: true },
      { nom: 'Déchirure musculaire', poids: 5, jMin: 30, jMax: 60, sortieImmediate: true },
      { nom: 'Pubalgie', poids: 4, jMin: 30, jMax: 60, sortieImmediate: false },
      { nom: "Luxation d'un doigt", poids: 4, jMin: 14, jMax: 35, sortieImmediate: false },
      { nom: "Fracture d'un doigt", poids: 3, jMin: 21, jMax: 35, sortieImmediate: false },
      { nom: 'Fracture du nez', poids: 3, jMin: 14, jMax: 28, sortieImmediate: true },
      { nom: 'Commotion cérébrale', poids: 3, jMin: 7, jMax: 28, sortieImmediate: true },
      { nom: 'Déchirure du mollet', poids: 3, jMin: 30, jMax: 60, sortieImmediate: true },
    ],
  },
  grave: {
    partDesBlessures: 6,
    items: [
      { nom: 'Fracture de la main', poids: 7, jMin: 28, jMax: 56, sortieImmediate: true },
      { nom: 'Fracture du poignet', poids: 6, jMin: 30, jMax: 60, sortieImmediate: true },
      { nom: 'Fracture du pied', poids: 6, jMin: 60, jMax: 120, sortieImmediate: true },
      { nom: 'Fracture du péroné', poids: 5, jMin: 60, jMax: 120, sortieImmediate: true },
      { nom: 'Fracture du tibia', poids: 4, jMin: 90, jMax: 180, sortieImmediate: true },
      { nom: 'Fracture du métatarse', poids: 4, jMin: 60, jMax: 90, sortieImmediate: true },
      { nom: 'Rupture ligamentaire de la cheville', poids: 4, jMin: 60, jMax: 120, sortieImmediate: true },
      { nom: "Luxation de l'épaule", poids: 3, jMin: 60, jMax: 90, sortieImmediate: true },
      { nom: 'Déchirure complète des ischios', poids: 3, jMin: 60, jMax: 120, sortieImmediate: true },
      { nom: 'Rupture partielle du ménisque', poids: 3, jMin: 60, jMax: 120, sortieImmediate: true },
      { nom: 'Déchirure importante des quadriceps', poids: 2, jMin: 60, jMax: 120, sortieImmediate: true },
    ],
  },
  tres_grave: {
    partDesBlessures: 1,
    items: [
      { nom: 'Rupture du ligament croisé antérieur (LCA)', poids: 10, jMin: 180, jMax: 270, sortieImmediate: true },
      { nom: 'Rupture du ligament croisé postérieur', poids: 5, jMin: 150, jMax: 240, sortieImmediate: true },
      { nom: 'Rupture du ligament latéral interne', poids: 5, jMin: 90, jMax: 180, sortieImmediate: true },
      { nom: 'Rupture complète du ménisque', poids: 5, jMin: 90, jMax: 180, sortieImmediate: true },
      { nom: 'Double rupture LCA + ménisque', poids: 2, jMin: 240, jMax: 360, sortieImmediate: true },
      { nom: 'Triple lésion ligamentaire', poids: 1, jMin: 270, jMax: 420, sortieImmediate: true },
      { nom: 'Fracture tibia-péroné', poids: 1, jMin: 240, jMax: 360, sortieImmediate: true },
      { nom: "Rupture du tendon d'Achille", poids: 2, jMin: 180, jMax: 270, sortieImmediate: true },
    ],
  },
};

function tirerBlessurePrecise() {
  const entreesCategories = Object.entries(CATALOGUE_BLESSURES).map(([cle, cat]) => ({ item: cle, poids: cat.partDesBlessures }));
  const categorie = tirageAlPondere(entreesCategories);
  const items = CATALOGUE_BLESSURES[categorie].items;
  const choisie = tirageAlPondere(items.map((it) => ({ item: it, poids: it.poids })));
  const jours = Math.round(choisie.jMin + Math.random() * (choisie.jMax - choisie.jMin));
  return { categorie, blessure: choisie.nom, jours, sortie_immediate: choisie.sortieImmediate };
}

/**
 * Probabilité qu'un joueur donné se blesse sur ce match (~1,5% de base par
 * joueur), modulée par :
 *  - sa tendance individuelle aux blessures (attribut) ;
 *  - sa fatigue ET l'enchaînement de matchs récents — les deux sont captés par
 *    sa forme d'avant-match : elle baisse à chaque match joué et ne récupère
 *    que +3/jour, donc un calendrier chargé fait déjà mécaniquement chuter la
 *    forme avant même ce match ;
 *  - son âge (risque croissant après 28 ans) ;
 *  - l'intensité du match (enjeu/danger généré des deux côtés) ;
 *  - la dureté des tacles adverses (agressivité + tacles moyens de l'équipe en face).
 */
function risqueBlessure(jr, { intensiteMatch = 1, facteurTacleAdverse = 1, estGardien = false } = {}) {
  // Calibré pour atterrir ~1,5% par joueur/match en moyenne une fois TOUS les
  // facteurs appliqués (un profil neutre à intensité de match "moyenne" n'a
  // jamais des facteurs pile à 1 : ce point de départ compense cet écart type).
  const probaBase = 0.0112;

  const tendance = clamp((jr.tendance_blessure ?? 10) / 20, 0.05, 1); // plus haut = plus fragile
  const facteurTendance = 0.5 + tendance; // ~0.55 à 1.5

  const forme = clamp(jr.forme ?? 100, 0, 100);
  const facteurFatigue = 1 + ((100 - forme) / 100) * 0.6; // forme 100 -> x1 ; forme 0 -> x1.6

  const age = jr.age ?? 25;
  const facteurAge = 1 + clamp(age - 28, 0, 15) * 0.025; // jusqu'à ~x1.375 à 43 ans

  const facteurIntensite = 0.8 + clamp(intensiteMatch, 0.3, 1.3) * 0.4; // ~0.92 à 1.32
  const facteurTacles = clamp(facteurTacleAdverse, 0.8, 1.4);

  // Un gardien est très peu exposé aux contacts/tacles qui causent la grande
  // majorité des blessures (comparé à un joueur de champ) : risque quasi nul.
  const facteurGardien = estGardien ? 0.05 : 1;

  return probaBase * facteurTendance * facteurFatigue * facteurAge * facteurIntensite * facteurTacles * facteurGardien;
}

/**
 * Dureté de tacle moyenne d'une équipe adverse (agressivité + tacles de ses
 * joueurs de champ titulaires), pour moduler le risque de blessure infligé à
 * l'équipe d'en face.
 */
function facteurDureteAdverse(compositionsAdverses, joueursAdverses) {
  const joueursParId = new Map(joueursAdverses.map((j) => [j.id, j]));
  const valeurs = compositionsAdverses
    .filter((s) => s.role !== 'GB')
    .map((s) => {
      const jr = joueursParId.get(s.player_id);
      return ((jr?.agressivite ?? 10) + (jr?.tacles ?? 10)) / 2;
    });
  if (!valeurs.length) return 1;
  const moyenne = valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
  return clamp(0.8 + (moyenne / 20) * 0.5, 0.8, 1.4);
}

/**
 * Blessures des titulaires, évaluées AVANT la génération des remplacements :
 * une blessure à sortie immédiate détectée ici devient une sortie forcée
 * transmise à `genererRemplacements` (le joueur ne termine pas la rencontre).
 */
function genererBlessuresTitulaires(compositions, joueurs, gameClubId, intensiteMatch, facteurTacleAdverse) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const blessures = [];

  for (const slot of compositions) {
    const jr = joueursParId.get(slot.player_id);
    if (!jr) continue;
    if (!proba(risqueBlessure(jr, { intensiteMatch, facteurTacleAdverse, estGardien: slot.role === 'GB' }))) continue;

    const detail = tirerBlessurePrecise();
    blessures.push({
      minute: minuteAleatoire(),
      slot_id: slot.slot_id,
      game_club_id: gameClubId,
      player_id: slot.player_id,
      player_nom: slot.player_nom,
      ...detail,
    });
  }

  return blessures;
}

/**
 * Blessures des entrants, évaluées APRÈS génération des remplacements (risque
 * au prorata du temps de jeu restant après leur entrée). Une blessure à
 * sortie immédiate ici est ensuite traitée par
 * `completerRemplacementsAvecBlessuresEntrants` : l'entrant blessé doit à son
 * tour sortir et être remplacé (ou l'équipe termine à 10 si plus de fenêtre
 * de changement ou plus de doublure dispo au poste).
 */
function genererBlessuresEntrants(remplacements, joueurs, gameClubId, intensiteMatch, facteurTacleAdverse) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const blessures = [];

  for (const rempl of remplacements) {
    const jr = joueursParId.get(rempl.entrant_id);
    if (!jr) continue;
    const prorata = clamp((90 - rempl.minute) / 90, 0.05, 0.5);
    if (!proba(risqueBlessure(jr, { intensiteMatch, facteurTacleAdverse, estGardien: rempl.role === 'GB' }) * prorata * 1.5)) continue;

    const detail = tirerBlessurePrecise();
    blessures.push({
      minute: clamp(Math.round(rempl.minute + Math.random() * (90 - rempl.minute)), rempl.minute, 90),
      slot_id: rempl.slot_id,
      role: rempl.role,
      game_club_id: gameClubId,
      player_id: rempl.entrant_id,
      player_nom: rempl.entrant_nom,
      ...detail,
    });
  }

  return blessures;
}

/**
 * Traite les blessures d'entrants à sortie immédiate : l'entrant blessé doit
 * lui-même sortir et être remplacé, sur le budget de changements restant
 * (5 max au total, forcés + tactiques + ce second niveau confondus). Si le
 * banc n'a plus de doublure dispo au poste, ou si les 5 fenêtres sont déjà
 * consommées, l'équipe termine la rencontre à 10 à ce poste (aucun
 * changement n'est ajouté). Ne modélise pas de 3e niveau de cascade (un
 * remplaçant-de-remplaçant qui se blesserait à son tour) : la probabilité
 * cumulée est déjà quasi nulle à ce stade.
 */
function completerRemplacementsAvecBlessuresEntrants(remplacements, banc, blessuresEntrants, gameClubId) {
  const dejaEntre = new Set(remplacements.map((r) => r.entrant_id));
  const dejaSorti = new Set(remplacements.map((r) => r.sortant_id));
  const resultat = [...remplacements];

  for (const blessure of blessuresEntrants) {
    if (!blessure.sortie_immediate) continue;
    if (resultat.length >= 5) continue; // plus de fenêtre de changement : joue diminué
    if (dejaSorti.has(blessure.player_id)) continue; // déjà sorti entre-temps (garde-fou)

    const estGardien = blessure.role === 'GB';
    const candidats = estGardien
      ? banc.filter((b) => b.role === 'GB' && !dejaEntre.has(b.joueur.id))
      : banc.filter((b) => b.role !== 'GB' && !dejaEntre.has(b.joueur.id));
    if (!candidats.length) continue; // pas de doublure dispo : équipe termine à 10 à ce poste

    const axeSortant = axePoste(blessure.role);
    let entrant = candidats[0];
    let meilleurScore = Infinity;
    for (const c of candidats) {
      const distance = estGardien ? 0 : Math.abs(axePoste(c.role) - axeSortant);
      const score = distance * 1000 - c.note;
      if (score < meilleurScore) {
        meilleurScore = score;
        entrant = c;
      }
    }

    dejaSorti.add(blessure.player_id);
    dejaEntre.add(entrant.joueur.id);
    resultat.push({
      minute: blessure.minute,
      slot_id: blessure.slot_id,
      role: blessure.role,
      sortant_id: blessure.player_id,
      sortant_nom: blessure.player_nom,
      entrant_id: entrant.joueur.id,
      entrant_nom: entrant.joueur.nom,
      raison: 'blessure',
      game_club_id: gameClubId,
    });
  }

  return resultat.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 9 — NOTES DES JOUEURS / HOMME DU MATCH
// ============================================================

/**
 * Poids "défensif" d'un rôle pour la note (clean sheet / buts encaissés) :
 * un défenseur/latéral porte l'essentiel de la responsabilité, un milieu un
 * peu, un joueur offensif très peu (mais pas zéro : une équipe qui prend
 * l'eau, c'est rarement la faute des seuls défenseurs).
 */
const POIDS_DEFENSIF_CATEGORIE = { defenseur: 1, milieu: 0.55, milieu_offensif: 0.2, attaquant: 0.08, gardien: 0 };

/**
 * Simule les actions individuelles d'un joueur SUR CE MATCH (duels, tacles,
 * passes, dribbles, centres... selon son poste), en confrontant ses
 * attributs à la résistance de l'équipe adverse (attaque/défense/milieu/jeu
 * aérien, cf. `calculerForceEquipe`). C'est la vraie mesure de "qualité du
 * match" demandée : pas une projection statique du CA, mais un tirage
 * d'actions réussies/perdues comme le reste du moteur (mêmes outils —
 * `tiragePoisson`, tirage de probabilité — que pour les buts/tirs).
 *
 * @param {object} adversaire - { attaque, defense, milieu, aerienne } : notes
 *   0-100 du camp d'en face (cf. forceDom/forceExt.noteAttaque etc.), utilisées
 *   comme résistance selon le type d'action.
 * @returns {{ stats: object, noteDelta: number }|null} compteurs d'actions
 *   (tentées/réussies, exploitables pour des stats détaillées côté fiche
 *   joueur) + un delta de note (~ -1.4 à +1.4) reflétant la performance
 *   réelle de CE match.
 */
function simulerPerformanceJoueur(joueurRow, role, minutesJouees, adversaire = {}) {
  if (!joueurRow || !(minutesJouees > 0)) return null;
  const facteurMinutes = clamp(minutesJouees / 90, 0.08, 1);
  const get = (attr, def = 11) => clamp(joueurRow[attr] ?? def, 1, 20);
  const moyAttrs = (...attrs) => moyenne(attrs.map((a) => get(a)));

  const resAttaque = adversaire.attaque ?? 50;
  const resDefense = adversaire.defense ?? 50;
  const resMilieu = adversaire.milieu ?? 50;
  const resAerienne = adversaire.aerienne ?? 50;

  const stats = {};
  let deltaBrut = 0;

  // Une "catégorie d'action" : X tentatives ~Poisson(volume attendu sur les
  // minutes jouées), chacune réussie avec une proba dérivée de l'attribut du
  // joueur (1-20) face à la résistance adverse (0-100) — centré 50/50 quand
  // un joueur moyen (attribut 11/20) affronte une résistance moyenne (50).
  const categorieAction = (cle, attrMoyenne, resistance, volumeBase, poidsNote) => {
    const tentatives = tiragePoisson(volumeBase * facteurMinutes);
    stats[`${cle}_tentes`] = tentatives;
    stats[`${cle}_reussis`] = 0;
    if (tentatives <= 0) return;
    const forceJoueur = (attrMoyenne / 20) * 100;
    const p = clamp(0.5 + (forceJoueur - resistance) / 130, 0.2, 0.92);
    let reussis = 0;
    for (let i = 0; i < tentatives; i++) if (proba(p)) reussis++;
    stats[`${cle}_reussis`] = reussis;
    // Pondéré par la taille de l'échantillon (sqrt pour amortir l'effet d'un
    // gros volume d'actions anodines) : un écart de réussite sur beaucoup de
    // ballons pèse plus qu'un coup de chance sur 2 tentatives.
    deltaBrut += (reussis / tentatives - 0.5) * poidsNote * Math.sqrt(tentatives);
  };

  switch (role) {
    case 'D':
      categorieAction('duels_defensifs', moyAttrs('tacles', 'marquage'), resAttaque, 5, 1.1);
      categorieAction('duels_aeriens', get('jeu_de_tete'), resAerienne, 3, 0.9);
      categorieAction('relances', moyAttrs('placement', 'anticipation'), resMilieu, 12, 0.55);
      break;
    case 'AL':
      categorieAction('duels_defensifs', moyAttrs('tacles', 'marquage'), resAttaque, 4, 0.9);
      categorieAction('centres', get('centres'), resDefense, 4, 0.7);
      categorieAction('duels_offensifs', get('vitesse'), resDefense, 3, 0.5);
      break;
    case 'MD':
      categorieAction('duels_milieu', moyAttrs('tacles', 'anticipation', 'agressivite'), resMilieu, 6, 1);
      categorieAction('passes', get('passes'), resMilieu, 30, 0.85);
      break;
    case 'MO':
      categorieAction('dribbles', get('dribbles'), resDefense, 4, 1);
      categorieAction('passes_creatrices', moyAttrs('passes', 'vision_du_jeu'), resMilieu, 18, 0.85);
      categorieAction('duels_offensifs', get('controle_de_balle'), resDefense, 3, 0.5);
      break;
    case 'BT':
      categorieAction('duels_aeriens', get('jeu_de_tete'), resAerienne, 3, 0.9);
      categorieAction('dribbles', moyAttrs('technique', 'vitesse'), resDefense, 3, 0.9);
      break;
    case 'GB':
      categorieAction('sorties', moyAttrs('sorties_dans_surface', 'attr_1c1'), resAttaque, 2, 1);
      break;
    default:
      categorieAction('duels', moyAttrs('tacles', 'passes'), resMilieu, 5, 0.8);
  }

  const noteDelta = clamp(deltaBrut * 0.5, -1.4, 1.4);
  return { stats, noteDelta };
}

function calculerNotesJoueurs({
  compositions,
  joueurs = [],
  remplacements = [],
  gameClubId,
  buteurs,
  passeurs,
  cartons,
  statsEquipe,
  victoire,
  nul,
  butsMarques = 0,
  butsEncaisses = 0,
  adversaire = {},
}) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const BASE_NOTE = 6.5;
  const expulsions = extraireExpulsions(cartons || []);

  // Participants = les 11 titulaires + les entrants qui sont réellement montés au jeu.
  const participants = [
    ...compositions.map((slot) => ({ ...slot, entrant: false })),
    ...remplacements.map((r) => ({ slot_id: r.slot_id, role: r.role, player_id: r.entrant_id, player_nom: r.entrant_nom, entrant: true, minuteEntree: r.minute })),
  ];

  const notes = participants.map((slot) => {
    const jr = joueursParId.get(slot.player_id);
    const role = slot.role || 'MD';
    const profil = profilRole(role);
    const regularite = clamp(jr?.regularite ?? 11, 1, 20);
    // Le "jour de match" (aléa indépendant du talent) doit pouvoir vraiment
    // faire basculer une note : un joueur peu régulier a de gros écarts d'un
    // match à l'autre, un joueur très régulier reste plus stable — mais dans
    // les deux cas cet aléa ne dépend PAS du CA, donc il ne favorise ni ne
    // pénalise structurellement personne sur une saison complète.
    const ecartTypeNote = clamp(0.5 - regularite * 0.018, 0.15, 0.45); // joueur régulier = notes resserrées

    // Un entrant a joué moins longtemps : note de base plus prudente, sauf s'il a pesé sur le match (but/passe)
    const baseEntrant = slot.entrant ? BASE_NOTE - clamp((slot.minuteEntree - 46) / 90, 0, 0.3) : BASE_NOTE;
    let note = baseEntrant + bruitGaussien(ecartTypeNote);

    // --- Performance individuelle RÉELLE de ce match ------------------------
    // C'est ici que doit se jouer l'essentiel de la note d'un défenseur/
    // milieu qui ne "state" pas forcément beaucoup mais qui est fort dans le
    // jeu : on simule ses duels/tacles/passes/dribbles (selon son poste)
    // face à la résistance de l'équipe adverse, comme pour n'importe quelle
    // autre action du moteur (buts, tirs...), plutôt que de se contenter
    // d'une projection statique de son CA. Un joueur fort doit pouvoir se
    // démarquer sur une saison MÊME si son équipe flop et qu'il est le seul
    // bon élément — cette composante est donc volontairement le plus gros
    // levier, avant même le résultat collectif.
    let performanceMatch = null;
    if (jr) {
      const minutesJouees = slot.entrant
        ? clamp(90 - (slot.minuteEntree ?? 0), 1, 90)
        : minutesJoueesParJoueur(slot.player_id, compositions, remplacements, expulsions);
      performanceMatch = simulerPerformanceJoueur(jr, role, minutesJouees, adversaire);
      if (performanceMatch) note += performanceMatch.noteDelta;
    }

    const butsSlot = buteurs.filter((b) => b.game_club_id === gameClubId && b.buteur_id === slot.player_id && !b.est_csc).length;
    const cscSlot = buteurs.filter((b) => b.game_club_id === gameClubId && b.buteur_id === slot.player_id && b.est_csc).length;
    const passesSlot = passeurs.filter((p) => p.game_club_id === gameClubId && p.passeur_id === slot.player_id).length;
    const cartonsSlot = cartons.filter((c) => c.game_club_id === gameClubId && c.player_id === slot.player_id);

    // Grosses stats individuelles (buts/passes) : le levier le plus direct
    // pour qu'un joueur se démarque sur une saison, indépendamment de
    // l'équipe — un attaquant/milieu qui empile les stats dans une équipe
    // qui flop doit quand même finir avec une excellente moyenne.
    note += butsSlot * 1.2;
    note += passesSlot * 0.65;
    // Un but contre son camp est l'inverse d'un but marqué pour la note
    // individuelle : ça pèse sur la performance, sans pour autant être aussi
    // sévère qu'un carton rouge (ça reste un accident, pas une faute lourde).
    note -= cscSlot * 1.0;
    // Un but/une passe décisive d'un entrant "pèse" un peu plus dans le récit du match (impact banc)
    if (slot.entrant && (butsSlot > 0 || passesSlot > 0)) note += 0.3;
    for (const c of cartonsSlot) {
      if (c.type === 'jaune') note -= 0.3;
      if (c.type === 'deuxieme_jaune' || c.type === 'rouge_direct') note -= 1.2;
    }

    // --- Contexte collectif : impact réel mais secondaire ------------------
    // Une équipe qui marque/encaisse influence un peu la note (bonne relance,
    // pressing qui récupère haut, ou inversement une défense qui craque), et
    // pareil pour le résultat du match — mais ça reste un modulateur, pas le
    // moteur principal : la performance individuelle (ci-dessus) doit rester
    // prépondérante pour qu'un bon joueur dans une équipe faible s'en sorte.
    const poidsAttaque = clamp((profil.poidsButeur + profil.poidsPasseur * 0.7) / 4, 0.05, 1);
    note += butsMarques * 0.08 * poidsAttaque;

    const poidsDefensif = POIDS_DEFENSIF_CATEGORIE[profil.categorie] ?? 0.3;
    if (poidsDefensif > 0) {
      if (butsEncaisses === 0) note += 0.35 * poidsDefensif; // clean sheet
      else note -= 0.12 * butsEncaisses * poidsDefensif;
    }

    if (slot.role === 'GB') {
      // bonus si clean sheet-ish (peu de buts encaissés côté adverse -> approx via arrets déjà comptés dans stats)
      note += (statsEquipe.arrets ?? 0) * 0.12;
      if (butsEncaisses === 0) note += 0.35;
      else note -= clamp(butsEncaisses - 1, 0, 4) * 0.18; // le 1er but encaissé est déjà couvert plus haut
    }

    // Le résultat du match est le signal le plus lisible d'une "grosse
    // saison" collective : on lui donne un poids réel (pas un simple bonus
    // cosmétique de 0.25).
    if (victoire) note += 0.18;
    else if (!nul) note -= 0.12;

    return {
      player_id: slot.player_id,
      player_nom: slot.player_nom,
      entrant: slot.entrant || false,
      role: slot.role || null,
      note: Math.round(clamp(note, 2, 10) * 10) / 10,
      // Détail des actions individuelles simulées (duels, passes, dribbles...
      // selon le poste) — exploitable pour une fiche joueur / stats détaillées
      // du match, en plus d'avoir servi de base à la note ci-dessus.
      stats_match: performanceMatch?.stats ?? null,
    };
  });

  return notes;
}

function determinerHommeDuMatch(notesDom, notesExt) {
  const tous = [...notesDom, ...notesExt];
  return tous.reduce((meilleur, n) => (n.note > (meilleur?.note ?? -1) ? n : meilleur), null);
}

// ============================================================
// ÉTAPE 10 — RÉSUMÉ TEXTUEL
// ============================================================

function genererResume({ nomDom, nomExt, scoreDom, scoreExt, statsDom, buteurs }) {
  const dominant = statsDom.domicile > statsDom.exterieur ? nomDom : nomExt;
  const possDom = statsDom;

  let phrase1;
  if (scoreDom > scoreExt) phrase1 = `${nomDom} s'est imposé ${scoreDom}-${scoreExt} face à ${nomExt}`;
  else if (scoreExt > scoreDom) phrase1 = `${nomExt} l'a emporté ${scoreExt}-${scoreDom} sur le terrain de ${nomDom}`;
  else phrase1 = `${nomDom} et ${nomExt} se sont neutralisés (${scoreDom}-${scoreExt})`;

  const butsTries = [...buteurs].sort((a, b) => a.minute - b.minute);
  const phrasesButs = butsTries.map((b) => {
    return b.est_csc ? `${b.buteur_nom} (${b.minute}e, csc)` : `${b.buteur_nom} (${b.minute}e)`;
  });

  const phraseButs = phrasesButs.length
    ? ` Buts inscrits par ${phrasesButs.join(', ')}.`
    : ' Aucune des deux équipes n\'a trouvé la faille.';

  return `${phrase1} avec ${dominant} plus dominant dans le jeu.${phraseButs}`;
}

// ============================================================
// ÉTAPE 11 — IMPACT POST-MATCH (condition physique & moral)
// ============================================================

/**
 * Minutes jouées par un joueur sur CE match, déduites des remplacements de
 * son équipe : 90 si titulaire jamais remplacé, minute de sortie si remplacé,
 * (90 - minute d'entrée) si entrant, 0 s'il n'a pas du tout été utilisé.
 */
/**
 * Minutes jouées par un joueur sur CE match, déduites des remplacements de
 * son équipe : 90 si titulaire jamais remplacé, minute de sortie si remplacé,
 * (90 - minute d'entrée) si entrant, 0 s'il n'a pas du tout été utilisé.
 * `expulsions` (optionnel) : si le joueur a été expulsé (rouge/2e jaune), ses
 * minutes s'arrêtent à cette minute-là, quoi qu'il arrive par ailleurs.
 */
function minutesJoueesParJoueur(playerId, compositions, remplacements, expulsions = []) {
  const expulsion = expulsions.find((e) => e.player_id === playerId);
  const minutePlafond = expulsion ? expulsion.minute : 90;

  const slotTitulaire = compositions.find((c) => c.player_id === playerId);
  if (slotTitulaire) {
    const sortie = remplacements.find((r) => r.slot_id === slotTitulaire.slot_id);
    const minuteSortie = sortie ? sortie.minute : 90;
    return Math.min(minuteSortie, minutePlafond);
  }
  const entree = remplacements.find((r) => r.entrant_id === playerId);
  if (entree) return clamp(Math.min(90, minutePlafond) - entree.minute, 0, 90);
  return 0;
}

/**
 * Impact d'un match sur la condition physique (`forme`) et le moral de TOUT
 * l'effectif équipe_a d'un club (pas seulement les 11 + le banc utilisé) :
 *
 *  - Condition physique : baisse dégressive selon les minutes réellement
 *    jouées (ratio de base abaissé à -10 pour 90 minutes complètes, contre
 *    -15 auparavant — le rythme de saison était trop punitif), proportionnellement
 *    moins pour un match écourté ou une entrée tardive, aucune perte pour un
 *    joueur non utilisé (il récupère plutôt que de fatiguer). Ce ratio de
 *    base est en plus modulé par `endurance` ET `qualite_physique_naturelle`
 *    (attributs 1-20) : un joueur très endurant/physiquement solide perd
 *    nettement moins de forme qu'un joueur fragile à minutes égales.
 *  - Moral : +5 pour un titulaire (a débuté la rencontre, quel que soit son
 *    temps de jeu ensuite) ; un entrant (rentré en cours de match sans être
 *    titulaire) regagne lui aussi un peu de moral, dans une moindre mesure,
 *    proportionnellement à son temps de jeu — être appelé depuis le banc
 *    reste valorisant. Pour un joueur qui n'a PAS joué DU TOUT, on compare
 *    son niveau (CA / `niveau_actuel`) à celui de ses coéquipiers équipe_a
 *    pour savoir s'il fait partie du "onze attendu" : si oui (il aurait dû
 *    jouer et ne l'a pas fait) il perd du moral, sur une base adoucie
 *    (-6 au lieu de -10) pour ne pas tomber à 0 en à peine 5 matchs sans
 *    temps de jeu ; si c'est un joueur de rotation/réserve pour qui ne pas
 *    jouer est normal, son moral ne bouge pas. Un joueur blessé qui n'a pas
 *    joué n'est jamais pénalisé. Le moral reste borné à 100 au maximum
 *    (contrairement à la forme, qui peut dépasser 100 en bonus de fraîcheur).
 *
 * Fonction pure : ne modifie rien en base, renvoie la liste des nouvelles
 * valeurs à appliquer par l'appelant (edge function) sur `game_players`.
 */
function calculerImpactPostMatch({ compositions, joueurs, remplacements = [], expulsions = [] }) {
  // "Onze attendu" : les joueurs équipe_a au CA le plus élevé (autant que de
  // titulaires dans la compo, 11 normalement). Un joueur de ce groupe qui ne
  // joue pas du tout est légitimement frustré ; un joueur en dehors ne l'est pas.
  const effectifTrieParCA = joueurs
    .slice()
    .sort((a, b) => (b.niveau_actuel ?? b.ca ?? 0) - (a.niveau_actuel ?? a.ca ?? 0));
  const tailleOnzeAttendu = compositions.length || 11;
  const idsOnzeAttendu = new Set(effectifTrieParCA.slice(0, tailleOnzeAttendu).map((j) => j.id));

  // Rôle effectivement tenu ce match (titulaire -> son slot ; entrant -> le
  // rôle du slot qu'il occupe après le changement), pour moduler la fatigue :
  // un gardien ne dépense presque rien physiquement comparé à un joueur de champ.
  const roleParId = new Map();
  for (const slot of compositions) roleParId.set(slot.player_id, slot.role);
  for (const r of remplacements) roleParId.set(r.entrant_id, r.role);

  return joueurs.map((jr) => {
    const minutes = minutesJoueesParJoueur(jr.id, compositions, remplacements, expulsions);
    const estTitulaire = compositions.some((c) => c.player_id === jr.id);
    const aJoue = minutes > 0;
    const estBlesse = (jr.blessure_jours ?? 0) > 0;
    const estGardien = roleParId.get(jr.id) === 'GB';

    // Un gardien s'épuise très peu comparé à un joueur de champ (peu de
    // courses sur 90 minutes) : perte de forme réduite à 20% de la normale.
    const facteurFatigue = estGardien ? 0.2 : 1;

    // Endurance (résistance à l'effort dans le match) ET qualité physique
    // naturelle (constitution générale) atténuent/aggravent la perte de
    // forme : un joueur solide sur les deux plans (proche de 20/20) perd
    // nettement moins de condition qu'un joueur fragile (proche de 1/20) à
    // minutes égales. Moyenne des deux attributs (échelle 1-20, ~11-12 de
    // moyenne en base), convertie en facteur centré autour de 1.
    const endurance = clamp(jr.endurance ?? 12, 1, 20);
    const qualitePhysique = clamp(jr.qualite_physique_naturelle ?? 12, 1, 20);
    const moyennePhysique = (endurance + qualitePhysique) / 2;
    const facteurEndurance = clamp(1.35 - (moyennePhysique / 20) * 0.7, 0.65, 1.35);

    // Ratio de base abaissé (10 au lieu de 15 pour 90 minutes) : le rythme
    // de perte de forme sur une saison complète était trop punitif en général.
    const BASE_PERTE_FORME = 10;
    const perteForme = aJoue
      ? Math.round((BASE_PERTE_FORME * clamp(minutes, 0, 90) * facteurFatigue * facteurEndurance) / 90)
      : 0;

    let deltaMoral = 0;
    if (estTitulaire) {
      deltaMoral = 5;
    } else if (aJoue) {
      // Entrant (pas titulaire mais utilisé) : léger regain de moral, dilué
      // selon le temps de jeu réel plutôt qu'un forfait fixe.
      deltaMoral = clamp(Math.round(2 + (clamp(minutes, 0, 90) / 90) * 3), 2, 5);
    } else if (!estBlesse && idsOnzeAttendu.has(jr.id)) {
      // Non-utilisé alors qu'attendu dans le onze : frustration, mais base
      // adoucie (-6 au lieu de -10) pour ne pas tomber à 0 en ~5 matchs.
      deltaMoral = -6;
    }

    const formeActuelle = clamp(jr.forme ?? 100, 0, 150);
    // Le moral est plafonné à 100 (contrairement à la forme, qui peut monter
    // en bonus de fraîcheur jusqu'à 150) : on écrête aussi bien la valeur de
    // départ (au cas où une donnée existante dépasserait déjà 100) que le résultat.
    const moralActuel = clamp(jr.moral ?? 100, 0, 100);

    return {
      player_id: jr.id,
      minutes_jouees: minutes,
      titulaire: estTitulaire,
      forme: clamp(formeActuelle - perteForme, 0, 150),
      moral: clamp(moralActuel + deltaMoral, 0, 100),
    };
  });
}

// ============================================================
// ÉTAPE 0bis — COMPOSITION DU JOUR (coach ajuste la compo désignée
// selon blessures/forme/note récente — distinct de la tactique)
// ============================================================

/**
 * Score de sélection d'un joueur pour un rôle donné, à date de match : mix
 * de sa forme du jour (attributs + CA + forme/moral actuels, via
 * noteJoueurMatch) et de sa note moyenne récente en club (note_moyenne_saison,
 * échelle 0-10 -> ramenée sur 100). En dessous de 3 matchs joués cette
 * saison, l'historique est jugé trop mince et on retombe entièrement sur la
 * note du jour.
 */
function scoreSelectionJoueur(joueurRow, role) {
  if (!joueurRow) return 0;
  const noteJour = noteJoueurMatch(joueurRow, role);
  const nbMatchs = joueurRow.matchs_joues_saison ?? 0;
  const noteRecente = nbMatchs >= 3 ? clamp((joueurRow.note_moyenne_saison ?? 0) * 10, 0, 100) : noteJour;
  return noteJour * 0.55 + noteRecente * 0.45;
}

/**
 * Ajuste la compo désignée (tactique.compositions) pour le jour du match,
 * poste pour poste (le slot/rôle de chaque titulaire ne change pas, seul le
 * joueur qui l'occupe peut changer) :
 *  - un titulaire blessé (blessure_jours > 0) est TOUJOURS sorti, remplacé
 *    par le meilleur joueur dispo et compatible avec le même rôle
 *    (raison: 'blessure') ;
 *  - un titulaire dont la forme est SOUS `seuilFatigueForcee` (défaut 55/100)
 *    est également TOUJOURS sorti d'office — trop cuit pour être aligné,
 *    indépendamment de son niveau intrinsèque (raison: 'fatigue'). Un joueur
 *    fatigué peut néanmoins encore servir de dernier recours si aucun autre
 *    joueur compatible n'est disponible pour le poste (effectif trop juste) ;
 *  - un titulaire ni blessé ni trop fatigué est conservé sauf si un autre
 *    joueur dispo au même rôle a un score de sélection nettement supérieur
 *    (marge `seuilPromotion`, par défaut 4 points/100) — évite les
 *    changements sur un simple bruit statistique d'un match à l'autre
 *    (raison: 'meilleure_option', qui peut déjà elle-même refléter un écart
 *    de forme entre les deux joueurs sans que le titulaire soit hors service).
 *
 * Cette fonction représente le choix par défaut du STAFF (IA) : si le coach
 * humain a lui-même déjà désigné un remplaçant pour un titulaire fatigué
 * dans l'éditeur de tactique, `compositionsBase` doit déjà refléter ce choix
 * manuel — cette fonction ne fait alors qu'une passe de sécurité (elle ne
 * peut pas sortir un joueur dont la forme est au-dessus du seuil).
 *
 * N'ordonne PAS un poste par CA/qualité absolue : ne considère, pour chaque
 * slot, que le titulaire désigné par la tactique + les joueurs compatibles
 * avec ce rôle précis, un joueur ne pouvant occuper qu'un seul slot.
 *
 * @param {Array} compositionsBase - tactique.compositions (slot_id, role, player_id, player_nom, ...)
 * @param {Array} joueurs - TOUT l'effectif équipe_a du club (game_players)
 * @param {object} [options]
 * @param {number} [options.seuilPromotion=4] - marge de score (0-100) au-delà de laquelle un joueur en meilleure forme du jour prend la place d'un titulaire sain
 * @param {number} [options.seuilFatigueForcee=55] - forme (0-100+) en dessous de laquelle un titulaire est sorti d'office, comme pour une blessure
 * @returns {{ compositions: Array, changements: Array }} changements[].raison ∈ {'blessure','fatigue','doublon','meilleure_option'}
 */
/**
 * Un joueur est-il trop fatigué pour être aligné titulaire sans avertissement ?
 * Même seuil par défaut que `choisirCompositionDuJour`, à réutiliser côté UI
 * (éditeur de tactique) pour afficher un badge/avertissement quand le coach
 * essaie de désigner ce joueur comme titulaire, SANS forcer automatiquement
 * un changement — le coach reste libre de l'aligner quand même (fatigue,
 * contrairement à la blessure, n'est jamais un empêchement absolu).
 */
function joueurTropFatigue(joueurRow, seuilFatigueForcee = 55) {
  if (!joueurRow) return false;
  return clamp(joueurRow.forme ?? 100, 0, 150) < seuilFatigueForcee;
}

/**
 * Liste, pour un poste (rôle PROFILS_ROLE) donné, les joueurs de l'effectif
 * éligibles à ce rôle et non blessés — triés par score de sélection du jour
 * décroissant (cf. scoreSelectionJoueur) — pour permettre à l'éditeur de
 * tactique de proposer au coach une liste d'alternatives quand le titulaire
 * voulu est trop fatigué (ou pour tout autre motif de son choix).
 *
 * @param {string} role - clé PROFILS_ROLE (ex. 'BT', 'MO'...)
 * @param {Array} joueurs - effectif équipe_a du club (game_players)
 * @param {Array<string|number>} [idsExclus] - joueurs déjà utilisés ailleurs dans le onze (à exclure)
 * @returns {Array<{ joueur, score, tropFatigue }>}
 */
function alternativesPourPoste(role, joueurs, idsExclus = []) {
  const { pool, enRepli } = poolDisponiblePourRole(role, joueurs, idsExclus);
  return pool
    .map((j) => ({
      joueur: j,
      // Score pénalisé si c'est un repli (rôle proche, pas le tag exact) :
      // reflète dans l'UI/l'ordre que ce candidat est un dépannage, pas un
      // titulaire naturel à ce poste.
      score: scoreSelectionJoueur(j, role) - (enRepli ? 8 : 0),
      tropFatigue: joueurTropFatigue(j),
      enRepli,
    }))
    .sort((a, b) => b.score - a.score);
}

function choisirCompositionDuJour(compositionsBase, joueurs, { seuilPromotion = 4, seuilFatigueForcee = 55 } = {}) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const dejaUtilises = new Set();
  const changements = [];

  const compositions = (compositionsBase || []).map((slot) => {
    const designe = joueursParId.get(slot.player_id);
    const role = slot.role;
    // Le titulaire désigné est indisponible pour ce slot s'il est blessé, s'il
    // est TROP fatigué (forme sous seuilFatigueForcee — un joueur cuit ne doit
    // pas être laissé titulaire par défaut, le staff le sort d'office comme
    // pour une blessure), OU s'il est déjà utilisé sur un autre slot (tactique
    // source corrompue avec le même player_id sur 2 postes, ou tout autre cas
    // où il a déjà été placé ailleurs) : dans tous ces cas on DOIT chercher un
    // remplaçant, jamais retomber sur lui — sinon il se retrouve dupliqué dans
    // le onze ou titulaire alors qu'il ne devrait pas l'être.
    const designeBlesse = !designe || (designe.blessure_jours ?? 0) > 0;
    const designeSuspendu = !!designe && designe.statut_special === 'Sus';
    const designeTropFatigue = !!designe && joueurTropFatigue(designe, seuilFatigueForcee);
    const designeIndisponible = designeBlesse || designeSuspendu || designeTropFatigue || dejaUtilises.has(designe?.id);

    // Un joueur trop fatigué reste éligible comme candidat de repli si vraiment
    // aucune autre option compatible n'existe pour ce poste (effectif juste) —
    // seul un joueur blessé ou suspendu est totalement exclu des candidats.
    // Si personne n'a le tag exact du poste, on élargit aux rôles proches
    // (cf. poolDisponiblePourRole) plutôt que de laisser le slot vide alors
    // que l'effectif a des joueurs sains et disponibles juste à côté.
    const { pool: poolRole, enRepli } = poolDisponiblePourRole(role, joueurs, dejaUtilises);
    const candidats = poolRole
      .map((j) => ({
        joueur: j,
        score: scoreSelectionJoueur(j, role) - (enRepli ? 8 : 0),
        tropFatigue: joueurTropFatigue(j, seuilFatigueForcee),
        enRepli,
      }))
      .sort((a, b) => {
        if (a.tropFatigue !== b.tropFatigue) return a.tropFatigue ? 1 : -1; // les non-fatigués passent devant
        return b.score - a.score;
      });

    let choisi;
    if (designeIndisponible) {
      choisi = candidats[0]?.joueur ?? null;
      if (designe && choisi && choisi.id !== designe.id) {
        changements.push({
          slot_id: slot.slot_id,
          role,
          raison: dejaUtilises.has(designe.id) ? 'doublon' : designeSuspendu ? 'suspension' : designeBlesse ? 'blessure' : 'fatigue',
          sortant_id: designe.id,
          sortant_nom: designe.nom,
          sortant_forme: designe.forme ?? null,
          entrant_id: choisi.id,
          entrant_nom: choisi.nom,
          entrant_forme: choisi.forme ?? null,
        });
      }
    } else {
      const scoreDesigne = scoreSelectionJoueur(designe, role);
      const meilleureAlternative = candidats.find((c) => c.joueur.id !== designe.id);
      if (meilleureAlternative && meilleureAlternative.score - scoreDesigne > seuilPromotion) {
        choisi = meilleureAlternative.joueur;
        changements.push({
          slot_id: slot.slot_id,
          role,
          raison: 'meilleure_option', // score du jour nettement supérieur (forme/moral/regularité cumulés), sans que le titulaire soit hors service
          sortant_id: designe.id,
          sortant_nom: designe.nom,
          sortant_forme: designe.forme ?? null,
          entrant_id: choisi.id,
          entrant_nom: choisi.nom,
          entrant_forme: choisi.forme ?? null,
          ecart: Math.round(meilleureAlternative.score - scoreDesigne),
        });
      } else {
        choisi = designe;
      }
    }

    // Effectif insuffisant pour ce rôle (cas extrême) : jamais retomber sur
    // le slot d'origine si son player_id est déjà utilisé ailleurs (créerait
    // un doublon) — on laisse le poste explicitement non pourvu.
    if (!choisi) {
      if (dejaUtilises.has(slot.player_id)) {
        return { ...slot, player_id: null, player_nom: 'Poste non pourvu' };
      }
      return slot;
    }

    dejaUtilises.add(choisi.id);
    return { ...slot, player_id: choisi.id, player_nom: choisi.nom };
  });

  return { compositions, changements };
}

/**
 * Filet de sécurité anti-doublon, TOUJOURS exécuté par `simulerMatch` juste
 * avant tout calcul — y compris quand `appliquerCompositionDuJour: false`
 * (l'appelant prétend avoir déjà résolu sa compo du jour). `simulerMatch` ne
 * doit jamais faire une confiance aveugle à son appelant sur ce point : une
 * tactique corrompue, un bug côté éditeur, ou un simple oubli peut assigner
 * le même `player_id` à deux slots (ex. Greenwood en ailier droit ET ailier
 * gauche à la fois).
 *
 * Contrairement à `choisirCompositionDuJour` (qui gère aussi blessure/fatigue
 * et n'est appliquée que si `appliquerCompositionDuJour=true`), cette passe
 * ne traite QUE les doublons et tourne dans tous les cas : le premier slot où
 * le joueur apparaît (ordre du tableau) le garde, les slots suivants sont
 * réattribués au meilleur candidat compatible et disponible pour le rôle, ou
 * laissés explicitement non pourvus si l'effectif est trop juste — jamais
 * laissés dupliqués.
 *
 * @param {Array} compositions - compo à vérifier (déjà passée ou non par choisirCompositionDuJour)
 * @param {Array} joueurs - effectif équipe_a du club (game_players)
 * @returns {{ compositions: Array, changements: Array }} changements[].raison === 'doublon'
 */
function assurerCompositionSansDoublon(compositions, joueurs) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const dejaUtilises = new Set();
  const changements = [];

  const resultat = (compositions || []).map((slot) => {
    if (slot.player_id == null || !dejaUtilises.has(slot.player_id)) {
      if (slot.player_id != null) dejaUtilises.add(slot.player_id);
      return slot;
    }

    // Doublon détecté : ce player_id occupe déjà un autre slot plus tôt dans
    // la compo — on cherche le meilleur remplaçant compatible et libre.
    const designe = joueursParId.get(slot.player_id);
    const role = slot.role;
    const { pool: poolRole, enRepli } = poolDisponiblePourRole(role, joueurs, dejaUtilises);
    const candidats = poolRole
      .map((j) => ({ joueur: j, score: scoreSelectionJoueur(j, role) - (enRepli ? 8 : 0) }))
      .sort((a, b) => b.score - a.score);
    const choisi = candidats[0]?.joueur ?? null;

    changements.push({
      slot_id: slot.slot_id,
      role,
      raison: 'doublon',
      sortant_id: designe?.id ?? slot.player_id,
      sortant_nom: designe?.nom ?? slot.player_nom ?? null,
      entrant_id: choisi?.id ?? null,
      entrant_nom: choisi?.nom ?? null,
    });

    if (!choisi) return { ...slot, player_id: null, player_nom: 'Poste non pourvu' };
    dejaUtilises.add(choisi.id);
    return { ...slot, player_id: choisi.id, player_nom: choisi.nom };
  });

  return { compositions: resultat, changements };
}

// ============================================================
// ORCHESTRATEUR
// ============================================================

/**
 * Simule un match complet entre deux clubs.
 *
 * @param {object} p
 * @param {object} p.domicile - { gameClubId, nom, joueurs, tactique, coach, club, groupe }
 *   - joueurs : TOUT l'effectif équipe_a du club (pas que les 11 titulaires — nécessaire pour le banc)
 *   - coach : ligne game_staff jointe à `staff` (niveau_tactique, niveau_attaque, niveau_defense, adaptabilite)
 *   - club : ligne game_clubs jointe à `clubs` (reputation, niveau_pct, capacite_stade, affluence_moyenne)
 *   - groupe : ligne `dynamique_groupe` du club (optionnelle)
 * @param {object} p.exterieur - même forme que p.domicile
 * @param {object} [p.contexte] - { enjeu: 0-1, meteo: 'normale'|... }
 * @param {boolean} [p.appliquerCompositionDuJour=true] - passe la compo de chaque équipe
 *   par `choisirCompositionDuJour` avant simulation (sort d'office un titulaire blessé ou
 *   trop fatigué). À laisser à `true` dans le cas général ; ne passer `false` que si
 *   l'appelant a déjà lui-même résolu la compo du jour (ex. l'éditeur de tactique a déjà
 *   proposé/validé un remplacement et écrit le résultat dans tactique.compositions) et
 *   veut simuler EXACTEMENT cette compo sans repasse automatique. Dans les deux cas,
 *   `assurerCompositionSansDoublon` tourne quand même en filet de sécurité juste après :
 *   même à `false`, un même joueur ne peut jamais se retrouver sur deux slots à la fois.
 * @returns {object} prêt à écrire dans `calendrier` (score_domicile, score_exterieur, stats)
 */
function simulerMatch({ domicile, exterieur, contexte = {}, appliquerCompositionDuJour = true }) {
  // Étape 0bis — compo du jour : un titulaire blessé OU trop fatigué (forme
  // sous le seuil) est sorti d'office et remplacé par le meilleur profil
  // compatible dispo, AVANT tout calcul de force — la fatigue doit peser sur
  // le choix du onze, pas seulement sur la note une fois aligné.
  let compoDom = domicile.tactique.compositions;
  let compoExt = exterieur.tactique.compositions;
  let ajustementsCompoDom = [];
  let ajustementsCompoExt = [];
  if (appliquerCompositionDuJour) {
    const resultatCompoDom = choisirCompositionDuJour(compoDom, domicile.joueurs);
    const resultatCompoExt = choisirCompositionDuJour(compoExt, exterieur.joueurs);
    compoDom = resultatCompoDom.compositions;
    compoExt = resultatCompoExt.compositions;
    ajustementsCompoDom = resultatCompoDom.changements;
    ajustementsCompoExt = resultatCompoExt.changements;
  }

  // Filet de sécurité : indépendant du flag ci-dessus, et donc actif même
  // quand appliquerCompositionDuJour=false — on ne fait JAMAIS confiance
  // aveuglément à l'appelant sur l'absence de doublon dans compoDom/compoExt
  // (choisirCompositionDuJour gère déjà ce cas, mais seulement quand on
  // l'appelle ; ici on le garantit dans tous les cas, sans exception).
  const antiDoublonDom = assurerCompositionSansDoublon(compoDom, domicile.joueurs);
  const antiDoublonExt = assurerCompositionSansDoublon(compoExt, exterieur.joueurs);
  compoDom = antiDoublonDom.compositions;
  compoExt = antiDoublonExt.compositions;
  ajustementsCompoDom = [...ajustementsCompoDom, ...antiDoublonDom.changements];
  ajustementsCompoExt = [...ajustementsCompoExt, ...antiDoublonExt.changements];

  // Étape 1 — force de chaque équipe (intègre déjà cohésion, dynamique de groupe, avantage du terrain)
  const forceDom = calculerForceEquipe({
    compositions: compoDom,
    joueurs: domicile.joueurs,
    tactique: domicile.tactique,
    coach: domicile.coach,
    club: domicile.club,
    groupe: domicile.groupe,
    contexte: { ...contexte, domicile: true },
  });
  const forceExt = calculerForceEquipe({
    compositions: compoExt,
    joueurs: exterieur.joueurs,
    tactique: exterieur.tactique,
    coach: exterieur.coach,
    club: exterieur.club,
    groupe: exterieur.groupe,
    contexte: { ...contexte, domicile: false },
  });

  // Étape 1bis — mismatch tactique (style/mentalité/pressing/ligne des deux coachs l'un contre l'autre)
  const profilDom = profilTactique(domicile.tactique);
  const profilExt = profilTactique(exterieur.tactique);
  const mismatchDom = calculerMismatchTactique(profilDom, profilExt, forceDom.niveauCoach, forceExt.niveauCoach);
  const mismatchExt = calculerMismatchTactique(profilExt, profilDom, forceExt.niveauCoach, forceDom.niveauCoach);

  // Étape 2 (domination ajustée par le mismatch tactique ET par le style de jeu de chaque équipe)
  const domination = calculerDomination(forceDom, forceExt, mismatchDom, mismatchExt, profilDom, profilExt);

  // Étape 3
  const stats = genererStatistiques(domination, forceDom, forceExt);

  // Étape 4bis — banc, blessures des titulaires puis remplacements (5 max)
  // Ordre important : les blessures à sortie immédiate doivent être connues
  // AVANT de générer les remplacements, pour forcer la sortie du joueur
  // concerné plutôt que de le laisser jouer jusqu'à un changement tactique
  // hypothétique.
  const compoDomAvecNote = forceDom.titulairesNotes.map((t) => ({ ...t.slot, note: t.note }));
  const compoExtAvecNote = forceExt.titulairesNotes.map((t) => ({ ...t.slot, note: t.note }));
  const bancDom = selectionnerBanc(compoDom, domicile.joueurs);
  const bancExt = selectionnerBanc(compoExt, exterieur.joueurs);
  const joueursParIdDom = new Map(domicile.joueurs.map((j) => [j.id, j]));
  const joueursParIdExt = new Map(exterieur.joueurs.map((j) => [j.id, j]));

  const intensiteMatch = clamp((domination.danger.domicile + domination.danger.exterieur) / 140, 0.3, 1.3);
  const tacleSubiParDom = facteurDureteAdverse(compoExt, exterieur.joueurs); // dureté de l'adversaire (exterieur) subie par domicile
  const tacleSubiParExt = facteurDureteAdverse(compoDom, domicile.joueurs);

  const blessuresTitulairesDom = genererBlessuresTitulaires(compoDom, domicile.joueurs, domicile.gameClubId, intensiteMatch, tacleSubiParDom);
  const blessuresTitulairesExt = genererBlessuresTitulaires(compoExt, exterieur.joueurs, exterieur.gameClubId, intensiteMatch, tacleSubiParExt);
  const sortiesForceesDom = blessuresTitulairesDom.filter((b) => b.sortie_immediate).map((b) => ({ slot_id: b.slot_id, minute: b.minute }));
  const sortiesForceesExt = blessuresTitulairesExt.filter((b) => b.sortie_immediate).map((b) => ({ slot_id: b.slot_id, minute: b.minute }));

  const remplacementsDom = genererRemplacements(compoDomAvecNote, bancDom, joueursParIdDom, forceDom.niveauCoach, forceDom.adaptabiliteCoach, sortiesForceesDom).map((r) => ({ ...r, game_club_id: domicile.gameClubId }));
  const remplacementsExt = genererRemplacements(compoExtAvecNote, bancExt, joueursParIdExt, forceExt.niveauCoach, forceExt.adaptabiliteCoach, sortiesForceesExt).map((r) => ({ ...r, game_club_id: exterieur.gameClubId }));

  const blessuresEntrantsDom = genererBlessuresEntrants(remplacementsDom, domicile.joueurs, domicile.gameClubId, intensiteMatch, tacleSubiParDom);
  const blessuresEntrantsExt = genererBlessuresEntrants(remplacementsExt, exterieur.joueurs, exterieur.gameClubId, intensiteMatch, tacleSubiParExt);

  // Un entrant blessé sévèrement doit à son tour sortir : complète les
  // remplacements avec ce 2e niveau (sur le budget de 5 restant).
  let remplacementsFinauxDom = completerRemplacementsAvecBlessuresEntrants(remplacementsDom, bancDom, blessuresEntrantsDom, domicile.gameClubId);
  let remplacementsFinauxExt = completerRemplacementsAvecBlessuresEntrants(remplacementsExt, bancExt, blessuresEntrantsExt, exterieur.gameClubId);

  // Étape 7 — cartons, calculés ICI (avant les buts et avant les notes) : un
  // carton rouge doit pouvoir (a) réduire les chances converties par
  // l'équipe qui joue à 10 / augmenter celles de l'adversaire pour le reste
  // du match (étape 4, plus bas), et (b) exclure le joueur expulsé de toute
  // attribution de but/passe postérieure à son expulsion — sans ce
  // réordonnancement, un joueur pouvait marquer après son propre carton rouge.
  const cartonsDom = genererCartonsEquipe(stats.domicile.fautes, compoDom, domicile.joueurs, domicile.gameClubId, remplacementsFinauxDom);
  const cartonsExt = genererCartonsEquipe(stats.exterieur.fautes, compoExt, exterieur.joueurs, exterieur.gameClubId, remplacementsFinauxExt);
  const tousLesCartons = [...cartonsDom, ...cartonsExt].sort((a, b) => a.minute - b.minute);

  const expulsionsDom = extraireExpulsions(cartonsDom);
  const expulsionsExt = extraireExpulsions(cartonsExt);
  const minuteExpulsionDom = expulsionsDom.length ? Math.min(...expulsionsDom.map((e) => e.minute)) : null;
  const minuteExpulsionExt = expulsionsExt.length ? Math.min(...expulsionsExt.map((e) => e.minute)) : null;

  // Un joueur expulsé ne peut pas avoir été substitué après coup (impossible
  // en réalité) : les remplacements générés plus haut ignoraient encore les
  // cartons, on purge donc tout changement tactique programmé pour son slot
  // après sa propre expulsion.
  remplacementsFinauxDom = purgerRemplacementsApresExpulsion(remplacementsFinauxDom, expulsionsDom);
  remplacementsFinauxExt = purgerRemplacementsApresExpulsion(remplacementsFinauxExt, expulsionsExt);

  // Cas extrêmement rare mais possible : une blessure de titulaire (calculée
  // plus haut, indépendamment des cartons) tombait après sa propre expulsion
  // — incohérent (déjà hors du terrain), on l'écarte.
  const toutesLesBlessures = [...blessuresTitulairesDom, ...blessuresTitulairesExt, ...blessuresEntrantsDom, ...blessuresEntrantsExt]
    .filter((b) => {
      const expulsion = [...expulsionsDom, ...expulsionsExt].find((e) => e.player_id === b.player_id);
      return !expulsion || b.minute <= expulsion.minute;
    })
    .sort((a, b) => a.minute - b.minute);

  // Étape 4 (les buts de chaque équipe dépendent de sa propre attaque, de son
  // meilleur finisseur individuel, de la défense adverse dans son ensemble
  // — défenseurs + gardien, pas juste le gardien —, et désormais des
  // éventuelles expulsions déjà survenues à cet instant du match).
  const meilleurFinisseurDom = meilleurInstinctButeur(forceDom.titulairesNotes);
  const meilleurFinisseurExt = meilleurInstinctButeur(forceExt.titulairesNotes);
  const qualiteDefenseFaceADom = forceExt.noteDefense * 0.65 + forceExt.noteGardien * 0.35; // défense subie par domicile
  const qualiteDefenseFaceAExt = forceDom.noteDefense * 0.65 + forceDom.noteGardien * 0.35; // défense subie par extérieur
  const qualiteAerienneFaceADom = qualiteAerienneDefense(forceExt.titulairesNotes); // aérien adverse subi par domicile
  const qualiteAerienneFaceAExt = qualiteAerienneDefense(forceDom.titulairesNotes); // aérien adverse subi par extérieur

  const resultatDom = calculerButsEquipe(stats.domicile, forceDom.noteAttaque, meilleurFinisseurDom, qualiteDefenseFaceADom, contexte, minuteExpulsionDom, minuteExpulsionExt);
  const resultatExt = calculerButsEquipe(stats.exterieur, forceExt.noteAttaque, meilleurFinisseurExt, qualiteDefenseFaceAExt, contexte, minuteExpulsionExt, minuteExpulsionDom);
  stats.domicile.arrets_gardien_adverse = resultatExt.arrets; // arrêts réalisés PAR le gardien adverse sur les tirs de dom
  stats.exterieur.arrets_gardien_adverse = resultatDom.arrets;

  // Cohérence : jamais plus de buts que de tirs cadrés
  const scoreDom = Math.min(resultatDom.buts, stats.domicile.tirs_cadres);
  const scoreExt = Math.min(resultatExt.buts, stats.exterieur.tirs_cadres);

  // Étape 4ter — les stats (générées à l'étape 3, AVANT que le score ne soit
  // connu) sont recalées sur la physionomie réelle du match : un score large
  // doit se retrouver dans la possession et le volume de tirs affichés.
  recalibrerStatsSelonScore(stats, scoreDom, scoreExt);

  // Étapes 5 & 6 (les remplaçants entrés en jeu peuvent être buteur/passeur ;
  // expulsionsDom/Ext exclut tout joueur déjà expulsé à la minute du but).
  // qualiteDefenseFaceA*/100 : même défense adverse que celle utilisée pour
  // fixer le nombre de buts (étape 4), pour que le finisseur naturel capte
  // une part plus grande des buts justement quand l'équipe en marque déjà plus.
  // `adverse` (5e/8e paramètre) : nécessaire pour pouvoir occasionnellement
  // désigner un but contre son camp côté équipe qui encaisse (cf. proba CSC).
  const buteursDom = genererButeursEtPasseurs(
    scoreDom, compoDom, domicile.joueurs, domicile.gameClubId, remplacementsFinauxDom,
    qualiteDefenseFaceADom / 100, qualiteAerienneFaceADom, expulsionsDom,
    { compositions: compoExt, joueurs: exterieur.joueurs, gameClubId: exterieur.gameClubId, remplacements: remplacementsFinauxExt, expulsions: expulsionsExt }
  );
  const buteursExt = genererButeursEtPasseurs(
    scoreExt, compoExt, exterieur.joueurs, exterieur.gameClubId, remplacementsFinauxExt,
    qualiteDefenseFaceAExt / 100, qualiteAerienneFaceAExt, expulsionsExt,
    { compositions: compoDom, joueurs: domicile.joueurs, gameClubId: domicile.gameClubId, remplacements: remplacementsFinauxDom, expulsions: expulsionsDom }
  );
  const tousLesButs = [...buteursDom, ...buteursExt].sort((a, b) => a.minute - b.minute);

  // Étape 9 (notes incluant les entrants, variance selon la régularité de chaque joueur)
  //
  // Résistance adverse pour les perfs individuelles (duels/dribbles/passes) :
  // pas seulement la force "de saison" (forceExt/forceDom, identique à chaque
  // confrontation), mais cette force MODULÉE par le choc de forme du jour de
  // l'équipe adverse (domination.chocForme) — la même valeur qui a déjà
  // dessiné le danger/la possession de ce match précis. Une équipe qui a un
  // jour sans (chocForme négatif : moins de possession/danger que sa force
  // habituelle ne le laissait attendre) doit aussi voir ses joueurs
  // individuellement perdre plus de duels ce match-là, et inversement — pour
  // que les stats individuelles et les stats d'équipe racontent la même
  // histoire au lieu d'être deux tirages indépendants et décorrélés.
  const adversaireDom = {
    attaque: clamp(forceExt.noteAttaque + domination.chocForme.exterieur, 1, 100),
    defense: clamp(forceExt.noteDefense + domination.chocForme.exterieur, 1, 100),
    milieu: clamp(forceExt.noteMilieu + domination.chocForme.exterieur, 1, 100),
    aerienne: qualiteAerienneFaceADom,
  };
  const adversaireExt = {
    attaque: clamp(forceDom.noteAttaque + domination.chocForme.domicile, 1, 100),
    defense: clamp(forceDom.noteDefense + domination.chocForme.domicile, 1, 100),
    milieu: clamp(forceDom.noteMilieu + domination.chocForme.domicile, 1, 100),
    aerienne: qualiteAerienneFaceAExt,
  };

  const notesDom = calculerNotesJoueurs({
    compositions: compoDom,
    joueurs: domicile.joueurs,
    remplacements: remplacementsFinauxDom,
    gameClubId: domicile.gameClubId,
    buteurs: tousLesButs,
    passeurs: tousLesButs, // les passeurs sont inclus dans les mêmes objets "but"
    cartons: tousLesCartons,
    statsEquipe: { arrets: resultatExt.arrets },
    victoire: scoreDom > scoreExt,
    nul: scoreDom === scoreExt,
    butsMarques: scoreDom,
    butsEncaisses: scoreExt,
    adversaire: adversaireDom,
  });
  const notesExt = calculerNotesJoueurs({
    compositions: compoExt,
    joueurs: exterieur.joueurs,
    remplacements: remplacementsFinauxExt,
    gameClubId: exterieur.gameClubId,
    buteurs: tousLesButs,
    passeurs: tousLesButs,
    cartons: tousLesCartons,
    statsEquipe: { arrets: resultatDom.arrets },
    victoire: scoreExt > scoreDom,
    nul: scoreDom === scoreExt,
    adversaire: adversaireExt,
    butsMarques: scoreExt,
    butsEncaisses: scoreDom,
  });
  const hommeDuMatch = determinerHommeDuMatch(notesDom, notesExt);


  // Étape 10
  const resume = genererResume({
    nomDom: domicile.nom,
    nomExt: exterieur.nom,
    scoreDom,
    scoreExt,
    statsDom: { domicile: stats.domicile.possession, exterieur: stats.exterieur.possession },
    buteurs: tousLesButs,
  });

  // Étape 11 — impact du match sur la condition physique et le moral de TOUT
  // l'effectif équipe_a (pas que les 11 + le banc utilisé), à appliquer par
  // l'appelant sur `game_players.forme` / `game_players.moral`.
  const impactDom = calculerImpactPostMatch({ compositions: compoDom, joueurs: domicile.joueurs, remplacements: remplacementsFinauxDom, expulsions: expulsionsDom });
  const impactExt = calculerImpactPostMatch({ compositions: compoExt, joueurs: exterieur.joueurs, remplacements: remplacementsFinauxExt, expulsions: expulsionsExt });

  return {
    score_domicile: scoreDom,
    score_exterieur: scoreExt,
    impact_joueurs: {
      domicile: impactDom,
      exterieur: impactExt,
    },
    stats: {
      possession: { domicile: stats.domicile.possession, exterieur: stats.exterieur.possession },
      tirs: { domicile: stats.domicile.tirs, exterieur: stats.exterieur.tirs },
      tirs_cadres: { domicile: stats.domicile.tirs_cadres, exterieur: stats.exterieur.tirs_cadres },
      occasions_franches: { domicile: stats.domicile.occasions_franches, exterieur: stats.exterieur.occasions_franches },
      corners: { domicile: stats.domicile.corners, exterieur: stats.exterieur.corners },
      hors_jeu: { domicile: stats.domicile.hors_jeu, exterieur: stats.exterieur.hors_jeu },
      passes_reussies: { domicile: stats.domicile.passes_reussies, exterieur: stats.exterieur.passes_reussies },
      centres: { domicile: stats.domicile.centres, exterieur: stats.exterieur.centres },
      fautes: { domicile: stats.domicile.fautes, exterieur: stats.exterieur.fautes },
      arrets: { domicile: stats.domicile.arrets_gardien_adverse, exterieur: stats.exterieur.arrets_gardien_adverse },
      buteurs: tousLesButs.map(({ minute, game_club_id, equipe_creditee_game_club_id, buteur_id, buteur_nom, est_csc }) => ({
        minute,
        game_club_id,
        equipe_creditee_game_club_id,
        player_id: buteur_id,
        player_nom: buteur_nom,
        est_csc: est_csc ?? false,
      })),
      passeurs: tousLesButs.filter((b) => b.passeur_id).map((b) => ({ minute: b.minute, game_club_id: b.game_club_id, player_id: b.passeur_id, player_nom: b.passeur_nom, but_de: b.buteur_id })),
      cartons: tousLesCartons,
      blessures: toutesLesBlessures,
      remplacements: [...remplacementsFinauxDom, ...remplacementsFinauxExt].sort((a, b) => a.minute - b.minute),
      notes_joueurs: { domicile: notesDom, exterieur: notesExt },
      formation: { domicile: domicile.tactique?.formation ?? null, exterieur: exterieur.tactique?.formation ?? null },
      homme_du_match: hommeDuMatch,
      resume,
      // Forme/moral post-match de TOUT l'effectif équipe_a (étape 11) — inclus
      // dans `stats` pour transiter par la RPC enregistrer_resultat_match /
      // enregistrer_resultat_barrage (SECURITY DEFINER) jusqu'à
      // appliquer_stats_joueurs_apres_match, seule capable d'écrire dans
      // game_players (RLS interdit l'update direct côté client).
      forme_moral: { domicile: impactDom, exterieur: impactExt },
      // Étape 0bis — titulaires sortis d'office avant le coup d'envoi (blessure
      // ou fatigue excessive) et par qui ils ont été remplacés. Permet à
      // l'interface d'afficher "X aligné à la place de Y (trop fatigué)".
      ajustements_compo: { domicile: ajustementsCompoDom, exterieur: ajustementsCompoExt },
    },
  };
}

// Fonctionne en <script src="moteur_match.js"> (navigateur, fonctions
// disponibles directement en global) ET en require('./moteur_match.js')
// (Node, pour les tests/calibrage) sans dupliquer le fichier.
const MOTEUR_MATCH_EXPORTS = {
  simulerMatch,
  // exports individuels utiles pour tests unitaires / calibrage
  calculerForceEquipe,
  calculerDomination,
  genererStatistiques,
  recalibrerStatsSelonScore,
  calculerButsEquipe,
  meilleurInstinctButeur,
  qualiteAerienneDefense,
  genererButeursEtPasseurs,
  attribuerAuteurCSC,
  genererCartonsEquipe,
  extraireExpulsions,
  purgerRemplacementsApresExpulsion,
  genererBlessuresTitulaires,
  genererBlessuresEntrants,
  completerRemplacementsAvecBlessuresEntrants,
  risqueBlessure,
  tirerBlessurePrecise,
  facteurDureteAdverse,
  calculerNotesJoueurs,
  genererResume,
  noteJoueurMatch,
  // impact post-match (forme / moral)
  calculerImpactPostMatch,
  minutesJoueesParJoueur,
  // composition du jour (coach ajuste selon blessure/forme/note récente)
  choisirCompositionDuJour,
  assurerCompositionSansDoublon,
  scoreSelectionJoueur,
  joueurPeutJouerRole,
  joueurTropFatigue,
  alternativesPourPoste,
  // impact tactique
  profilTactique,
  calculerMismatchTactique,
  // banc / remplacements
  selectionnerBanc,
  genererRemplacements,
  compositionEffective,
  inferRolePrincipal,
  axePoste,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MOTEUR_MATCH_EXPORTS;
}
