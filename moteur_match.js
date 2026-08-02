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

  let note = noteAttributs * 0.55 + ca * 0.45;
  note *= 0.85 + 0.15 * forme; // la forme pèse pour 15%
  note *= 0.92 + 0.08 * moral; // le moral pèse pour 8%

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
 * @param {object} p.coach - ligne game_staff (niveau_tactique, niveau_attaque, niveau_defense) ou null
 * @param {object} p.club - ligne clubs/game_clubs (reputation, niveau_pct)
 * @param {object} p.contexte - { domicile, enjeu (0-1), meteo }
 */
function calculerForceEquipe({ compositions, joueurs, tactique, coach, club, contexte }) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));

  const titulairesNotes = compositions.map((slot) => {
    const jr = joueursParId.get(slot.player_id);
    if (!jr) return { slot, note: 50, categorie: profilRole(slot.role).categorie };
    return { slot, note: noteJoueurMatch(jr, slot.role), categorie: profilRole(slot.role).categorie, joueur: jr };
  });

  const noteEffectif = moyenne(titulairesNotes.map((t) => t.note));

  // Cohésion collective : familiarité tactique (fit_score moyen des slots) + connaissance tactique du coach
  const fitScoreMoyen = moyenne(compositions.map((c) => c.fit_score ?? 2)) / 3; // fit_score 0-3
  const connaissanceTactique = clamp((tactique?.connaissance_tactique ?? 12) / 20, 0, 1);
  const cohesion = clamp(0.5 + 0.3 * fitScoreMoyen + 0.2 * connaissanceTactique, 0.5, 1.15);

  // Staff : niveau tactique du coach module la note d'ensemble
  const niveauCoach = coach
    ? clamp(((coach.niveau_tactique ?? 12) + (coach.niveau_attaque ?? 12) + (coach.niveau_defense ?? 12)) / 3 / 20, 0.4, 1)
    : 0.7;

  // Contexte : avantage du terrain, enjeu (pression), météo pénalise légèrement le jeu technique
  const bonusDomicile = contexte?.domicile ? 1.06 : 0.97;
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
  };
}

// ============================================================
// ÉTAPE 2 — DOMINATION
// ============================================================

/**
 * Détermine possession / intensité de chaque équipe à partir de leur force.
 * Une équipe plus forte domine statistiquement plus souvent, sans certitude.
 */
