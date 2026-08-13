import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  getDocs, deleteDoc,
  creerCompteSecondaire, uploaderPhotoProfil, changerMotDePasse,
} from "./firebase-config.js";

import {
  genererCodeParrain, formatGNF, formatDate, nomMois, calculerSoldes, notifier, calculerStatutContrat,
} from "./utils.js";

const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23ddd'/></svg>";

const state = {
  entreprise: null,
  currentUser: null,
  users: [],
  contracts: [],
  payments: [],
  decaissements: [],
  membresEnAttente: [],
  substitutionId: null,
  prets: [],
  remboursements: [],
  versementsCollecteur: [],
  collecteurSelectionne: null,
  retraits: [],
  retraitsConfirmes: [],
  interetsPartages: [],
  retraitsCommission: [],
  unsubscribers: [],
  // --- Navigation par zone dans l'onglet Collecteurs ---
  vueZone: {
    niveau: "prefectures", // "prefectures" | "sous_prefectures" | "collecteurs"
    prefecture: null,
    sousPrefecture: null,
  },
};
let creationEnCours = false;

function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.cpct-tina.local`;
}

const screens = ["screen-loading", "screen-onboarding-entreprise", "screen-onboarding-pdg", "screen-login", "screen-dashboard"];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}

async function demarrer() {
  showScreen("screen-loading");
  const entrepriseSnap = await getDoc(doc(db, "entreprise", "info"));
  if (entrepriseSnap.exists()) {
    state.entreprise = entrepriseSnap.data();
    document.getElementById("login-entreprise-nom").textContent = state.entreprise.nom;
  }

  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      if (userSnap.exists() && userSnap.data().role === "pdg") {
        state.currentUser = { uid: user.uid, ...userSnap.data() };
        lancerDashboard();
        return;
      } else {
        await signOut(auth);
      }
    }
    if (state.entreprise) {
      showScreen("screen-login");
    } else {
      showScreen("screen-onboarding-entreprise");
    }
  });
}

document.getElementById("form-entreprise").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = {
    nom: fd.get("nom").trim(),
    siege: fd.get("siege").trim(),
    date_creation: fd.get("date_creation"),
    fondateur: fd.get("fondateur").trim(),
    contact: fd.get("contact").trim(),
  };
  try {
    await setDoc(doc(db, "entreprise", "info"), data);
    state.entreprise = data;
    showScreen("screen-onboarding-pdg");
  } catch (err) {
    notifier("Erreur lors de la création de l'entreprise : " + err.message, "erreur");
  }
});

document.getElementById("form-pdg").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get("email").trim();
  const password = fd.get("password");
  const nom = fd.get("nom").trim();
  const telephone = fd.get("telephone").trim();
  const residence = fd.get("residence").trim();

  creationEnCours = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const codeParrain = genererCodeParrain("PDG");
    const userData = {
      role: "pdg",
      nom, telephone, email, residence,
      code_parrain: codeParrain,
      parrain_id: null,
      statut: "actif",
      date_creation: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), userData);
    notifier("Compte PDG créé avec succès.", "succes");
    state.currentUser = { uid: cred.user.uid, ...userData };
    creationEnCours = false;
    lancerDashboard();
  } catch (err) {
    notifier("Erreur : " + err.message, "erreur");
    if (auth.currentUser) {
      try { await auth.currentUser.delete(); } catch (e2) { /* ignore */ }
      try { await signOut(auth); } catch (e3) { /* ignore */ }
    }
    creationEnCours = false;
  }
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await signInWithEmailAndPassword(auth, fd.get("email").trim(), fd.get("password"));
  } catch (err) {
    notifier("Identifiants incorrects.", "erreur");
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  state.unsubscribers.forEach((u) => u());
  state.unsubscribers = [];
  await signOut(auth);
  showScreen("screen-login");
});

// --- Photo de profil du PDG ---
document.getElementById("pdg-avatar-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !state.currentUser) return;
  try {
    const url = await uploaderPhotoProfil(state.currentUser.uid, file);
    await updateDoc(doc(db, "users", state.currentUser.uid), { photoURL: url });
    state.currentUser.photoURL = url;
    document.getElementById("pdg-avatar").src = url;
    notifier("Photo de profil mise à jour.", "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur lors de l'envoi de la photo : " + err.message, "erreur");
  }
});

// --- Changement de mot de passe ---
function ajouterBoutonChangerMotDePasse() {
  if (document.getElementById("btn-changer-mdp")) return;
  const btnLogout = document.getElementById("btn-logout");
  if (!btnLogout) return;
  btnLogout.insertAdjacentHTML(
    "beforebegin",
    `<button id="btn-changer-mdp" class="btn btn-ghost">Changer mon mot de passe</button>`
  );
  document.getElementById("btn-changer-mdp").addEventListener("click", ouvrirChangementMotDePasse);
}

function ouvrirChangementMotDePasse() {
  ouvrirModal(`
    <h2>Changer mon mot de passe</h2>
    <p class="subtitle-sm">Confirmez votre mot de passe actuel puis saisissez le nouveau.</p>
    <form id="form-changer-mdp">
      <div class="field-row">
        <label>Mot de passe actuel</label>
        <input type="password" name="ancien" required />
      </div>
      <div class="field-row">
        <label>Nouveau mot de passe (6 caractères min)</label>
        <input type="password" name="nouveau" minlength="6" required />
      </div>
      <div class="field-row">
        <label>Confirmer le nouveau mot de passe</label>
        <input type="password" name="confirmation" minlength="6" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-changer-mdp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ancien = fd.get("ancien");
    const nouveau = fd.get("nouveau");
    const confirmation = fd.get("confirmation");

    if (nouveau !== confirmation) {
      notifier("Les deux mots de passe ne correspondent pas.", "erreur");
      return;
    }

    try {
      await changerMotDePasse(state.currentUser.email, ancien, nouveau);
      notifier("Mot de passe modifié avec succès.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
        notifier("Mot de passe actuel incorrect.", "erreur");
      } else {
        notifier("Erreur : " + err.message, "erreur");
      }
    }
  });
}

