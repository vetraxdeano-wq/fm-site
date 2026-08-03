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

/** Bruit gaussien approximé (somme de 3 uniformes), pour un "faible aléatoire" contrôlé. */
function bruitGaussien(ecartType = 1) {
  const u = Math.random() + Math.random() + Math.random() - 1.5;
  return u * ecartType;
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
// MO = milieu offensif, AL = ailier, BT = buteur/attaquant de pointe
// ============================================================

const PROFILS_ROLE = {
  GB: {
    categorie: 'gardien',
    attributsCles: ['reflexes', 'placement', 'sorties_dans_surface', 'communication', 'agilite', 'concentration'],
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
  MO: {
    categorie: 'milieu_offensif',
    attributsCles: ['technique', 'dribbles', 'passes', 'vision_du_jeu', 'controle_de_balle', 'finition'],
    poidsButeur: 1.4,
    poidsPasseur: 1.6,
    poidsCarton: 0.8,
  },
  AL: {
    categorie: 'ailier',
    attributsCles: ['vitesse', 'dribbles', 'centres', 'technique', 'finition', 'controle_de_balle'],
    poidsButeur: 1.6,
    poidsPasseur: 1.5,
    poidsCarton: 0.6,
  },
  BT: {
    categorie: 'attaquant',
    attributsCles: ['finition', 'sang_froid', 'appels_de_balle', 'jeu_de_tete', 'attr_1c1', 'technique'],
    poidsButeur: 3.2,
    poidsPasseur: 0.7,
    poidsCarton: 0.7,
  },
};

function profilRole(role) {
  return PROFILS_ROLE[role] || PROFILS_ROLE.MD;
}

/**
 * Déduit un rôle générique (clé de PROFILS_ROLE) à partir de `poste_brut`
 * (ex. "AL/M (G), MO (GC), BT (C)") pour un joueur qui n'a PAS de slot de
 * composition assigné — typiquement un remplaçant pris sur le banc, dont on
 * a besoin d'estimer la note/le poids buteur-passeur-carton sans tactique.
 */
function inferRolePrincipal(joueurRow) {
  const brut = joueurRow?.poste_brut || '';
  const premierSegment = brut.split(',')[0] || '';
  const tokenPoste = premierSegment.split('(')[0].trim();
  const premierToken = tokenPoste.split('/')[0].trim().toUpperCase();
  const MAP = { GB: 'GB', D: 'D', DL: 'D', MD: 'MD', M: 'MD', MO: 'MO', AL: 'AL', BT: 'BT' };
  return MAP[premierToken] || 'MD';
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
  const bonusDomicile = contexte?.domicile
    ? clamp(1 + 0.05 * ferveurPublique + 0.03 * (contexte?.enjeu ?? 0) + 0.03 * (dynGroupe - 0.7), 1.02, 1.17)
    : clamp(0.99 - 0.03 * (1 - dynGroupe), 0.9, 0.99);
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
    noteAttaque: (parCategorie('attaquant') * 0.4 + parCategorie('ailier') * 0.3 + parCategorie('milieu_offensif') * 0.3),
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
 */
function calculerDomination(forceDom, forceExt, mismatchDom = null, mismatchExt = null) {
  const diff = forceDom.noteGlobale - forceExt.noteGlobale; // typiquement -60..+60
  const bruit = bruitGaussien(6); // légère variabilité match à match
  const diffAjuste = diff + bruit;

  // Logistique centrée : possession moyenne 50%, s'écarte selon l'écart de force
  const possessionDom = clamp(50 + diffAjuste * 0.5, 22, 78);
  const possessionExt = 100 - possessionDom;

  // Pression/occasions dépendent surtout de l'attaque adverse vs milieu/défense, ajustées par
  // le mismatch tactique (pressing qui casse la construction adverse, ligne haute exposée, écart
  // de mentalité qui ouvre le match).
  const ajustDom = (mismatchDom?.bonusDanger ?? 0) - (mismatchExt?.malusExposition ?? 0);
  const ajustExt = (mismatchExt?.bonusDanger ?? 0) - (mismatchDom?.malusExposition ?? 0);

  const dangerDom = clamp(50 + (forceDom.noteAttaque - forceExt.noteDefense) * 0.5 + ajustDom + bruitGaussien(4), 15, 92);
  const dangerExt = clamp(50 + (forceExt.noteAttaque - forceDom.noteDefense) * 0.5 + ajustExt + bruitGaussien(4), 15, 92);

  return {
    possession: { domicile: Math.round(possessionDom), exterieur: Math.round(possessionExt) },
    danger: { domicile: dangerDom, exterieur: dangerExt },
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

  // Tirs cadrés : dépend de la qualité technique de l'attaque (pas juste du volume)
  const precisionAttaque = clamp(forceAttaque / 100, 0.2, 0.95);
  let tirsCadres = 0;
  for (let i = 0; i < tirs; i++) if (proba(0.25 + precisionAttaque * 0.35)) tirsCadres++;
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

// ============================================================
// ÉTAPE 4 — CALCUL DES BUTS
// ============================================================

/**
 * Convertit les occasions franches en buts, occasion par occasion,
 * selon la qualité de l'attaque et le gardien adverse.
 * Retourne { buts, arrets } pour l'équipe attaquante.
 */
function calculerButsEquipe(statsEquipe, forceAttaque, forceGardienAdverse, contexte) {
  const nbOccasionsAConvertir = Math.max(statsEquipe.occasions_franches, Math.round(statsEquipe.tirs_cadres * 0.7));
  let buts = 0;
  let arrets = 0;

  const qualiteFinition = clamp(forceAttaque / 100, 0.15, 0.95);
  const qualiteGardien = clamp(forceGardienAdverse / 100, 0.15, 0.95);
  const facteurPression = 1 - (contexte?.enjeu ?? 0) * 0.05;

  for (let i = 0; i < nbOccasionsAConvertir; i++) {
    // probabilité de base d'une occasion franche ~ 28%, modulée par le niveau des deux côtés
    const probaBut = clamp(0.28 + (qualiteFinition - qualiteGardien) * 0.45, 0.05, 0.7) * facteurPression;
    if (proba(probaBut)) {
      buts++;
    } else if (proba(0.55)) {
      arrets++; // occasion cadrée mais arrêtée
    }
    // sinon : tir hors cadre / contré, ni but ni arrêt
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
  const candidats = joueurs.filter((j) => !idsTitulaires.has(j.id) && (j.blessure_jours ?? 0) <= 0);

  const evalues = candidats.map((jr) => {
    const role = inferRolePrincipal(jr);
    return { joueur: jr, role, note: noteJoueurMatch(jr, role) };
  });
  evalues.sort((a, b) => b.note - a.note);
  return evalues.slice(0, max);
}

/**
 * Génère jusqu'à 5 changements pour une équipe : minute d'entrée croissante au
 * fil du match, remplaçant systématiquement le titulaire de champ le moins
 * bien noté à l'instant T (jamais le gardien). Un coach mieux noté tactiquement
 * et plus adaptable change un peu plus tôt et cible mieux le maillon faible ;
 * un coach moins bon change plus tard, de façon moins optimale, et utilise
 * parfois moins de ses 5 fenêtres.
 */
function genererRemplacements(compositions, banc, niveauCoach = 0.7, adaptabiliteCoach = 0.6) {
  // Le gardien remplaçant ne rentre pas sur un changement de champ dans ce modèle simplifié
  // (les titulaires sortants sont toujours des joueurs de champ, cf. filtre plus bas).
  const bancEligible = banc.filter((b) => b.role !== 'GB');
  if (!bancEligible.length) return [];

  const qualitePlan = clamp((niveauCoach + adaptabiliteCoach) / 2, 0.3, 1);
  const nbSubs = clamp(Math.round(2 + qualitePlan * 2 + bruitGaussien(0.8)), 1, Math.min(5, bancEligible.length));

  const dejaSorti = new Set();
  const remplacements = [];

  for (let i = 0; i < nbSubs; i++) {
    const entrant = bancEligible[i];
    if (!entrant) break;

    // Le sortant : titulaire de champ restant sur le pré le moins bien noté (fatigue/forme du jour)
    const candidatsSortants = compositions.filter((c) => c.role !== 'GB' && !dejaSorti.has(c.player_id));
    if (!candidatsSortants.length) break;
    const sortant = candidatsSortants.reduce((pire, c) => (c.note ?? 50) < (pire.note ?? 50) ? c : pire, candidatsSortants[0]);
    dejaSorti.add(sortant.player_id);

    // Minute d'entrée : progresse au fil des changements ; un coach mieux préparé anticipe un peu plus tôt.
    const minuteBase = 58 + i * 7 - qualitePlan * 8;
    const minute = clamp(Math.round(minuteBase + bruitGaussien(6)), 46, 90);

    remplacements.push({
      minute,
      slot_id: sortant.slot_id,
      role: sortant.role,
      sortant_id: sortant.player_id,
      sortant_nom: sortant.player_nom,
      entrant_id: entrant.joueur.id,
      entrant_nom: entrant.joueur.nom,
    });
  }

  return remplacements.sort((a, b) => a.minute - b.minute);
}

/**
 * Renvoie la composition "effective" sur le terrain à une minute donnée :
 * les titulaires déjà remplacés à cette minute sont substitués par leur entrant
 * (même slot/rôle — hypothèse simplificatrice : changement poste pour poste).
 */
function compositionEffective(compositionsBase, remplacements, minute) {
  if (!remplacements?.length) return compositionsBase;
  const actifs = remplacements.filter((r) => r.minute <= minute);
  if (!actifs.length) return compositionsBase;

  const parSlot = new Map(actifs.map((r) => [r.slot_id, r]));
  return compositionsBase.map((slot) => {
    const rempl = parSlot.get(slot.slot_id);
    if (!rempl) return slot;
    return { ...slot, player_id: rempl.entrant_id, player_nom: rempl.entrant_nom };
  });
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

function attribuerButeur(compositions, joueursParId) {
  return tirerJoueurPondere(compositions, joueursParId, (profil, note, jr) => {
    const finition = jr?.finition ?? 10;
    return profil.poidsButeur * (0.5 + finition / 20) * (0.6 + note / 100);
  });
}

function attribuerPasseur(compositions, joueursParId, slotButeur) {
  // ~22% des buts n'ont pas de passeur (action individuelle, penalty, CSC...)
  if (proba(0.22)) return null;

  const candidats = compositions.filter((c) => c.slot_id !== slotButeur.slot_id);
  return tirerJoueurPondere(candidats, joueursParId, (profil, note, jr) => {
    const creativite = ((jr?.vision_du_jeu ?? 10) + (jr?.passes ?? 10) + (jr?.centres ?? 10)) / 3;
    return profil.poidsPasseur * (0.5 + creativite / 20) * (0.6 + note / 100);
  });
}

function genererButeursEtPasseurs(nbButs, compositions, joueurs, gameClubId, remplacements = []) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const evenements = [];

  for (let i = 0; i < nbButs; i++) {
    const minute = minuteAleatoire();
    const compoAuMoment = compositionEffective(compositions, remplacements, minute);

    const slotButeur = attribuerButeur(compoAuMoment, joueursParId);
    if (!slotButeur) continue;
    const slotPasseur = attribuerPasseur(compoAuMoment, joueursParId, slotButeur);

    evenements.push({
      minute,
      game_club_id: gameClubId,
      buteur_id: slotButeur.player_id,
      buteur_nom: slotButeur.player_nom,
      passeur_id: slotPasseur ? slotPasseur.player_id : null,
      passeur_nom: slotPasseur ? slotPasseur.player_nom : null,
    });
  }

  return evenements.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 7 — CARTONS
// ============================================================

function genererCartonsEquipe(fautes, compositions, joueurs, gameClubId, remplacements = []) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const cartons = [];
  const dejaJaune = new Set();

  for (let i = 0; i < fautes; i++) {
    // ~18% des fautes donnent un carton jaune
    if (!proba(0.18)) continue;

    const minute = minuteAleatoire();
    const compoAuMoment = compositionEffective(compositions, remplacements, minute);

    const slot = tirerJoueurPondere(compoAuMoment, joueursParId, (profil, note, jr) => {
      const agressivite = jr?.agressivite ?? 10;
      const tacles = jr?.tacles ?? 10;
      return profil.poidsCarton * (0.4 + (agressivite + tacles) / 40);
    });
    if (!slot) continue;

    if (dejaJaune.has(slot.player_id)) {
      cartons.push({ minute, game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'deuxieme_jaune' });
    } else {
      dejaJaune.add(slot.player_id);
      cartons.push({ minute, game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'jaune' });
      // petite chance de carton rouge direct indépendant (tacle très dangereux)
      if (proba(0.015)) {
        cartons.push({ minute: clamp(minute + 1, 1, 90), game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'rouge_direct' });
      }
    }
  }

  return cartons.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 8 — BLESSURES
// ============================================================

const GRAVITE_BLESSURE = [
  { item: 'legere', poids: 6 },
  { item: 'moyenne', poids: 3 },
  { item: 'grave', poids: 1 },
];

function risqueBlessure(jr, intensiteMatch) {
  const tendance = clamp((jr.tendance_blessure ?? 10) / 20, 0.05, 1); // plus haut = plus fragile
  const endurance = clamp((jr.endurance ?? 12) / 20, 0.3, 1);
  const probaBase = 0.006; // ~0.6% par joueur par match en moyenne
  return probaBase * (0.5 + tendance) * (1.3 - endurance * 0.4) * (0.8 + intensiteMatch * 0.4);
}

function genererBlessuresEquipe(compositions, joueurs, gameClubId, intensiteMatch, remplacements = []) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const blessures = [];
  const sortieParSlot = new Map(remplacements.map((r) => [r.slot_id, r]));

  // Titulaires : blessure possible tant qu'ils sont sur le terrain (avant leur éventuel remplacement)
  for (const slot of compositions) {
    const jr = joueursParId.get(slot.player_id);
    if (!jr) continue;
    if (!proba(risqueBlessure(jr, intensiteMatch))) continue;

    const rempl = sortieParSlot.get(slot.slot_id);
    const minute = rempl ? clamp(minuteAleatoire(), 1, Math.max(1, rempl.minute - 1)) : minuteAleatoire();
    // Si la fenêtre avant remplacement est trop courte pour ce tirage, on l'ignore plutôt que de forcer une minute incohérente.
    if (rempl && minute >= rempl.minute) continue;

    blessures.push({
      minute,
      game_club_id: gameClubId,
      player_id: slot.player_id,
      player_nom: slot.player_nom,
      gravite: tirageAlPondere(GRAVITE_BLESSURE),
    });
  }

  // Entrants : risque prorata du temps de jeu restant après leur entrée (jambes plus fraîches, mais moins de minutes)
  for (const rempl of remplacements) {
    const jr = joueursParId.get(rempl.entrant_id);
    if (!jr) continue;
    const prorata = clamp((90 - rempl.minute) / 90, 0.05, 0.5);
    if (!proba(risqueBlessure(jr, intensiteMatch) * prorata * 1.5)) continue;

    blessures.push({
      minute: clamp(Math.round(rempl.minute + Math.random() * (90 - rempl.minute)), rempl.minute, 90),
      game_club_id: gameClubId,
      player_id: rempl.entrant_id,
      player_nom: rempl.entrant_nom,
      gravite: tirageAlPondere(GRAVITE_BLESSURE),
    });
  }

  return blessures.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 9 — NOTES DES JOUEURS / HOMME DU MATCH
// ============================================================

function calculerNotesJoueurs({ compositions, joueurs = [], remplacements = [], gameClubId, buteurs, passeurs, cartons, statsEquipe, victoire, nul }) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));

  // Participants = les 11 titulaires + les entrants qui sont réellement montés au jeu.
  const participants = [
    ...compositions.map((slot) => ({ ...slot, entrant: false })),
    ...remplacements.map((r) => ({ slot_id: r.slot_id, role: r.role, player_id: r.entrant_id, player_nom: r.entrant_nom, entrant: true, minuteEntree: r.minute })),
  ];

  const notes = participants.map((slot) => {
    const jr = joueursParId.get(slot.player_id);
    const regularite = clamp(jr?.regularite ?? 11, 1, 20);
    const ecartTypeNote = clamp(0.55 - regularite * 0.02, 0.15, 0.5); // joueur régulier = notes resserrées

    // Un entrant a joué moins longtemps : note de base plus prudente, sauf s'il a pesé sur le match (but/passe)
    const baseEntrant = slot.entrant ? 6.0 - clamp((slot.minuteEntree - 46) / 90, 0, 0.3) : 6.0;
    let note = baseEntrant + bruitGaussien(ecartTypeNote);

    const butsSlot = buteurs.filter((b) => b.game_club_id === gameClubId && b.buteur_id === slot.player_id).length;
    const passesSlot = passeurs.filter((p) => p.game_club_id === gameClubId && p.passeur_id === slot.player_id).length;
    const cartonsSlot = cartons.filter((c) => c.game_club_id === gameClubId && c.player_id === slot.player_id);

    note += butsSlot * 1.1;
    note += passesSlot * 0.6;
    // Un but/une passe décisive d'un entrant "pèse" un peu plus dans le récit du match (impact banc)
    if (slot.entrant && (butsSlot > 0 || passesSlot > 0)) note += 0.3;
    for (const c of cartonsSlot) {
      if (c.type === 'jaune') note -= 0.3;
      if (c.type === 'deuxieme_jaune' || c.type === 'rouge_direct') note -= 1.2;
    }

    if (slot.role === 'GB') {
      // bonus si clean sheet-ish (peu de buts encaissés côté adverse -> approx via arrets déjà comptés dans stats)
      note += (statsEquipe.arrets ?? 0) * 0.12;
    }

    if (victoire) note += 0.25;
    else if (!nul) note -= 0.15;

    return {
      player_id: slot.player_id,
      player_nom: slot.player_nom,
      entrant: slot.entrant || false,
      note: Math.round(clamp(note, 2, 10) * 10) / 10,
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
    const equipe = b.game_club_id === buteurs[0]?.game_club_id ? '' : '';
    return `${b.buteur_nom} (${b.minute}e)`;
  });

  const phraseButs = phrasesButs.length
    ? ` Buts inscrits par ${phrasesButs.join(', ')}.`
    : ' Aucune des deux équipes n\'a trouvé la faille.';

  return `${phrase1} avec ${dominant} plus dominant dans le jeu.${phraseButs}`;
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
 * @returns {object} prêt à écrire dans `calendrier` (score_domicile, score_exterieur, stats)
 */
function simulerMatch({ domicile, exterieur, contexte = {} }) {
  const compoDom = domicile.tactique.compositions;
  const compoExt = exterieur.tactique.compositions;

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

  // Étape 2 (domination ajustée par le mismatch tactique)
  const domination = calculerDomination(forceDom, forceExt, mismatchDom, mismatchExt);

  // Étape 3
  const stats = genererStatistiques(domination, forceDom, forceExt);

  // Étape 4 (les buts de chaque équipe dépendent de sa propre attaque et du gardien adverse)
  const resultatDom = calculerButsEquipe(stats.domicile, forceDom.noteAttaque, forceExt.noteGardien, contexte);
  const resultatExt = calculerButsEquipe(stats.exterieur, forceExt.noteAttaque, forceDom.noteGardien, contexte);
  stats.domicile.arrets_gardien_adverse = resultatExt.arrets; // arrêts réalisés PAR le gardien adverse sur les tirs de dom
  stats.exterieur.arrets_gardien_adverse = resultatDom.arrets;

  // Cohérence : jamais plus de buts que de tirs cadrés
  const scoreDom = Math.min(resultatDom.buts, stats.domicile.tirs_cadres);
  const scoreExt = Math.min(resultatExt.buts, stats.exterieur.tirs_cadres);

  // Étape 4bis — banc et remplacements (5 max), basés sur le reste de l'effectif équipe_a
  const compoDomAvecNote = forceDom.titulairesNotes.map((t) => ({ ...t.slot, note: t.note }));
  const compoExtAvecNote = forceExt.titulairesNotes.map((t) => ({ ...t.slot, note: t.note }));
  const bancDom = selectionnerBanc(compoDom, domicile.joueurs);
  const bancExt = selectionnerBanc(compoExt, exterieur.joueurs);
  const remplacementsDom = genererRemplacements(compoDomAvecNote, bancDom, forceDom.niveauCoach, forceDom.adaptabiliteCoach).map((r) => ({ ...r, game_club_id: domicile.gameClubId }));
  const remplacementsExt = genererRemplacements(compoExtAvecNote, bancExt, forceExt.niveauCoach, forceExt.adaptabiliteCoach).map((r) => ({ ...r, game_club_id: exterieur.gameClubId }));

  // Étapes 5 & 6 (les remplaçants entrés en jeu peuvent être buteur/passeur)
  const buteursDom = genererButeursEtPasseurs(scoreDom, compoDom, domicile.joueurs, domicile.gameClubId, remplacementsDom);
  const buteursExt = genererButeursEtPasseurs(scoreExt, compoExt, exterieur.joueurs, exterieur.gameClubId, remplacementsExt);
  const tousLesButs = [...buteursDom, ...buteursExt].sort((a, b) => a.minute - b.minute);

  // Étape 7
  const cartonsDom = genererCartonsEquipe(stats.domicile.fautes, compoDom, domicile.joueurs, domicile.gameClubId, remplacementsDom);
  const cartonsExt = genererCartonsEquipe(stats.exterieur.fautes, compoExt, exterieur.joueurs, exterieur.gameClubId, remplacementsExt);
  const tousLesCartons = [...cartonsDom, ...cartonsExt].sort((a, b) => a.minute - b.minute);

  // Étape 8
  const intensiteMatch = clamp((domination.danger.domicile + domination.danger.exterieur) / 140, 0.3, 1.3);
  const blessuresDom = genererBlessuresEquipe(compoDom, domicile.joueurs, domicile.gameClubId, intensiteMatch, remplacementsDom);
  const blessuresExt = genererBlessuresEquipe(compoExt, exterieur.joueurs, exterieur.gameClubId, intensiteMatch, remplacementsExt);
  const toutesLesBlessures = [...blessuresDom, ...blessuresExt].sort((a, b) => a.minute - b.minute);

  // Étape 9 (notes incluant les entrants, variance selon la régularité de chaque joueur)
  const notesDom = calculerNotesJoueurs({
    compositions: compoDom,
    joueurs: domicile.joueurs,
    remplacements: remplacementsDom,
    gameClubId: domicile.gameClubId,
    buteurs: tousLesButs,
    passeurs: tousLesButs, // les passeurs sont inclus dans les mêmes objets "but"
    cartons: tousLesCartons,
    statsEquipe: { arrets: resultatExt.arrets },
    victoire: scoreDom > scoreExt,
    nul: scoreDom === scoreExt,
  });
  const notesExt = calculerNotesJoueurs({
    compositions: compoExt,
    joueurs: exterieur.joueurs,
    remplacements: remplacementsExt,
    gameClubId: exterieur.gameClubId,
    buteurs: tousLesButs,
    passeurs: tousLesButs,
    cartons: tousLesCartons,
    statsEquipe: { arrets: resultatDom.arrets },
    victoire: scoreExt > scoreDom,
    nul: scoreDom === scoreExt,
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

  return {
    score_domicile: scoreDom,
    score_exterieur: scoreExt,
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
      buteurs: tousLesButs.map(({ minute, game_club_id, buteur_id, buteur_nom }) => ({ minute, game_club_id, player_id: buteur_id, player_nom: buteur_nom })),
      passeurs: tousLesButs.filter((b) => b.passeur_id).map((b) => ({ minute: b.minute, game_club_id: b.game_club_id, player_id: b.passeur_id, player_nom: b.passeur_nom, but_de: b.buteur_id })),
      cartons: tousLesCartons,
      blessures: toutesLesBlessures,
      remplacements: [...remplacementsDom, ...remplacementsExt].sort((a, b) => a.minute - b.minute),
      notes_joueurs: { domicile: notesDom, exterieur: notesExt },
      homme_du_match: hommeDuMatch,
      resume,
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
  calculerButsEquipe,
  genererButeursEtPasseurs,
  genererCartonsEquipe,
  genererBlessuresEquipe,
  calculerNotesJoueurs,
  genererResume,
  noteJoueurMatch,
  // impact tactique
  profilTactique,
  calculerMismatchTactique,
  // banc / remplacements
  selectionnerBanc,
  genererRemplacements,
  compositionEffective,
  inferRolePrincipal,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MOTEUR_MATCH_EXPORTS;
}