function calculerDomination(forceDom, forceExt) {
  const diff = forceDom.noteGlobale - forceExt.noteGlobale; // typiquement -60..+60
  const bruit = bruitGaussien(6); // légère variabilité match à match
  const diffAjuste = diff + bruit;

  // Logistique centrée : possession moyenne 50%, s'écarte selon l'écart de force
  const possessionDom = clamp(50 + diffAjuste * 0.45, 28, 72);
  const possessionExt = 100 - possessionDom;

  // Pression/occasions dépendent surtout de l'attaque adverse vs milieu/défense
  const dangerDom = clamp(50 + (forceDom.noteAttaque - forceExt.noteDefense) * 0.5 + bruitGaussien(4), 15, 90);
  const dangerExt = clamp(50 + (forceExt.noteAttaque - forceDom.noteDefense) * 0.5 + bruitGaussien(4), 15, 90);

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
  const occasionsFranches = clamp(Math.round(dangerScore / 14 + bruitGaussien(0.6)), 0, 10);

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
    // probabilité de base d'une occasion franche ~ 22%, modulée par le niveau des deux côtés
    const probaBut = clamp(0.22 + (qualiteFinition - qualiteGardien) * 0.35, 0.04, 0.6) * facteurPression;
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

function genererButeursEtPasseurs(nbButs, compositions, joueurs, gameClubId) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const evenements = [];

  for (let i = 0; i < nbButs; i++) {
    const slotButeur = attribuerButeur(compositions, joueursParId);
    if (!slotButeur) continue;
    const slotPasseur = attribuerPasseur(compositions, joueursParId, slotButeur);

    evenements.push({
      minute: minuteAleatoire(),
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

function genererCartonsEquipe(fautes, compositions, joueurs, gameClubId) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const cartons = [];
  const dejaJaune = new Set();

  for (let i = 0; i < fautes; i++) {
    // ~14% des fautes donnent un carton jaune
    if (!proba(0.14)) continue;

    const slot = tirerJoueurPondere(compositions, joueursParId, (profil, note, jr) => {
      const agressivite = jr?.agressivite ?? 10;
      const tacles = jr?.tacles ?? 10;
      return profil.poidsCarton * (0.4 + (agressivite + tacles) / 40);
    });
    if (!slot) continue;

    if (dejaJaune.has(slot.player_id)) {
      cartons.push({ minute: minuteAleatoire(), game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'deuxieme_jaune' });
    } else {
      dejaJaune.add(slot.player_id);
      cartons.push({ minute: minuteAleatoire(), game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'jaune' });
      // petite chance de carton rouge direct indépendant (tacle très dangereux)
      if (proba(0.015)) {
        cartons.push({ minute: minuteAleatoire(), game_club_id: gameClubId, player_id: slot.player_id, player_nom: slot.player_nom, type: 'rouge_direct' });
      }
    }
  }

  return cartons.sort((a, b) => a.minute - b.minute);
}

// ============================================================
// ÉTAPE 8 — BLESSURES
// ============================================================

function genererBlessuresEquipe(compositions, joueurs, gameClubId, intensiteMatch) {
  const joueursParId = new Map(joueurs.map((j) => [j.id, j]));
  const blessures = [];

  for (const slot of compositions) {
    const jr = joueursParId.get(slot.player_id);
    if (!jr) continue;
    const tendance = clamp((jr.tendance_blessure ?? 10) / 20, 0.05, 1); // plus haut = plus fragile
    const endurance = clamp((jr.endurance ?? 12) / 20, 0.3, 1);
    const probaBase = 0.006; // ~0.6% par joueur par match en moyenne
    const p = probaBase * (0.5 + tendance) * (1.3 - endurance * 0.4) * (0.8 + intensiteMatch * 0.4);
    if (proba(p)) {
      blessures.push({
        minute: minuteAleatoire(),
        game_club_id: gameClubId,
        player_id: slot.player_id,
        player_nom: slot.player_nom,
        gravite: tirageAlPondere([
          { item: 'legere', poids: 6 },
          { item: 'moyenne', poids: 3 },
          { item: 'grave', poids: 1 },
        ]),
      });
    }
  }

  return blessures;
}

// ============================================================
// ÉTAPE 9 — NOTES DES JOUEURS / HOMME DU MATCH
// ============================================================

function calculerNotesJoueurs({ compositions, gameClubId, buteurs, passeurs, cartons, statsEquipe, victoire, nul }) {
  const notes = compositions.map((slot) => {
    let note = 6.0 + bruitGaussien(0.35);

    const butsSlot = buteurs.filter((b) => b.game_club_id === gameClubId && b.buteur_id === slot.player_id).length;
    const passesSlot = passeurs.filter((p) => p.game_club_id === gameClubId && p.passeur_id === slot.player_id).length;
    const cartonsSlot = cartons.filter((c) => c.game_club_id === gameClubId && c.player_id === slot.player_id);

    note += butsSlot * 1.1;
    note += passesSlot * 0.6;
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

    return { player_id: slot.player_id, player_nom: slot.player_nom, note: Math.round(clamp(note, 2, 10) * 10) / 10 };
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
 * @param {object} p.domicile - { gameClubId, nom, joueurs, tactique, coach }
 * @param {object} p.exterieur - { gameClubId, nom, joueurs, tactique, coach }
 * @param {object} [p.contexte] - { enjeu: 0-1, meteo: 'normale'|... }
 * @returns {object} prêt à écrire dans `calendrier` (score_domicile, score_exterieur, stats)
 */
function simulerMatch({ domicile, exterieur, contexte = {} }) {
  const compoDom = domicile.tactique.compositions;
  const compoExt = exterieur.tactique.compositions;

  // Étape 1
  const forceDom = calculerForceEquipe({
    compositions: compoDom,
    joueurs: domicile.joueurs,
    tactique: domicile.tactique,
    coach: domicile.coach,
    club: domicile.club,
    contexte: { ...contexte, domicile: true },
  });
  const forceExt = calculerForceEquipe({
    compositions: compoExt,
    joueurs: exterieur.joueurs,
    tactique: exterieur.tactique,
    coach: exterieur.coach,
    club: exterieur.club,
    contexte: { ...contexte, domicile: false },
  });

  // Étape 2
  const domination = calculerDomination(forceDom, forceExt);

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

  // Étapes 5 & 6
  const buteursDom = genererButeursEtPasseurs(scoreDom, compoDom, domicile.joueurs, domicile.gameClubId);
  const buteursExt = genererButeursEtPasseurs(scoreExt, compoExt, exterieur.joueurs, exterieur.gameClubId);
  const tousLesButs = [...buteursDom, ...buteursExt].sort((a, b) => a.minute - b.minute);

  // Étape 7
  const cartonsDom = genererCartonsEquipe(stats.domicile.fautes, compoDom, domicile.joueurs, domicile.gameClubId);
  const cartonsExt = genererCartonsEquipe(stats.exterieur.fautes, compoExt, exterieur.joueurs, exterieur.gameClubId);
  const tousLesCartons = [...cartonsDom, ...cartonsExt].sort((a, b) => a.minute - b.minute);

  // Étape 8
  const intensiteMatch = clamp((domination.danger.domicile + domination.danger.exterieur) / 140, 0.3, 1.3);
  const blessuresDom = genererBlessuresEquipe(compoDom, domicile.joueurs, domicile.gameClubId, intensiteMatch);
  const blessuresExt = genererBlessuresEquipe(compoExt, exterieur.joueurs, exterieur.gameClubId, intensiteMatch);
  const toutesLesBlessures = [...blessuresDom, ...blessuresExt].sort((a, b) => a.minute - b.minute);

  // Étape 9
  const notesDom = calculerNotesJoueurs({
    compositions: compoDom,
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
      notes_joueurs: { domicile: notesDom, exterieur: notesExt },
      homme_du_match: hommeDuMatch,
      resume,
    },
  };
}

module.exports = {
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
};
