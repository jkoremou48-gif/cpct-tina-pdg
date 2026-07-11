import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
} from "./firebase-config.js";

import {
  genererCodeParrain, formatGNF, formatDate, nomMois, calculerSoldes, notifier,
} from "./utils.js";

const state = {
  entreprise: null,
  currentUser: null,
  users: [],
  contracts: [],
  payments: [],
  decaissements: [],
  substitutionId: null,
  unsubscribers: [],
};
let creationEnCours = false;

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

  creationEnCours = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const codeParrain = genererCodeParrain("PDG");
    const userData = {
      role: "pdg",
      nom, telephone, email,
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

function lancerDashboard() {
  showScreen("screen-dashboard");
  document.getElementById("db-entreprise-nom").textContent = state.entreprise?.nom || "CPCT-TINA";
  document.getElementById("db-pdg-nom").textContent = state.currentUser.nom;

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
  state.unsubscribers.push(unsubUsers, unsubContracts, unsubPayments, unsubDecaissements);
}

function render() {
  renderApercu();
  renderCollecteurs();
  renderMembres();
}

function renderApercu() {
  const { totalEpargnes, totalCommissions, parMois } = calculerSoldes(state.payments, state.contracts);
  const totalDecaisse = (state.decaissements || []).reduce((s, d) => s + Number(d.montant), 0);
  const commissionsDisponibles = totalCommissions - totalDecaisse;

  document.getElementById("stat-total-epargnes").textContent = formatGNF(totalEpargnes);
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

function renderCollecteurs() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur");
  const container = document.getElementById("liste-collecteurs");
  if (collecteurs.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun collecteur enregistré. Générez un code pour en inviter un.</p>`;
    return;
  }
  container.innerHTML = collecteurs.map((c) => {
    const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === c.uid).length;
    const badgeClasse = c.statut === "actif" ? "badge-actif" : c.statut === "suspendu" ? "badge-suspendu" : "badge-licencie";
    return `
      <div class="entity-card" data-uid="${c.uid}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${c.nom}</p>
            <p class="entity-sub">${c.telephone} · ${nbClients} client(s)</p>
          </div>
          <span class="badge ${badgeClasse}">${c.statut}</span>
        </div>
        <div class="entity-actions">
          ${c.statut === "actif" ? `<button class="btn btn-ghost-sm" data-action="suspendre" data-uid="${c.uid}">Suspendre</button>` : ""}
          ${c.statut === "suspendu" ? `<button class="btn btn-ghost-sm" data-action="reactiver" data-uid="${c.uid}">Réactiver</button>` : ""}
          ${c.statut !== "licencie" ? `<button class="btn btn-danger btn-sm" data-action="licencier" data-uid="${c.uid}">Licencier</button>` : ""}
          ${c.statut !== "actif" ? `<button class="btn btn-secondary btn-sm" data-action="substituer" data-uid="${c.uid}" data-nom="${c.nom}">Gérer ses clients</button>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-collecteurs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, uid, nom } = btn.dataset;

  if (action === "suspendre" || action === "reactiver") {
    await updateDoc(doc(db, "users", uid), { statut: action === "suspendre" ? "suspendu" : "actif" });
    notifier(action === "suspendre" ? "Collecteur suspendu." : "Collecteur réactivé.", "succes");
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
});

document.getElementById("btn-quitter-substitution").addEventListener("click", () => {
  state.substitutionId = null;
  document.getElementById("banner-substitution").classList.add("hidden");
  renderMembres();
});

function renderMembres() {
  let membres = state.users.filter((u) => u.role === "membre");
  if (state.substitutionId) {
    membres = membres.filter((m) => m.parrain_id === state.substitutionId);
  }
  const recherche = (document.getElementById("recherche-membres").value || "").toLowerCase();
  if (recherche) {
    membres = membres.filter((m) => m.nom.toLowerCase().includes(recherche) || (m.telephone || "").includes(recherche));
  }

  const container = document.getElementById("liste-membres");
  if (membres.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre trouvé.</p>`;
    return;
  }
  container.innerHTML = membres.map((m) => {
    const contrat = state.contracts.find((c) => c.membre_id === m.uid && c.statut === "actif")
      || state.contracts.filter((c) => c.membre_id === m.uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""))[0];
    const versements = state.payments.filter((p) => contrat && p.contract_id === contrat.id);
    const totalVerse = versements.filter((p) => p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);
    const statutContrat = contrat ? contrat.statut : "aucun contrat";
    return `
      <div class="entity-card" data-uid="${m.uid}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone} · ${statutContrat}</p>
          </div>
          <span class="badge badge-actif">${formatGNF(totalVerse)}</span>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("recherche-membres").addEventListener("input", renderMembres);

document.getElementById("liste-membres").addEventListener("click", (e) => {
  const card = e.target.closest(".entity-card");
  if (!card) return;
  afficherDetailMembre(card.dataset.uid);
});

function afficherDetailMembre(uid) {
  const membre = state.users.find((u) => u.uid === uid);
  const contrats = state.contracts.filter((c) => c.membre_id === uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""));
  const contrat = contrats[0];
  const versements = contrat ? state.payments.filter((p) => p.contract_id === contrat.id).sort((a, b) => a.jour_numero - b.jour_numero) : [];
  const totalVerse = versements.filter((p) => p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);

  const html = `
    <h2>${membre.nom}</h2>
    <p class="subtitle-sm">${membre.telephone}</p>
    <div class="detail-line"><span>Statut du contrat</span><span>${contrat ? contrat.statut : "—"}</span></div>
    <div class="detail-line"><span>Début du contrat</span><span>${contrat ? formatDate(contrat.date_debut) : "—"}</span></div>
    <div class="detail-line"><span>Commission (jour 1)</span><span>${contrat ? formatGNF(contrat.commission) : "—"}</span></div>
    <div class="detail-line"><span>Total épargné</span><span>${formatGNF(totalVerse)}</span></div>
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
  document.getElementById("modal-overlay").classList.remove("hidden");
}
function fermerModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
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
  const disponible = totalCommissions - totalDecaisse;
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
      <button class="btn btn-secondary" id="btn-code-membre" style="flex:1;">Nouveau membre</button>
    </div>
  `);
  document.getElementById("btn-code-collecteur").addEventListener("click", () => genererEtAfficherCode("collecteur"));
  document.getElementById("btn-code-membre").addEventListener("click", () => genererEtAfficherCode("membre"));
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

demarrer();