function lancerDashboard() {
  showScreen("screen-dashboard");
  document.getElementById("db-entreprise-nom").textContent = state.entreprise?.nom || "CPCT-TINA";
  document.getElementById("db-pdg-nom").textContent = state.currentUser.nom;
  document.getElementById("pdg-avatar").src = state.currentUser.photoURL || AVATAR_DEFAUT;
  ajouterBoutonChangerMotDePasse();

  const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    state.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    render();
  });
  const unsubContracts = onSnapshot(collection(db, "contracts"), (snap) => {
    state.contracts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubPayments = onSnapshot(collection(db, "payments"), (snap) => {
    state.payments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubDecaissements = onSnapshot(collection(db, "decaissements"), (snap) => {
    state.decaissements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubAttente = onSnapshot(collection(db, "membres_en_attente_validation"), (snap) => {
    state.membresEnAttente = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((m) => m.statut === "en_attente_validation");
    render();
  });
  const unsubRetraits = onSnapshot(
    query(collection(db, "withdrawalRequests"), where("statut", "==", "en_attente")),
    (snap) => {
      state.retraits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubRetraitsConfirmes = onSnapshot(
    query(collection(db, "withdrawalRequests"), where("statut", "==", "confirme")),
    (snap) => {
      state.retraitsConfirmes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubPrets = onSnapshot(collection(db, "prets"), (snap) => {
    state.prets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubRemboursements = onSnapshot(collection(db, "remboursements_prets"), (snap) => {
    state.remboursements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubVersementsCollecteur = onSnapshot(collection(db, "versements_collecteur"), (snap) => {
    state.versementsCollecteur = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubInterets = onSnapshot(collection(db, "interets_prets_repartis"), (snap) => {
    state.interetsPartages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubRetraitsCommission = onSnapshot(collection(db, "retraits_commission"), (snap) => {
    state.retraitsCommission = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  state.unsubscribers.push(unsubUsers, unsubContracts, unsubPayments, unsubDecaissements, unsubAttente, unsubRetraits, unsubRetraitsConfirmes, unsubPrets, unsubRemboursements, unsubVersementsCollecteur, unsubInterets, unsubRetraitsCommission);
}

function render() {
  renderApercu();
  renderCollecteurs();
  renderMembres();
  renderConfirmations();
  renderMembresEnAttente();
  renderRetraits();
}

function renderApercu() {
  const { totalEpargnes, totalCommissions, parMois } = calculerSoldes(state.payments, state.contracts);
  const totalDecaisse = (state.decaissements || []).reduce((s, d) => s + Number(d.montant), 0);
  const totalInteretsPdg = state.interetsPartages.reduce((s, i) => s + Number(i.montant_pdg || 0), 0);
  const totalRetraitsCommissionPdg = state.retraitsCommission
    .filter((r) => r.beneficiaire_role === "pdg" && r.statut === "confirme")
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  const commissionsDisponibles = totalCommissions + totalInteretsPdg - totalDecaisse - totalRetraitsCommissionPdg;

  const totalRetraitsConfirmes = (state.retraitsConfirmes || []).reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalPretsEnCours = state.prets.filter((p) => p.statut === "actif").reduce((s, p) => s + Number(p.montant_initial || 0), 0);
  const totalRemboursements = (state.remboursements || []).reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalInteretsRecuperes = state.interetsPartages.reduce((s, i) => s + Number(i.montant_collecteur || 0) + Number(i.montant_pdg || 0), 0);
  const totalCapitalRembourse = Math.max(0, totalRemboursements - totalInteretsRecuperes);
  const soldeGlobalEpargnes = totalEpargnes - totalRetraitsConfirmes - totalPretsEnCours + totalCapitalRembourse;

  document.getElementById("stat-total-epargnes").textContent = formatGNF(soldeGlobalEpargnes > 0 ? soldeGlobalEpargnes : 0);
  document.getElementById("stat-total-commissions").textContent = formatGNF(commissionsDisponibles);
  document.getElementById("stat-nb-collecteurs").textContent = state.users.filter((u) => u.role === "collecteur" && u.statut === "actif").length;
  document.getElementById("stat-nb-membres").textContent = state.users.filter((u) => u.role === "membre").length;

  const cles = Object.keys(parMois).sort().reverse();
  const container = document.getElementById("monthly-breakdown");
  if (cles.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune donnée pour le moment.</p>`;
  } else {
    container.innerHTML = cles.slice(0, 12).map((cle) => `
      <div class="monthly-row">
        <span class="monthly-mois">${nomMois(cle)}</span>
        <span class="monthly-detail">
          Épargnes : <b class="epargne">${formatGNF(parMois[cle].epargnes)}</b><br/>
          Commissions : <b class="commission">${formatGNF(parMois[cle].commissions)}</b>
        </span>
      </div>
    `).join("");
  }
}

document.getElementById("titre-historique-mensuel").addEventListener("click", () => {
  const titre = document.getElementById("titre-historique-mensuel");
  const zone = document.getElementById("monthly-breakdown");
  zone.classList.toggle("hidden");
  titre.classList.toggle("ouvert");
});

// --- Épargne nette d'un contrat : le prêt NE la réduit PAS (règle validée le 2 août) ---
function calculerEpargneNetteContrat(contrat) {
  const versements = state.payments.filter((p) => p.contract_id === contrat.id);
  return versements
    .filter((p) => p.statut === "confirme" && p.jour_numero > 1)
    .reduce((s, p) => s + Number(p.montant || 0), 0);
}

function calculerSoldeDisponible(contrat) {
  const epargneNette = calculerEpargneNetteContrat(contrat);
  const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif");
  const pretDu = pret ? calculerMontantDuPret(pret) : 0;
  return Math.max(0, epargneNette - pretDu);
}

function avatarImg(u, taille) {
  const classe = taille === "mini" ? "avatar-mini" : "avatar-pdg";
  return `<img class="${classe}" src="${u && u.photoURL ? u.photoURL : AVATAR_DEFAUT}" alt="${u ? u.nom : ''}" />`;
}

// --- Commission PDG (part 70%) générée à travers un collecteur donné ---
function calculerCommissionPdgParCollecteur(collecteurId) {
  const jour1Confirmes = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero === 1
  );
  const totalJour1Confirme = jour1Confirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionPdgInscriptions = totalJour1Confirme * 0.70;

  const interetsPdgCollecteur = state.interetsPartages
    .filter((i) => i.collecteur_id === collecteurId)
    .reduce((s, i) => s + Number(i.montant_pdg || 0), 0);

  const commissionPdgTotale = commissionPdgInscriptions + interetsPdgCollecteur;

  const retraitsPdgConfirmes = state.retraitsCommission
    .filter((r) => r.beneficiaire_role === "pdg" && r.collecteur_id === collecteurId && r.statut === "confirme")
    .reduce((s, r) => s + Number(r.montant || 0), 0);

  return Math.max(0, commissionPdgTotale - retraitsPdgConfirmes);
}

// --- Commission du collecteur lui-même (part 30%) ---
function calculerCommissionCollecteurPropre(collecteurId) {
  const jour1Confirmes = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero === 1
  );
  const totalJour1Confirme = jour1Confirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionInscriptions = totalJour1Confirme * 0.30;

  const interetsCollecteur = state.interetsPartages
    .filter((i) => i.collecteur_id === collecteurId)
    .reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);

  return commissionInscriptions + interetsCollecteur;
}

// --- Solde d'épargne net (total, tous contrats actifs) d'un collecteur ---
function calculerSoldeEpargneNetCollecteur(collecteurId) {
  const contratsCollecteur = state.contracts.filter((ct) => ct.collecteur_id === collecteurId && ct.statut === "actif");
  return contratsCollecteur.reduce((s, ct) => s + Math.max(0, calculerEpargneNetteContrat(ct)), 0);
}

// --- Liste des zones (préfecture/commune) ayant au moins un collecteur, triée alphabétiquement ---
function listerPrefecturesAvecCollecteurs() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const zones = new Set();
  collecteurs.forEach((c) => {
    if (c.prefecture) zones.add(c.prefecture);
  });
  return Array.from(zones).sort((a, b) => a.localeCompare(b, "fr"));
}

// --- Liste des sous-préfectures/quartiers d'une préfecture donnée, triée alphabétiquement ---
function listerSousPrefectures(prefecture) {
  const collecteurs = state.users.filter(
    (u) => u.role === "collecteur" && u.statut !== "supprime" && u.prefecture === prefecture
  );
  const zones = new Set();
  collecteurs.forEach((c) => {
    zones.add(c.sous_prefecture && c.sous_prefecture.trim() ? c.sous_prefecture.trim() : "Non précisé");
  });
  return Array.from(zones).sort((a, b) => a.localeCompare(b, "fr"));
}

function renderCollecteurs() {
  const container = document.getElementById("liste-collecteurs");
  const { niveau, prefecture, sousPrefecture } = state.vueZone;

  // --- Niveau 1 : liste des préfectures/communes ---
  if (niveau === "prefectures") {
    const zones = listerPrefecturesAvecCollecteurs();
    if (zones.length === 0) {
      container.innerHTML = `<p class="empty-state">Aucun collecteur enregistré. Générez un code pour en inviter un.</p>`;
      return;
    }
    container.innerHTML = `
      <div class="card" style="margin-bottom:12px;">
        <h2 style="font-size:15px; margin-bottom:6px;">Préfectures / Communes</h2>
        <p class="subtitle-sm">Tapez sur une zone pour voir ses collecteurs.</p>
      </div>
      ${zones.map((z) => {
        const nb = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime" && u.prefecture === z).length;
        return `
          <div class="entity-card" data-action="ouvrir-prefecture" data-zone="${z}" style="cursor:pointer;">
            <div class="entity-card-top">
              <p class="entity-nom">${z}</p>
              <span class="badge badge-actif">${nb} collecteur(s)</span>
            </div>
          </div>
        `;
      }).join("")}
    `;
    return;
  }

  // --- Niveau 2 : liste des sous-préfectures/quartiers d'une préfecture ---
  if (niveau === "sous_prefectures") {
    const zones = listerSousPrefectures(prefecture);
    container.innerHTML = `
      <button class="btn btn-ghost-sm" data-action="retour-prefectures" style="margin-bottom:12px;">← Retour aux préfectures/communes</button>
      <div class="card" style="margin-bottom:12px;">
        <h2 style="font-size:15px; margin-bottom:6px;">${prefecture}</h2>
        <p class="subtitle-sm">Sous-préfectures / Quartiers</p>
      </div>
      ${zones.map((z) => {
        const nb = state.users.filter((u) =>
          u.role === "collecteur" && u.statut !== "supprime" && u.prefecture === prefecture &&
          (u.sous_prefecture && u.sous_prefecture.trim() ? u.sous_prefecture.trim() : "Non précisé") === z
        ).length;
        return `
          <div class="entity-card" data-action="ouvrir-sous-prefecture" data-zone="${z}" style="cursor:pointer;">
            <div class="entity-card-top">
              <p class="entity-nom">${z}</p>
              <span class="badge badge-actif">${nb} collecteur(s)</span>
            </div>
          </div>
        `;
      }).join("")}
    `;
    return;
  }

  // --- Niveau 3 : liste des collecteurs de cette sous-préfecture/quartier ---
  const collecteurs = state.users.filter((u) =>
    u.role === "collecteur" && u.statut !== "supprime" && u.prefecture === prefecture &&
    (u.sous_prefecture && u.sous_prefecture.trim() ? u.sous_prefecture.trim() : "Non précisé") === sousPrefecture
  );

  if (collecteurs.length === 0) {
    container.innerHTML = `
      <button class="btn btn-ghost-sm" data-action="retour-sous-prefectures" style="margin-bottom:12px;">← Retour</button>
      <p class="empty-state">Aucun collecteur dans cette zone.</p>
    `;
    return;
  }

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === "confirme");

  container.innerHTML = `
    <button class="btn btn-ghost-sm" data-action="retour-sous-prefectures" style="margin-bottom:12px;">← Retour</button>
    <div class="card" style="margin-bottom:12px;">
      <h2 style="font-size:15px; margin-bottom:2px;">${prefecture} — ${sousPrefecture}</h2>
    </div>
    ${collecteurs.map((c) => {
      const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === c.uid).length;
      const badgeClasse = c.statut === "actif" ? "badge-actif" : c.statut === "suspendu" ? "badge-suspendu" : "badge-licencie";

      const contratsCollecteur = state.contracts.filter((ct) => ct.collecteur_id === c.uid);
      let nbActifs = 0;
      let nbInactifs = 0;
      contratsCollecteur.forEach((ct) => {
        if (ct.statut === "actif") {
          const statutCalc = calculerStatutContrat(ct, versementsConfirmesTous);
          if (statutCalc === "inactif") { nbInactifs++; } else { nbActifs++; }
        }
      });

      const TC = state.payments.filter((p) => p.collecteur_id === c.uid).reduce((s, p) => s + Number(p.montant || 0), 0);
      const TV = state.versementsCollecteur.filter((v) => v.collecteur_id === c.uid).reduce((s, v) => s + Number(v.montant || 0), 0);
      const resteAVerser = TC - TV;

      const pretsCollecteur = state.prets.filter((p) => p.collecteur_id === c.uid && p.statut === "actif");
      const totalPretsEnCours = pretsCollecteur.reduce((s, p) => s + Number(p.montant_initial || 0), 0);

      const commissionPdg = calculerCommissionPdgParCollecteur(c.uid);
      const commissionCollecteur = calculerCommissionCollecteurPropre(c.uid);
      const commissionGlobale = commissionPdg + commissionCollecteur;
      const soldeEpargneNet = calculerSoldeEpargneNetCollecteur(c.uid);

      return `
        <div class="entity-card" data-uid="${c.uid}">
          <div class="entity-card-top">
function listerPrefecturesAvecCollecteurs() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const zones = new Set();
  collecteurs.forEach((c) => {
    zones.add(c.prefecture && c.prefecture.trim() ? c.prefecture.trim() : "Non précisé");
  });
  return Array.from(zones).sort((a, b) => a.localeCompare(b, "fr"));
}

// --- Liste des sous-préfectures/quartiers d'une préfecture donnée, triée alphabétiquement ---
function listerSousPrefectures(prefecture) {
  const collecteurs = state.users.filter(
    (u) => u.role === "collecteur" && u.statut !== "supprime" &&
    (u.prefecture && u.prefecture.trim() ? u.prefecture.trim() : "Non précisé") === prefecture
  );
  const zones = new Set();
  collecteurs.forEach((c) => {
    zones.add(c.sous_prefecture && c.sous_prefecture.trim() ? c.sous_prefecture.trim() : "Non précisé");
  });
  return Array.from(zones).sort((a, b) => a.localeCompare(b, "fr"));
}

function renderCollecteurs() {
  const container = document.getElementById("liste-collecteurs");
  const { niveau, prefecture, sousPrefecture } = state.vueZone;

  // --- Niveau 1 : liste des préfectures/communes ---
  if (niveau === "prefectures") {
    const zones = listerPrefecturesAvecCollecteurs();
    if (zones.length === 0) {
      container.innerHTML = `<p class="empty-state">Aucun collecteur enregistré. Générez un code pour en inviter un.</p>`;
      return;
    }
    container.innerHTML = `
      <div class="card" style="margin-bottom:12px;">
        <h2 style="font-size:15px; margin-bottom:6px;">Préfectures / Communes</h2>
        <p class="subtitle-sm">Tapez sur une zone pour voir ses collecteurs.</p>
      </div>
      ${zones.map((z) => {
        const nb = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime" && (u.prefecture && u.prefecture.trim() ? u.prefecture.trim() : "Non précisé") === z).length;
        return `
          <div class="entity-card" data-action="ouvrir-prefecture" data-zone="${z}" style="cursor:pointer;">
            <div class="entity-card-top">
              <p class="entity-nom">${z}</p>
              <span class="badge badge-actif">${nb} collecteur(s)</span>
            </div>
          </div>
        `;
      }).join("")}
    `;
    return;
  }

  // --- Niveau 2 : liste des sous-préfectures/quartiers d'une préfecture ---
  if (niveau === "sous_prefectures") {
    const zones = listerSousPrefectures(prefecture);
    container.innerHTML = `
      <button class="btn btn-ghost-sm" data-action="retour-prefectures" style="margin-bottom:12px;">← Retour aux préfectures/communes</button>
      <div class="card" style="margin-bottom:12px;">
        <h2 style="font-size:15px; margin-bottom:6px;">${prefecture}</h2>
        <p class="subtitle-sm">Sous-préfectures / Quartiers</p>
      </div>
      ${zones.map((z) => {
        const nb = state.users.filter((u) =>
          u.role === "collecteur" && u.statut !== "supprime" &&
          (u.prefecture && u.prefecture.trim() ? u.prefecture.trim() : "Non précisé") === prefecture &&
          (u.sous_prefecture && u.sous_prefecture.trim() ? u.sous_prefecture.trim() : "Non précisé") === z
        ).length;
        return `
          <div class="entity-card" data-action="ouvrir-sous-prefecture" data-zone="${z}" style="cursor:pointer;">
            <div class="entity-card-top">
              <p class="entity-nom">${z}</p>
              <span class="badge badge-actif">${nb} collecteur(s)</span>
            </div>
          </div>
        `;
      }).join("")}
    `;
    return;
  }

  // --- Niveau 3 : liste des collecteurs de cette sous-préfecture/quartier ---
  const collecteurs = state.users.filter((u) =>
    u.role === "collecteur" && u.statut !== "supprime" &&
    (u.prefecture && u.prefecture.trim() ? u.prefecture.trim() : "Non précisé") === prefecture &&
    (u.sous_prefecture && u.sous_prefecture.trim() ? u.sous_prefecture.trim() : "Non précisé") === sousPrefecture
  );

  if (collecteurs.length === 0) {
    container.innerHTML = `
      <button class="btn btn-ghost-sm" data-action="retour-sous-prefectures" style="margin-bottom:12px;">← Retour</button>
      <p class="empty-state">Aucun collecteur dans cette zone.</p>
    `;
    return;
  }

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === "confirme");

  container.innerHTML = `
    <button class="btn btn-ghost-sm" data-action="retour-sous-prefectures" style="margin-bottom:12px;">← Retour</button>
    <div class="card" style="margin-bottom:12px;">
      <h2 style="font-size:15px; margin-bottom:2px;">${prefecture} — ${sousPrefecture}</h2>
    </div>
    ${collecteurs.map((c) => {
      const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === c.uid).length;
      const badgeClasse = c.statut === "actif" ? "badge-actif" : c.statut === "suspendu" ? "badge-suspendu" : "badge-licencie";

      const contratsCollecteur = state.contracts.filter((ct) => ct.collecteur_id === c.uid);
      let nbActifs = 0;
      let nbInactifs = 0;
      contratsCollecteur.forEach((ct) => {
        if (ct.statut === "actif") {
          const statutCalc = calculerStatutContrat(ct, versementsConfirmesTous);
          if (statutCalc === "inactif") { nbInactifs++; } else { nbActifs++; }
        }
      });

      const TC = state.payments.filter((p) => p.collecteur_id === c.uid).reduce((s, p) => s + Number(p.montant || 0), 0);
      const TV = state.versementsCollecteur.filter((v) => v.collecteur_id === c.uid).reduce((s, v) => s + Number(v.montant || 0), 0);
      const resteAVerser = TC - TV;

      const pretsCollecteur = state.prets.filter((p) => p.collecteur_id === c.uid && p.statut === "actif");
      const totalPretsEnCours = pretsCollecteur.reduce((s, p) => s + Number(p.montant_initial || 0), 0);

      const commissionPdg = calculerCommissionPdgParCollecteur(c.uid);
      const commissionCollecteur = calculerCommissionCollecteurPropre(c.uid);
      const commissionGlobale = commissionPdg + commissionCollecteur;
      const soldeEpargneNet = calculerSoldeEpargneNetCollecteur(c.uid);

      return `
        <div class="entity-card" data-uid="${c.uid}">
          <div class="entity-card-top">
            <div style="display:flex; align-items:center;">
              ${avatarImg(c, "mini")}
              <div>
                <p class="entity-nom" style="cursor:pointer; text-decoration:underline;" data-action="voir-membres" data-uid="${c.uid}">${c.nom}</p>
                <p class="entity-sub">${c.telephone} · ${nbClients} client(s)</p>
              </div>
            </div>
            <span class="badge ${badgeClasse}">${c.statut}</span>
          </div>
          <div class="detail-line"><span>Commission globale (100%)</span><span style="font-weight:bold;">${formatGNF(commissionGlobale)}</span></div>
          <div class="detail-line"><span>Commission PDG (70%)</span><span>${formatGNF(commissionPdg)}</span></div>
          <div class="detail-line"><span>Commission collecteur (30%)</span><span>${formatGNF(commissionCollecteur)}</span></div>
          <div class="detail-line"><span>Solde global d'épargne net</span><span>${formatGNF(soldeEpargneNet)}</span></div>
          <div class="detail-line"><span>Contrats actifs</span><span>${nbActifs}</span></div>
          <div class="detail-line"><span>Contrats inactifs</span><span style="${nbInactifs > 0 ? 'color:#c0392b; font-weight:bold;' : ''}">${nbInactifs}</span></div>
          <div class="detail-line"><span>Total collecté</span><span>${formatGNF(TC)}</span></div>
          <div class="detail-line"><span>Versé au PDG</span><span>${formatGNF(TV)}</span></div>
          <div class="detail-line"><span>Reste à verser</span><span style="${resteAVerser > 0 ? 'color:#c0392b; font-weight:bold;' : ''}">${formatGNF(resteAVerser)}</span></div>
          <div class="detail-line"><span>Prêts en cours (ses membres)</span><span>${formatGNF(totalPretsEnCours)}</span></div>
          <div class="entity-actions">
            <button class="btn btn-secondary btn-sm" data-action="modifier-zone" data-uid="${c.uid}" data-nom="${c.nom}" data-prefecture="${c.prefecture || ''}" data-sous-prefecture="${c.sous_prefecture || ''}">Modifier la zone</button>
            <button class="btn btn-secondary btn-sm" data-action="enregistrer-versement" data-uid="${c.uid}" data-nom="${c.nom}">Enregistrer un versement</button>
            ${commissionPdg > 0 ? `<button class="btn btn-secondary btn-sm" data-action="retirer-commission-pdg" data-uid="${c.uid}" data-nom="${c.nom}" data-disponible="${commissionPdg}">Retirer ma commission</button>` : ""}
            ${c.statut !== "licencie" ? `<button class="btn btn-ghost-sm" data-action="${c.statut === 'suspendu' ? 'reactiver' : 'suspendre'}" data-uid="${c.uid}">${c.statut === 'suspendu' ? 'Lever la suspension' : 'Suspendre'}</button>` : ""}
            ${c.statut !== "licencie" ? `<button class="btn btn-danger btn-sm" data-action="licencier" data-uid="${c.uid}">Licencier</button>` : ""}
            ${c.statut !== "actif" ? `<button class="btn btn-secondary btn-sm" data-action="substituer" data-uid="${c.uid}" data-nom="${c.nom}">Gérer ses clients</button>` : ""}
            <button class="btn btn-danger btn-sm" data-action="supprimer-collecteur" data-uid="${c.uid}" data-nom="${c.nom}">Supprimer</button>
          </div>
        </div>
      `;
    }).join("")}
  `;
}

// --- Modification de la zone d'un collecteur existant (comptes créés avant la capture de zone) ---
function ouvrirModificationZone(uid, nom, prefectureActuelle, sousPrefectureActuelle) {
  const listePrefectures = [
    "Beyla", "Boffa", "Boké", "Coyah", "Dabola", "Dalaba", "Dinguiraye",
    "Dixinn (commune de Conakry)", "Dubréka", "Faranah", "Forécariah", "Fria",
    "Gaoual", "Guéckédou", "Kaloum (commune de Conakry)", "Kankan", "Kérouané",
    "Kindia", "Kissidougou", "Koubia", "Koundara", "Kouroussa", "Labé",
    "Lélouma", "Lola", "Macenta", "Mali", "Mamou", "Mandiana",
    "Matam (commune de Conakry)", "Matoto (commune de Conakry)", "Nzérékoré",
    "Pita", "Ratoma (commune de Conakry)", "Siguiri", "Télimélé", "Tougué", "Yomou",
  ];
  ouvrirModal(`
    <h2>Modifier la zone — ${nom}</h2>
    <p class="subtitle-sm">Cette information est utilisée pour classer ce collecteur dans les listes et rapports par zone.</p>
    <form id="form-modifier-zone">
      <div class="field-row">
        <label>Préfecture / Commune</label>
        <select name="prefecture" required>
          <option value="">-- Choisir --</option>
          ${listePrefectures.map((p) => `<option value="${p}" ${p === prefectureActuelle ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <label>Sous-préfecture / Quartier</label>
        <input type="text" name="sous_prefecture" value="${sousPrefectureActuelle || ''}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-modifier-zone").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const prefecture = fd.get("prefecture").trim();
    const sousPrefecture = fd.get("sous_prefecture").trim();
    try {
      await updateDoc(doc(db, "users", uid), { prefecture, sous_prefecture: sousPrefecture });
      notifier("Zone mise à jour.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

function ouvrirRetraitCommissionPdg(collecteurId, nom, disponible) {
  ouvrirModal(`
    <h2>Retirer ma commission — via ${nom}</h2>
    <p class="subtitle-sm">Commission PDG disponible pour ce collecteur : <b>${formatGNF(disponible)}</b></p>
    <form id="form-retrait-commission-pdg">
      <div class="field-row">
        <label>Montant à retirer (GNF)</label>
        <input type="number" name="montant" min="1" max="${disponible}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer le retrait</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-retrait-commission-pdg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get("montant"));
    if (montant > disponible) {
      notifier("Montant supérieur à la commission disponible pour ce collecteur.", "erreur");
      return;
    }
    try {
      await addDoc(collection(db, "retraits_commission"), {
        beneficiaire_role: "pdg",
        collecteur_id: collecteurId,
        collecteur_nom: nom,
        montant,
        statut: "confirme",
        date: serverTimestamp(),
        date_confirmation: serverTimestamp(),
      });
      notifier("Retrait de commission enregistré.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

function ouvrirVersementCollecteur(collecteurId, nom) {
  const TC = state.payments.filter((p) => p.collecteur_id === collecteurId).reduce((s, p) => s + Number(p.montant || 0), 0);
  const TV = state.versementsCollecteur.filter((v) => v.collecteur_id === collecteurId).reduce((s, v) => s + Number(v.montant || 0), 0);
  const resteAVerser = TC - TV;

  ouvrirModal(`
    <h2>Versement reçu — ${nom}</h2>
    <p class="subtitle-sm">Reste à verser actuellement : <b>${formatGNF(resteAVerser)}</b></p>
    <form id="form-versement-collecteur">
      <div class="field-row">
        <label>Montant physiquement reçu (GNF)</label>
        <input type="number" name="montant" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-versement-collecteur").addEventListener("submit", async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get("montant"));
    try {
      await addDoc(collection(db, "versements_collecteur"), {
        collecteur_id: collecteurId,
        montant,
        pdg_id: state.currentUser.uid,
        date: serverTimestamp(),
      });
      notifier("Versement enregistré.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

document.getElementById("liste-collecteurs").addEventListener("click", async (e) => {
  // --- Navigation par zone ---
  const btnPrefecture = e.target.closest("[data-action='ouvrir-prefecture']");
  if (btnPrefecture) {
    state.vueZone = { niveau: "sous_prefectures", prefecture: btnPrefecture.dataset.zone, sousPrefecture: null };
    renderCollecteurs();
    return;
  }
  const btnSousPrefecture = e.target.closest("[data-action='ouvrir-sous-prefecture']");
  if (btnSousPrefecture) {
    state.vueZone.niveau = "collecteurs";
    state.vueZone.sousPrefecture = btnSousPrefecture.dataset.zone;
    renderCollecteurs();
    return;
  }
  const btnRetourPrefectures = e.target.closest("[data-action='retour-prefectures']");
  if (btnRetourPrefectures) {
    state.vueZone = { niveau: "prefectures", prefecture: null, sousPrefecture: null };
    renderCollecteurs();
    return;
  }
  const btnRetourSousPrefectures = e.target.closest("[data-action='retour-sous-prefectures']");
  if (btnRetourSousPrefectures) {
    state.vueZone.niveau = "sous_prefectures";
    state.vueZone.sousPrefecture = null;
    renderCollecteurs();
    return;
  }

  const nomCliquable = e.target.closest("[data-action='voir-membres']");
  if (nomCliquable) {
    state.collecteurSelectionne = nomCliquable.dataset.uid;
    document.querySelector('.tab-btn[data-tab="membres"]').click();
    renderMembres();
    return;
  }
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, uid, nom, disponible, prefecture, sousPrefecture: sousPrefectureDataset } = btn.dataset;

  if (action === "modifier-zone") {
    ouvrirModificationZone(uid, nom, prefecture, btn.dataset.sousPrefecture);
    return;
  }
  if (action === "enregistrer-versement") {
    ouvrirVersementCollecteur(uid, nom);
    return;
  }
  if (action === "retirer-commission-pdg") {
    ouvrirRetraitCommissionPdg(uid, nom, Number(disponible));
    return;
  }
  if (action === "suspendre" || action === "reactiver") {
    await updateDoc(doc(db, "users", uid), { statut: action === "suspendre" ? "suspendu" : "actif" });
    notifier(action === "suspendre" ? "Collecteur suspendu." : "Suspension levée.", "succes");
  }
  if (action === "licencier") {
    ouvrirModalConfirmation(
      "Licencier ce collecteur ?",
      "Cette action est définitive. Le collecteur perdra l'accès à son compte. Vous pourrez continuer à gérer ses clients via le mode substitution.",
      async () => {
        await updateDoc(doc(db, "users", uid), { statut: "licencie" });
        notifier("Collecteur licencié.", "succes");
        fermerModal();
      }
    );
  }
  if (action === "substituer") {
    state.substitutionId = uid;
    document.getElementById("banner-substitution").classList.remove("hidden");
    document.getElementById("banner-substitution-text").textContent = `Mode substitution actif — vous gérez les clients de ${nom}.`;
    document.querySelector('.tab-btn[data-tab="membres"]').click();
    renderMembres();
  }
  if (action === "supprimer-collecteur") {
    ouvrirSuppressionCollecteur(uid, nom);
  }
});

function ouvrirSuppressionCollecteur(collecteurId, nom) {
  const autresCollecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime" && u.uid !== collecteurId);
  const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === collecteurId).length;

  ouvrirModal(`
    <h2>Supprimer ${nom} ?</h2>
    <p class="subtitle-sm">${nbClients} client(s) seront transférés. Le compte sera désactivé et le collecteur ne pourra plus se connecter.</p>
    <div class="field-row">
      <label>Transférer ses clients vers</label>
      <select name="destination" id="select-destination-clients">
        <option value="pdg">Moi-même (portefeuille PDG)</option>
        ${autresCollecteurs.map((c) => `<option value="${c.uid}">${c.nom}</option>`).join("")}
      </select>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button type="button" class="btn btn-danger" id="modal-confirmer-suppression" style="flex:1;">Confirmer la suppression</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer-suppression").addEventListener("click", async () => {
    const destinationId = document.getElementById("select-destination-clients").value;
    try {
      await reassignerClientsCollecteur(collecteurId, destinationId);
      await updateDoc(doc(db, "users", collecteurId), { statut: "supprime" });
      notifier("Collecteur supprimé et clients transférés.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

async function reassignerClientsCollecteur(ancienCollecteurId, nouveauCollecteurId) {
  const nouvelUid = nouveauCollecteurId === "pdg" ? state.currentUser.uid : nouveauCollecteurId;

  const membres = state.users.filter((u) => u.role === "membre" && u.parrain_id === ancienCollecteurId);
  for (const membre of membres) {
    await updateDoc(doc(db, "users", membre.uid), { parrain_id: nouvelUid });
  }

  const contrats = state.contracts.filter((c) => c.collecteur_id === ancienCollecteurId);
  for (const contrat of contrats) {
    await updateDoc(doc(db, "contracts", contrat.id), { collecteur_id: nouvelUid });
  }

  const paiements = state.payments.filter((p) => p.collecteur_id === ancienCollecteurId);
  for (const paiement of paiements) {
    await updateDoc(doc(db, "payments", paiement.id), { collecteur_id: nouvelUid });
  }
}

document.getElementById("btn-quitter-substitution").addEventListener("click", () => {
  state.substitutionId = null;
  document.getElementById("banner-substitution").classList.add("hidden");
  renderMembres();
});

function calculerMontantDuPret(pret) {
  const dateDebut = pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : new Date();
  const nbSemaines = Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
  const montantDuBrut = pret.montant_initial * (1 + pret.taux_hebdo * nbSemaines);
  const dejaRembourse = (state.remboursements || [])
    .filter((r) => r.pret_id === pret.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  return Math.max(0, montantDuBrut - dejaRembourse);
}

function trouverContratsNonSoldes(membreId, contratExclureId) {
  return state.contracts.filter((c) =>
    c.membre_id === membreId &&
    c.statut === "cloture" &&
    c.id !== contratExclureId &&
    !c.epargne_soldee
  );
}

function renderMembres() {
  let membres = state.users.filter((u) => u.role === "membre");
  if (state.substitutionId) {
    membres = membres.filter((m) => m.parrain_id === state.substitutionId);
  } else if (state.collecteurSelectionne) {
    membres = membres.filter((m) => m.parrain_id === state.collecteurSelectionne);
  }
  const recherche = (document.getElementById("recherche-membres").value || "").toLowerCase();
  if (recherche) {
    membres = membres.filter((m) => m.nom.toLowerCase().includes(recherche) || (m.telephone || "").includes(recherche));
  }

  const enteteContainer = document.getElementById("entete-membres");
  if (enteteContainer) {
    if (state.collecteurSelectionne && !state.substitutionId) {
      const collecteur = state.users.find((u) => u.uid === state.collecteurSelectionne);
      enteteContainer.innerHTML = `
        <button class="btn btn-ghost-sm" id="btn-retour-collecteurs" style="margin-bottom:10px;">← Retour aux collecteurs</button>
        <p style="font-weight:bold; margin-bottom:8px;">Membres de ${collecteur ? collecteur.nom : ""}</p>
      `;
      document.getElementById("btn-retour-collecteurs").addEventListener("click", () => {
        state.collecteurSelectionne = null;
        renderMembres();
      });
    } else {
      enteteContainer.innerHTML = "";
    }
  }
  const container = document.getElementById("liste-membres");
  if (membres.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre trouvé.</p>`;
    return;
  }

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === "confirme");

  container.innerHTML = membres.map((m) => {
    const contrat = state.contracts.find((c) => c.membre_id === m.uid && c.statut === "actif")
      || state.contracts.filter((c) => c.membre_id === m.uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""))[0];
    const versements = state.payments.filter((p) => contrat && p.contract_id === contrat.id);
    const totalVerse = versements.filter((p) => p.statut === "confirme" && p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);
    let statutContrat = contrat ? contrat.statut : "aucun contrat";
    let estInactif = false;
    if (contrat && calculerStatutContrat(contrat, versementsConfirmesTous) === "inactif") {
      statutContrat = "inactif";
      estInactif = true;
    }
    const pret = contrat ? (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif") : null;

    const contratsNonSoldes = trouverContratsNonSoldes(m.uid, contrat ? contrat.id : null);
    const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

    return `
      <div class="entity-card" data-uid="${m.uid}">
          <div class="entity-card-top">
            <div style="display:flex; align-items:center;">
              ${avatarImg(m, "mini")}
              <div>
                <p class="entity-nom">${m.nom}</p>
                <p class="entity-sub" style="${estInactif ? "color:#c0392b; font-weight:bold;" : ""}">${m.telephone} · ${statutContrat}</p>
                ${pret ? `<p class="entity-sub" style="color:#c0392b;">Prêt en cours : ${formatGNF(calculerMontantDuPret(pret))}</p>` : ""}
                ${totalNonSolde > 0 ? `<p class="entity-sub" style="color:#c0392b; font-weight:bold;">Contrat non soldé : ${formatGNF(totalNonSolde)}</p>` : ""}
              </div>
            </div>
            <span class="badge badge-actif">${formatGNF(totalVerse)}</span>
          </div>
          <div class="entity-actions">
            ${pret ? `<button class="btn btn-secondary btn-sm" data-action="rembourser-pret" data-pret="${pret.id}">Rembourser prêt</button>` : ""}
            <button class="btn btn-danger btn-sm" data-action="supprimer-membre" data-uid="${m.uid}" data-nom="${m.nom}">Supprimer</button>
          </div>
        </div>
    `;
  }).join("");
}

document.getElementById("recherche-membres").addEventListener("input", renderMembres);

// --- PDG crée directement un membre (choisit son collecteur) ---
document.getElementById("btn-nouveau-membre-pdg").addEventListener("click", () => {
  const collecteursActifs = state.users.filter((u) => u.role === "collecteur" && u.statut === "actif");
  if (collecteursActifs.length === 0) {
    notifier("Créez d'abord un collecteur actif avant d'ajouter un membre.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Ce membre sera rattaché au collecteur choisi. Un mot de passe est généré automatiquement.</p>
    <form id="form-nouveau-membre-pdg">
      <div class="field-row">
        <label>Collecteur responsable</label>
        <select name="collecteur_id" required>
          ${collecteursActifs.map((c) => `<option value="${c.uid}">${c.nom}</option>`).join("")}
        </select>
      </div>
      <div class="field-row"><label>Nom complet</label><input type="text" name="nom" required /></div>
      <div class="field-row"><label>Téléphone (identifiant de connexion)</label><input type="tel" name="telephone" required /></div>
      <div class="field-row"><label>E-mail</label><input type="email" name="email" required /></div>
      <div class="field-row"><label>Résidence</label><input type="text" name="residence" required /></div>
      <div class="field-row"><label>Montant du versement quotidien (GNF)</label><input type="number" name="montantJour" min="1" required /></div>
      <div class="field-row"><label>Commission encaissée aujourd'hui (jour 1, GNF)</label><input type="number" name="commission" min="1" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer le compte</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-nouveau-membre-pdg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const collecteurId = fd.get("collecteur_id");
    const nom = fd.get("nom").trim();
    const telephone = fd.get("telephone").trim();
    const email = fd.get("email").trim();
    const residence = fd.get("residence").trim();
    const montantJour = Number(fd.get("montantJour"));
    const commission = Number(fd.get("commission"));
    const password = telephone.replace(/\D/g, "").slice(-6);

    try {
      const emailTechnique = telephoneVersEmailTechnique(telephone);
      const uid = await creerCompteSecondaire(emailTechnique, password);

      await setDoc(doc(db, "users", uid), {
        role: "membre",
        nom, telephone, email, residence,
        parrain_id: collecteurId,
        statut: "actif",
        date_creation: serverTimestamp(),
      });

      const contratRef = await addDoc(collection(db, "contracts"), {
        membre_id: uid,
        membre_nom: nom,
        collecteur_id: collecteurId,
        statut: "actif",
        commission,
        montant_mise: montantJour,
        date_debut: new Date().toISOString(),
      });

      await addDoc(collection(db, "payments"), {
        contract_id: contratRef.id,
        collecteur_id: collecteurId,
        membre_id: uid,
        montant: commission,
        jour_numero: 1,
        statut: "collecte",
        date: serverTimestamp(),
      });

      fermerModal();
      ouvrirModal(`
        <h2>Identifiants du membre</h2>
        <p class="subtitle-sm">À transmettre oralement à ${nom}</p>
        <div class="detail-line"><span>Téléphone</span><span><b>${telephone}</b></span></div>
        <div class="detail-line"><span>Mot de passe</span><span><b>${password}</b></span></div>
        <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-id" style="flex:1;">J'ai transmis les identifiants</button></div>
      `);
      document.getElementById("modal-fermer-id").addEventListener("click", fermerModal);
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

document.getElementById("liste-membres").addEventListener("click", (e) => {
  const btnSupprimer = e.target.closest("button[data-action='supprimer-membre']");
  if (btnSupprimer) {
    const { uid, nom } = btnSupprimer.dataset;
    ouvrirModalConfirmation(
      `Supprimer ${nom} ?`,
      "Le compte sera désactivé et le membre ne pourra plus se connecter. L'historique de ses versements reste conservé.",
      async () => {
        try {
          await updateDoc(doc(db, "users", uid), { statut: "supprime" });
          const contratActif = state.contracts.find((c) => c.membre_id === uid && c.statut === "actif");
          if (contratActif) {
            await updateDoc(doc(db, "contracts", contratActif.id), { statut: "annule" });
          }
          notifier("Membre supprimé.", "succes");
          fermerModal();
        } catch (err) {
          console.error(err);
          notifier("Erreur : " + err.message, "erreur");
        }
      }
    );
    return;
  }
  const card = e.target.closest(".entity-card");
  if (!card) return;
  afficherDetailMembre(card.dataset.uid);
});

function afficherDetailMembre(uid) {
  const membre = state.users.find((u) => u.uid === uid);
  const contrats = state.contracts.filter((c) => c.membre_id === uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""));
  const contrat = contrats[0];
  const versements = contrat ? state.payments.filter((p) => p.contract_id === contrat.id).sort((a, b) => a.jour_numero - b.jour_numero) : [];
  const totalVerse = versements.filter((p) => p.statut === 'confirme' && p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);

  const contratsNonSoldes = trouverContratsNonSoldes(uid, contrat ? contrat.id : null);
  const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

  const pret = contrat ? (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif") : null;
  const datePret = pret && pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : null;
  const soldeDisponible = contrat ? calculerSoldeDisponible(contrat) : 0;

  const html = `
    <h2 style="display:flex; align-items:center; gap:10px;">${avatarImg(membre, "mini")}${membre.nom}</h2>
    <p class="subtitle-sm">Identifiant de connexion (téléphone) : <b>${membre.telephone}</b></p>
    ${membre.residence ? `<p class="subtitle-sm">Résidence : ${membre.residence}</p>` : ""}
    <div class="detail-line"><span>Statut du contrat</span><span>${contrat ? contrat.statut : "—"}</span></div>
    <div class="detail-line"><span>Début du contrat</span><span>${contrat ? formatDate(contrat.date_debut) : "—"}</span></div>
    <div class="detail-line"><span>Commission (jour 1)</span><span>${contrat ? formatGNF(contrat.commission) : "—"}</span></div>
    <div class="detail-line"><span>Total épargné (épargne nette)</span><span>${formatGNF(totalVerse)}</span></div>
    ${pret ? `<div class="detail-line"><span style="color:#c0392b;">Solde disponible (après prêt)</span><span style="color:#c0392b;"><b>${formatGNF(soldeDisponible)}</b></span></div>` : ""}
    ${totalNonSolde > 0 ? `<div class="detail-line"><span style="color:#c0392b;">Contrat(s) non soldé(s)</span><span style="color:#c0392b;">${formatGNF(totalNonSolde)}</span></div>` : ""}
    ${pret ? `
      <h2 style="margin-top:18px; font-size:15px; color:#c0392b;">Prêt en cours</h2>
      <div class="detail-line"><span>Capital emprunté</span><span>${formatGNF(pret.montant_initial)}</span></div>
      <div class="detail-line"><span>Montant dû actuellement</span><span><b>${formatGNF(calculerMontantDuPret(pret))}</b></span></div>
      <div class="detail-line"><span>Date du prêt</span><span>${datePret ? formatDate(datePret) : "—"}</span></div>
    ` : ""}
    <h2 style="margin-top:18px; font-size:15px;">Historique des versements</h2>
    <div style="max-height:220px; overflow-y:auto; margin-top:8px;">
      ${versements.length === 0 ? '<p class="empty-state">Aucun versement enregistré.</p>' : versements.map((v) => `
        <div class="detail-line"><span>Jour ${v.jour_numero} — ${formatDate(v.date)}</span><span>${formatGNF(v.montant)}</span></div>
      `).join("")}
    </div>
    <div class="modal-actions"><button class="btn btn-ghost-sm" id="btn-fermer-modal-membre" style="flex:1;">Fermer</button></div>
  `;
  ouvrirModal(html);
  document.getElementById("btn-fermer-modal-membre").addEventListener("click", fermerModal);
}

function renderMembresEnAttente() {
  const container = document.getElementById("liste-attente");
  if (!container) return;

  if (state.membresEnAttente.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre en attente de validation.</p>`;
    return;
  }

  container.innerHTML = state.membresEnAttente.map((m) => {
    const collecteur = state.users.find((u) => u.uid === m.collecteur_id);
    return `
      <div class="entity-card" data-id="${m.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone} · enregistré par ${collecteur ? collecteur.nom : "collecteur inconnu"}</p>
          </div>
          <span class="badge badge-suspendu">en attente</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="valider" data-id="${m.id}">Valider</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-attente")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='valider']");
  if (!btn) return;
  ouvrirValidationMembre(btn.dataset.id);
});

function ouvrirValidationMembre(membreEnAttenteId) {
  const m = state.membresEnAttente.find((x) => x.id === membreEnAttenteId);
  if (!m) return;

  ouvrirModal(`
    <h2>Valider ${m.nom}</h2>
    <p class="subtitle-sm">Ce membre se connectera avec son numéro de téléphone et le mot de passe que vous définissez ici. Transmettez-lui ces identifiants.</p>
    <form id="form-valider-membre">
      <div class="field-row">
        <label>Téléphone (identifiant de connexion)</label>
        <input type="tel" value="${m.telephone}" disabled />
      </div>
      <div class="field-row">
        <label>Mot de passe à créer (6 caractères min)</label>
        <input type="text" name="password" minlength="6" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer le compte</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-valider-membre").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    await validerMembre(m, password);
  });
}

async function validerMembre(membreEnAttente, password) {
  try {
    const emailTechnique = telephoneVersEmailTechnique(membreEnAttente.telephone);
    const uid = await creerCompteSecondaire(emailTechnique, password);

    await setDoc(doc(db, "users", uid), {
      role: "membre",
      nom: membreEnAttente.nom,
      telephone: membreEnAttente.telephone,
      parrain_id: membreEnAttente.collecteur_id,
      statut: "actif",
      date_creation: serverTimestamp(),
    });

    const contratsLies = state.contracts.filter((c) => c.membre_en_attente_id === membreEnAttente.id);
    for (const contrat of contratsLies) {
      await updateDoc(doc(db, "contracts", contrat.id), { membre_id: uid });
    }

    await updateDoc(doc(db, "membres_en_attente_validation", membreEnAttente.id), {
      statut: "valide",
      membre_id: uid,
      date_validation: serverTimestamp(),
    });

    notifier(`Compte créé. Transmettez au membre : téléphone ${membreEnAttente.telephone} + le mot de passe choisi.`, "succes");
    fermerModal();
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + err.message, "erreur");
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

function ouvrirModal(html) {
  document.getElementById("modal-content").innerHTML = html;
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.remove("hidden");
  overlay.style.display = "flex";
}
function fermerModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.add("hidden");
  overlay.style.display = "none";
  document.getElementById("modal-content").innerHTML = "";
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") fermerModal();
});
function ouvrirModalConfirmation(titre, texte, onConfirm) {
  ouvrirModal(`
    <h2>${titre}</h2>
    <p class="subtitle-sm">${texte}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button class="btn btn-danger" id="modal-confirmer" style="flex:1;">Confirmer</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer").addEventListener("click", onConfirm);
}

document.getElementById("btn-decaisser").addEventListener("click", () => {
  const { totalCommissions } = calculerSoldes(state.payments, state.contracts);
  const totalDecaisse = (state.decaissements || []).reduce((s, d) => s + Number(d.montant), 0);
  const totalInteretsPdg = state.interetsPartages.reduce((s, i) => s + Number(i.montant_pdg || 0), 0);
  const totalRetraitsCommissionPdg = state.retraitsCommission
    .filter((r) => r.beneficiaire_role === "pdg" && r.statut === "confirme")
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  const disponible = totalCommissions + totalInteretsPdg - totalDecaisse - totalRetraitsCommissionPdg;
  ouvrirModal(`
    <h2>Décaisser des commissions</h2>
    <p class="subtitle-sm">Montant disponible : <b>${formatGNF(disponible)}</b></p>
    <form id="form-decaisser">
      <div class="field-row">
        <label>Montant à décaisser (GNF)</label>
        <input type="number" name="montant" min="1" max="${disponible}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-decaisser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get("montant"));
    if (montant > disponible) { notifier("Montant supérieur au solde disponible.", "erreur"); return; }
    await addDoc(collection(db, "decaissements"), {
      montant, pdg_id: state.currentUser.uid, date: new Date().toISOString(),
    });
    notifier("Décaissement enregistré.", "succes");
    fermerModal();
  });
});

document.getElementById("btn-nouveau-partenaire").addEventListener("click", () => {
  ouvrirModal(`
    <h2>Créer un nouveau partenaire</h2>
    <p class="subtitle-sm">Choisissez le type de compte à inviter. Un code sera généré : transmettez-le à la personne pour qu'elle finalise son inscription sur l'application correspondante.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-code-collecteur" style="flex:1;">Nouveau collecteur</button>
    </div>
  `);
  document.getElementById("btn-code-collecteur").addEventListener("click", () => genererEtAfficherCode("collecteur"));
});

document.getElementById("btn-nouveau-collecteur").addEventListener("click", () => genererEtAfficherCode("collecteur"));

async function genererEtAfficherCode(type) {
  const prefixe = type === "collecteur" ? "COL" : "MBR";
  const code = genererCodeParrain(prefixe);
  await setDoc(doc(db, "codes_parrainage", code), {
    proprietaire_id: state.currentUser.uid,
    type,
    actif: true,
    date_creation: serverTimestamp(),
  });
  ouvrirModal(`
    <h2>Code généré</h2>
    <p class="subtitle-sm">Transmettez ce code au futur ${type === "collecteur" ? "collecteur" : "membre"}. Il devra le saisir lors de son inscription.</p>
    <div class="code-display">${code}</div>
    <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
  `);
  document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
}

function renderConfirmations() {
  const container = document.getElementById("liste-confirmations");
  if (!container) return;

  const enAttente = state.payments.filter((p) => p.statut === "collecte");

  if (enAttente.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun versement en attente de confirmation.</p>`;
    return;
  }

  container.innerHTML = enAttente.map((p) => {
    const membre = state.users.find((u) => u.uid === p.membre_id);
    const collecteur = state.users.find((u) => u.uid === p.collecteur_id);
    return `
      <div class="entity-card" data-id="${p.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : "Membre inconnu"}</p>
            <p class="entity-sub">Jour ${p.jour_numero} · collecté par ${collecteur ? collecteur.nom : "—"}</p>
          </div>
          <span class="badge badge-suspendu">${formatGNF(p.montant)}</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="confirmer" data-id="${p.id}">Confirmer</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-confirmations")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action='confirmer']");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    await updateDoc(doc(db, "payments", id), {
      statut: "confirme",
      date_confirmation: serverTimestamp(),
    });
    notifier("Versement confirmé.", "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + err.message, "erreur");
  }
});

function infoTypeRetrait(type) {
  const infos = {
    'pret': { libelle: 'Prêt (2%/semaine)', classe: 'badge-suspendu', actionLabel: 'Valider comme prêt' },
    'solde_contrat_termine': { libelle: 'Solde de contrat terminé', classe: 'badge-actif', actionLabel: 'Confirmer' },
    'retrait_final': { libelle: 'Retrait final (clôture)', classe: 'badge-licencie', actionLabel: 'Confirmer' },
  };
  return infos[type] || { libelle: 'Retrait d\'épargne', classe: 'badge-actif', actionLabel: 'Confirmer' };
}

function renderRetraits() {
  const container = document.getElementById("liste-retraits");
  if (!container) return;

  const demandesCommission = state.retraitsCommission.filter(
    (r) => r.beneficiaire_role === "collecteur" && r.statut === "en_attente"
  );

  if (state.retraits.length === 0 && demandesCommission.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune demande de retrait en attente.</p>`;
    return;
  }

  const htmlRetraitsMembres = state.retraits.map((r) => {
    const membre = state.users.find((u) => u.uid === r.memberId);
    const info = infoTypeRetrait(r.type);
    return `
      <div class="entity-card" data-id="${r.id}" data-kind="retrait">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : r.memberName || "Membre inconnu"}</p>
            <p class="entity-sub">${info.libelle}</p>
          </div>
          <span class="badge ${info.classe}">${formatGNF(r.montant)}</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="traiter-retrait" data-id="${r.id}">${info.actionLabel}</button>
        </div>
      </div>
    `;
  }).join("");

  const htmlCommission = demandesCommission.map((r) => `
    <div class="entity-card" data-id="${r.id}" data-kind="commission">
      <div class="entity-card-top">
        <div>
          <p class="entity-nom">${r.collecteur_nom || "Collecteur"}</p>
          <p class="entity-sub">Retrait de sa commission (collecteur)</p>
        </div>
        <span class="badge badge-suspendu">${formatGNF(r.montant)}</span>
      </div>
      <div class="entity-actions">
        <button class="btn btn-primary btn-sm" data-action="confirmer-retrait-commission" data-id="${r.id}">Confirmer</button>
      </div>
    </div>
  `).join("");

  container.innerHTML = htmlCommission + htmlRetraitsMembres;
}

document.getElementById("liste-retraits")?.addEventListener("click", async (e) => {
  const btnCommission = e.target.closest("button[data-action='confirmer-retrait-commission']");
  if (btnCommission) {
    const id = btnCommission.dataset.id;
    try {
      await updateDoc(doc(db, "retraits_commission", id), {
        statut: "confirme",
        date_confirmation: serverTimestamp(),
      });
      notifier("Retrait de commission confirmé.", "succes");
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
      }
    return;
  }

  const btn = e.target.closest("button[data-action='traiter-retrait']");
  if (!btn) return;
  const id = btn.dataset.id;
  const retrait = state.retraits.find((r) => r.id === id);
  if (!retrait) return;
  const info = infoTypeRetrait(retrait.type);

  ouvrirModalConfirmation(
    `${info.actionLabel} ce retrait ?`,
    `Montant : ${formatGNF(retrait.montant)} · Type : ${info.libelle}`,
    async () => {
      try {
        if (retrait.type === "pret") {
          const contrat = state.contracts.find((c) => c.id === retrait.contractId);
          const collecteurId = contrat ? contrat.collecteur_id : (state.users.find((u) => u.uid === retrait.memberId)?.parrain_id || null);

          await addDoc(collection(db, "prets"), {
            membre_id: retrait.memberId,
            collecteur_id: collecteurId,
            contract_id: retrait.contractId || null,
            montant_initial: retrait.montant,
            taux_hebdo: 0.02,
            statut: "actif",
            interet_deja_reconnu: 0,
            date_debut: serverTimestamp(),
            pdg_id: state.currentUser.uid,
          });

          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          notifier("Prêt validé et enregistré.", "succes");
        } else if (retrait.type === "retrait_final") {
          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          if (retrait.contractId) {
            await updateDoc(doc(db, "contracts", retrait.contractId), {
              statut: "cloture",
              epargne_soldee: true,
            });
          }

          await addDoc(collection(db, "propositions_reconduction"), {
            membre_id: retrait.memberId,
            contrat_precedent_id: retrait.contractId || null,
            statut: "en_attente",
            date_creation: serverTimestamp(),
          });

          notifier("Retrait confirmé, contrat clôturé. Le membre peut choisir de reconduire.", "succes");
        } else {
          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          const contratsNonSoldes = trouverContratsNonSoldes(retrait.memberId, null);
          for (const contrat of contratsNonSoldes) {
            await updateDoc(doc(db, "contracts", contrat.id), { epargne_soldee: true });
          }

          notifier("Retrait traité.", "succes");
        }
        fermerModal();
      } catch (err) {
        console.error(err);
        notifier("Erreur : " + err.message, "erreur");
      }
    }
  );
});

// ==========================================================
// --- Rubrique RAPPORTS : par période (jour/semaine/mois/année),
//     collecteurs classés par zone, + brochure PDF nationale ---
// ==========================================================

function obtenirBornesPeriode(type) {
  const maintenant = new Date();
  let debut, fin;
  if (type === "jour") {
    debut = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate(), 0, 0, 0);
    fin = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate(), 23, 59, 59, 999);
  } else if (type === "semaine") {
    const jourSemaine = maintenant.getDay(); // 0 = dimanche
    const decalageLundi = jourSemaine === 0 ? 6 : jourSemaine - 1;
    debut = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate() - decalageLundi, 0, 0, 0);
    fin = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + 6, 23, 59, 59, 999);
  } else if (type === "mois") {
    debut = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1, 0, 0, 0);
    fin = new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    debut = new Date(maintenant.getFullYear(), 0, 1, 0, 0, 0);
    fin = new Date(maintenant.getFullYear(), 11, 31, 23, 59, 59, 999);
  }
  return { debut, fin };
}

function libellePeriode(type) {
  const labels = { jour: "Journalier", semaine: "Hebdomadaire", mois: "Mensuel", annee: "Annuel" };
  return labels[type] || type;
}

function dateDansPeriode(champDate, debut, fin) {
  if (!champDate) return false;
  const d = champDate.toDate ? champDate.toDate() : new Date(champDate);
  return d >= debut && d <= fin;
}

// --- Calcule commission globale/PDG/collecteur + épargne nette collectée, pour UN collecteur, sur UNE période ---
function calculerChiffresPeriodeCollecteur(collecteurId, debut, fin) {
  const jour1Periode = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero === 1 &&
      dateDansPeriode(p.date_confirmation || p.date, debut, fin)
  );
  const totalJour1Periode = jour1Periode.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionPdgInscriptions = totalJour1Periode * 0.70;
  const commissionCollecteurInscriptions = totalJour1Periode * 0.30;

  const interetsPeriode = state.interetsPartages.filter(
    (i) => i.collecteur_id === collecteurId && dateDansPeriode(i.date, debut, fin)
  );
  const interetsPdgPeriode = interetsPeriode.reduce((s, i) => s + Number(i.montant_pdg || 0), 0);
  const interetsCollecteurPeriode = interetsPeriode.reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);

  const commissionPdg = commissionPdgInscriptions + interetsPdgPeriode;
  const commissionCollecteur = commissionCollecteurInscriptions + interetsCollecteurPeriode;
  const commissionGlobale = commissionPdg + commissionCollecteur;

  const soldeEpargneNetPeriode = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero > 1 &&
      dateDansPeriode(p.date_confirmation || p.date, debut, fin)
  ).reduce((s, p) => s + Number(p.montant || 0), 0);

  return { commissionGlobale, commissionPdg, commissionCollecteur, soldeEpargneNetPeriode };
}

// --- Regroupe tous les collecteurs par préfecture puis sous-préfecture, triés alphabétiquement ---
function regrouperCollecteursParZone() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const zones = {};
  collecteurs.forEach((c) => {
    const pref = c.prefecture && c.prefecture.trim() ? c.prefecture.trim() : "Non précisé";
    const sousPref = c.sous_prefecture && c.sous_prefecture.trim() ? c.sous_prefecture.trim() : "Non précisé";
    if (!zones[pref]) zones[pref] = {};
    if (!zones[pref][sousPref]) zones[pref][sousPref] = [];
    zones[pref][sousPref].push(c);
  });
  return zones;
}

function renderRapport(type) {
  const { debut, fin } = obtenirBornesPeriode(type);
  const zones = regrouperCollecteursParZone();
  const prefecturesTriees = Object.keys(zones).sort((a, b) => a.localeCompare(b, "fr"));

  const entete = document.getElementById("rapport-entete");
  if (entete) {
    entete.innerHTML = `
      <div class="card" style="margin-bottom:12px;">
        <h2 style="font-size:15px;">Rapport ${libellePeriode(type)}</h2>
        <p class="subtitle-sm">Du ${formatDate(debut)} au ${formatDate(fin)}</p>
      </div>
    `;
  }

  const container = document.getElementById("rapport-resultats");
  if (!container) return;

  if (prefecturesTriees.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun collecteur enregistré.</p>`;
    return;
  }

  let totalGlobalCommission = 0, totalGlobalPdg = 0, totalGlobalCollecteur = 0, totalGlobalEpargne = 0;
  let html = "";

  prefecturesTriees.forEach((pref) => {
    html += `<h3 style="margin-top:16px; margin-bottom:6px; font-size:15px;">${pref}</h3>`;
    const sousPrefsTriees = Object.keys(zones[pref]).sort((a, b) => a.localeCompare(b, "fr"));
    sousPrefsTriees.forEach((sousPref) => {
      html += `<p style="font-weight:bold; font-size:13px; color:#666; margin:8px 0 4px;">${sousPref}</p>`;
      zones[pref][sousPref].forEach((c) => {
        const chiffres = calculerChiffresPeriodeCollecteur(c.uid, debut, fin);
        totalGlobalCommission += chiffres.commissionGlobale;
        totalGlobalPdg += chiffres.commissionPdg;
        totalGlobalCollecteur += chiffres.commissionCollecteur;
        totalGlobalEpargne += chiffres.soldeEpargneNetPeriode;
        html += `
          <div class="entity-card">
            <div class="entity-card-top">
              <p class="entity-nom">${c.nom}</p>
              <span class="badge badge-actif">${c.statut}</span>
            </div>
            <div class="detail-line"><span>Commission globale</span><span style="font-weight:bold;">${formatGNF(chiffres.commissionGlobale)}</span></div>
            <div class="detail-line"><span>Commission PDG</span><span>${formatGNF(chiffres.commissionPdg)}</span></div>
            <div class="detail-line"><span>Commission collecteur</span><span>${formatGNF(chiffres.commissionCollecteur)}</span></div>
            <div class="detail-line"><span>Solde d'épargne net (période)</span><span>${formatGNF(chiffres.soldeEpargneNetPeriode)}</span></div>
          </div>
        `;
      });
    });
  });

  html += `
    <div class="card" style="margin-top:16px; background:#f4f6f8;">
      <h3 style="font-size:14px;">Totaux de la période</h3>
      <div class="detail-line"><span>Commission globale</span><span style="font-weight:bold;">${formatGNF(totalGlobalCommission)}</span></div>
      <div class="detail-line"><span>Commission PDG</span><span>${formatGNF(totalGlobalPdg)}</span></div>
      <div class="detail-line"><span>Commission collecteur</span><span>${formatGNF(totalGlobalCollecteur)}</span></div>
      <div class="detail-line"><span>Solde d'épargne net (période)</span><span>${formatGNF(totalGlobalEpargne)}</span></div>
    </div>
  `;

  container.innerHTML = html;
}

document.getElementById("btn-generer-rapport")?.addEventListener("click", () => {
  ouvrirModal(`
    <h2>Choisir le type de rapport</h2>
    <p class="subtitle-sm">Sélectionnez la période souhaitée. Les collecteurs seront affichés classés par zone.</p>
    <div class="modal-actions" style="flex-direction:column; gap:8px;">
      <button class="btn btn-secondary" data-periode="jour" style="width:100%;">Journalier</button>
      <button class="btn btn-secondary" data-periode="semaine" style="width:100%;">Hebdomadaire</button>
      <button class="btn btn-secondary" data-periode="mois" style="width:100%;">Mensuel</button>
      <button class="btn btn-secondary" data-periode="annee" style="width:100%;">Annuel</button>
    </div>
  `);
  document.querySelectorAll("[data-periode]").forEach((b) => {
    b.addEventListener("click", () => {
      renderRapport(b.dataset.periode);
      fermerModal();
    });
  });
});

// --- Brochure PDF nationale imprimable : tous les collecteurs, chiffres cumulés à ce jour ---
function genererBrochureNationalePdf() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const collecteursTries = [...collecteurs].sort((a, b) => {
    const prefA = a.prefecture && a.prefecture.trim() ? a.prefecture.trim() : "Non précisé";
    const prefB = b.prefecture && b.prefecture.trim() ? b.prefecture.trim() : "Non précisé";
    if (prefA !== prefB) return prefA.localeCompare(prefB, "fr");
    const sousA = a.sous_prefecture && a.sous_prefecture.trim() ? a.sous_prefecture.trim() : "Non précisé";
    const sousB = b.sous_prefecture && b.sous_prefecture.trim() ? b.sous_prefecture.trim() : "Non précisé";
    return sousA.localeCompare(sousB, "fr");
  });

  if (collecteursTries.length === 0) {
    notifier("Aucun collecteur à inclure dans le rapport national.", "erreur");
    return;
  }

  let lignes = "";
  collecteursTries.forEach((c, index) => {
    const commissionPdg = calculerCommissionPdgParCollecteur(c.uid);
    const commissionCollecteur = calculerCommissionCollecteurPropre(c.uid);
    const commissionTotale = commissionPdg + commissionCollecteur;
    const soldeEpargne = calculerSoldeEpargneNetCollecteur(c.uid);
    const pref = c.prefecture && c.prefecture.trim() ? c.prefecture.trim() : "Non précisé";
    const sousPref = c.sous_prefecture && c.sous_prefecture.trim() ? c.sous_prefecture.trim() : "Non précisé";
    lignes += `
      <tr>
        <td>${index + 1}</td>
        <td>${pref} / ${sousPref}</td>
        <td>${c.nom}</td>
        <td>${c.telephone || ""}</td>
        <td>${formatGNF(soldeEpargne)}</td>
        <td>${formatGNF(commissionTotale)}</td>
        <td>${formatGNF(commissionPdg)}</td>
        <td>${formatGNF(commissionCollecteur)}</td>
        <td></td>
      </tr>
    `;
  });

  const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8" />
      <title>Rapport national — ${state.entreprise?.nom || "CPCT-TINA"}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #222; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        p.sub { color: #666; font-size: 12px; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th, td { border: 1px solid #999; padding: 6px 4px; text-align: left; }
        th { background: #14213D; color: white; }
        td:nth-child(1) { text-align: center; width: 28px; }
        td:last-child, th:last-child { min-width: 90px; }
        @media print {
          @page { size: A4 landscape; margin: 12mm; }
        }
      </style>
    </head>
    <body>
      <h1>${state.entreprise?.nom || "CPCT-TINA"} — Rapport national des collecteurs</h1>
      <p class="sub">Généré le ${formatDate(new Date())} · ${collecteursTries.length} collecteur(s)</p>
      <table>
        <thead>
          <tr>
            <th>N°</th>
            <th>Préfecture / Sous-préfecture</th>
            <th>Prénom et nom du collecteur</th>
            <th>Téléphone</th>
            <th>Solde d'épargne</th>
            <th>Commission totale</th>
            <th>Commission PDG</th>
            <th>Commission collecteur</th>
            <th>Signature superviseur</th>
          </tr>
        </thead>
        <tbody>
          ${lignes}
        </tbody>
      </table>
      <script>window.onload = () => { window.print(); };</script>
    </body>
    </html>
  `;

  const fenetre = window.open("", "_blank");
  if (!fenetre) {
    notifier("Le navigateur a bloqué l'ouverture de la fenêtre d'impression. Autorisez les pop-ups pour ce site.", "erreur");
    return;
  }
  fenetre.document.open();
  fenetre.document.write(html);
  fenetre.document.close();
}

document.getElementById("btn-rapport-national-pdf")?.addEventListener("click", genererBrochureNationalePdf);

// --- Réinitialisation complète (PDG y compris) — retour à l'écran de création d'entreprise ---
async function reinitialiserTout() {
  const collectionsASupprimer = [
    "users", "contracts", "payments", "decaissements",
    "membres_en_attente_validation", "withdrawalRequests",
    "prets", "remboursements_prets", "versements_collecteur",
    "interets_prets_repartis", "codes_parrainage", "propositions_reconduction",
    "retraits_commission",
  ];

  try {
    for (const nomCollection of collectionsASupprimer) {
      const snap = await getDocs(collection(db, nomCollection));
      for (const d of snap.docs) {
        await deleteDoc(doc(db, nomCollection, d.id));
      }
    }
    await deleteDoc(doc(db, "entreprise", "info"));

    state.unsubscribers.forEach((u) => u());
    state.unsubscribers = [];
    state.entreprise = null;
    state.currentUser = null;

    try {
      if (auth.currentUser) await auth.currentUser.delete();
    } catch (e) {
      // Si la suppression du compte Auth échoue (session ancienne), on se contente de se déconnecter
    }
    try { await signOut(auth); } catch (e) { /* déjà déconnecté si le compte Auth a été supprimé */ }

    notifier("Application réinitialisée. Redémarrage...", "succes");
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    console.error(err);
    notifier("Erreur lors de la réinitialisation : " + err.message, "erreur");
  }
}

document.getElementById("btn-reinitialiser-tout")?.addEventListener("click", () => {
  ouvrirModal(`
    <h2 style="color:#c0392b;">⚠️ Réinitialiser complètement l'application ?</h2>
    <p class="subtitle-sm">Cette action supprimera <b>définitivement</b> toutes les données : entreprise, PDG, collecteurs, membres, contrats, versements, prêts, retraits. L'application redémarrera comme à l'installation. Cette action est <b>irréversible</b>.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button type="button" class="btn btn-danger" id="modal-confirmer-reset-1" style="flex:1;">Continuer</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer-reset-1").addEventListener("click", () => {
    ouvrirModal(`
      <h2 style="color:#c0392b;">⚠️ Dernière confirmation</h2>
      <p class="subtitle-sm">Toutes les données seront supprimées et l'application redémarrera comme neuve. Confirmez-vous ?</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler-2" style="flex:1;">Annuler</button>
        <button type="button" class="btn btn-danger" id="modal-confirmer-reset-2" style="flex:1;">Oui, tout supprimer</button>
      </div>
    `);
    document.getElementById("modal-annuler-2").addEventListener("click", fermerModal);
    document.getElementById("modal-confirmer-reset-2").addEventListener("click", async () => {
      fermerModal();
      await reinitialiserTout();
    });
  });
});

demarrer();
