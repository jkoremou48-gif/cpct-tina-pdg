// === PDG — PARTIE 1/3 ===
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  getDocs, deleteDoc,
  creerCompteSecondaire, uploaderPhotoProfil, changerMotDePasse,
} from "./firebase-config.js";

import {
  genererCodeParrain, formatGNF, formatDate, formatDateHeure, nomMois, calculerSoldes, notifier, calculerStatutContrat,
  TYPES_CONTRAT, infoTypeContrat, calculerMontantDuPretGeneralise,
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
  diffusions: [],
  messagesPrives: [],
  fraisInscriptions: [],
  depenses: [],
  redistributions: [],
  parametresInterets: { pdg: 0.70, collecteur: 0.30, redistribution: 0 },
  unsubscribers: [],
  vueZone: {
    niveau: "prefectures",
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
    verrouillerAutomatiquement();
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
  const unsubDiffusions = onSnapshot(collection(db, "diffusions"), (snap) => {
    state.diffusions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubMessagesPrives = onSnapshot(collection(db, "messages_prives"), (snap) => {
    state.messagesPrives = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubFraisInscription = onSnapshot(collection(db, "frais_inscription"), (snap) => {
    state.fraisInscriptions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubDepenses = onSnapshot(collection(db, "depenses"), (snap) => {
    state.depenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubRedistributions = onSnapshot(collection(db, "redistributions_interets"), (snap) => {
    state.redistributions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubParametres = onSnapshot(doc(db, "parametres", "interets_types_annuels"), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      state.parametresInterets = {
        pdg: Number(d.pdg ?? 0.70),
        collecteur: Number(d.collecteur ?? 0.30),
        redistribution: Number(d.redistribution ?? 0),
      };
    }
    preremplirFormulaireParametres();
    render();
  });

  state.unsubscribers.push(
    unsubUsers, unsubContracts, unsubPayments, unsubDecaissements, unsubAttente, unsubRetraits,
    unsubRetraitsConfirmes, unsubPrets, unsubRemboursements, unsubVersementsCollecteur, unsubInterets,
    unsubRetraitsCommission, unsubDiffusions, unsubMessagesPrives,
    unsubFraisInscription, unsubDepenses, unsubRedistributions, unsubParametres
  );
}

function render() {
  renderApercu();
  renderCollecteurs();
  renderMembres();
  renderConfirmations();
  renderMembresEnAttente();
  renderRetraits();
  renderCommunication();
  renderRapportParType();
}

function preremplirFormulaireParametres() {
  const form = document.getElementById("form-parametres-interets");
  if (!form) return;
  form.pdg.value = (state.parametresInterets.pdg * 100).toFixed(1);
  form.collecteur.value = (state.parametresInterets.collecteur * 100).toFixed(1);
  form.redistribution.value = (state.parametresInterets.redistribution * 100).toFixed(1);
}

document.getElementById("form-parametres-interets").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const pdgPct = Number(fd.get("pdg"));
  const collecteurPct = Number(fd.get("collecteur"));
  const redistributionPct = Number(fd.get("redistribution"));
  const erreurZone = document.getElementById("parametres-erreur");
  erreurZone.textContent = "";

  const somme = pdgPct + collecteurPct + redistributionPct;
  if (Math.abs(somme - 100) > 0.05) {
    erreurZone.textContent = `La somme des 3 pourcentages doit faire 100% (actuellement ${somme.toFixed(1)}%).`;
    return;
  }

  try {
    await setDoc(doc(db, "parametres", "interets_types_annuels"), {
      pdg: pdgPct / 100,
      collecteur: collecteurPct / 100,
      redistribution: redistributionPct / 100,
      date_maj: serverTimestamp(),
      maj_par: state.currentUser.uid,
    });
    notifier("Paramètres enregistrés.", "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + err.message, "erreur");
  }
});

function calculerEpargneNetteContrat(contrat) {
  const typeContrat = contrat.type_contrat || "journalier";
  const versements = state.payments.filter((p) => p.contract_id === contrat.id && p.statut !== "annule");

  if (typeContrat === "journalier") {
    return versements.filter((p) => p.jour_numero !== 1).reduce((s, p) => s + Number(p.montant || 0), 0);
  }
  let epargne = versements.reduce((s, p) => s + Number(p.montant || 0), 0);
  const depensesNonCompensees = state.depenses
    .filter((d) => d.contract_id === contrat.id && !d.compensee)
    .reduce((s, d) => s + Number(d.montant || 0), 0);
  const redistributionsRecues = state.redistributions
    .filter((r) => r.contract_id === contrat.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  return epargne - depensesNonCompensees + redistributionsRecues;
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

function calculerCommissionPdgParCollecteur(collecteurId) {
  const jour1Confirmes = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero === 1
  );
  const totalJour1Confirme = jour1Confirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionPdgInscriptions = totalJour1Confirme * 0.70;

  const fraisInscriptionPdg = state.fraisInscriptions
    .filter((f) => f.collecteur_id === collecteurId)
    .reduce((s, f) => s + Number(f.montant_pdg || 0), 0);

  const interetsPdgCollecteur = state.interetsPartages
    .filter((i) => i.collecteur_id === collecteurId)
    .reduce((s, i) => s + Number(i.montant_pdg || 0), 0);

  const commissionPdgTotale = commissionPdgInscriptions + fraisInscriptionPdg + interetsPdgCollecteur;

  const retraitsPdgConfirmes = state.retraitsCommission
    .filter((r) => r.beneficiaire_role === "pdg" && r.collecteur_id === collecteurId && r.statut === "confirme")
    .reduce((s, r) => s + Number(r.montant || 0), 0);

  return Math.max(0, commissionPdgTotale - retraitsPdgConfirmes);
}

function calculerCommissionCollecteurPropre(collecteurId) {
  const jour1Confirmes = state.payments.filter(
    (p) => p.collecteur_id === collecteurId && p.statut === "confirme" && p.jour_numero === 1
  );
  const totalJour1Confirme = jour1Confirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionInscriptions = totalJour1Confirme * 0.30;

  const fraisInscriptionCollecteur = state.fraisInscriptions
    .filter((f) => f.collecteur_id === collecteurId)
    .reduce((s, f) => s + Number(f.montant_collecteur || 0), 0);

  const interetsCollecteur = state.interetsPartages
    .filter((i) => i.collecteur_id === collecteurId)
    .reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);

  return commissionInscriptions + fraisInscriptionCollecteur + interetsCollecteur;
}

function calculerSoldeEpargneNetCollecteur(collecteurId) {
  const contratsCollecteur = state.contracts.filter((ct) => ct.collecteur_id === collecteurId && ct.statut === "actif");
  return contratsCollecteur.reduce((s, ct) => s + Math.max(0, calculerEpargneNetteContrat(ct)), 0);
}

function listerPrefecturesAvecCollecteurs() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const zones = new Set();
  collecteurs.forEach((c) => {
    zones.add(c.prefecture && c.prefecture.trim() ? c.prefecture.trim() : "Non précisé");
  });
  return Array.from(zones).sort((a, b) => a.localeCompare(b, "fr"));
}

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
// === FIN PDG — PARTIE 1/3 ===
