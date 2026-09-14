// === MEMBRE — PARTIE 1/2 ===
import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  uploaderPhotoProfil,
  changerMotDePasse,
} from "./firebase-config.js";

import {
  formatMontant,
  formatDate,
  formatDateHeure,
  badgeStatut,
  afficherMessage,
  calculerStatutContrat,
  TYPES_CONTRAT,
  infoTypeContrat,
  calculerMontantDuPretGeneralise,
} from "./utils.js";

const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><rect width='56' height='56' fill='%23ddd'/></svg>";

let currentUser = null;
let currentMemberData = null;
let propositionActuelle = null;
let contratsTousMembre = [];
let versementsConfirmesMembre = [];
let tousPaiementsMembre = [];
let tousPretsMembre = [];
let tousRemboursementsMembre = [];
let toutesDepensesMembre = [];
let toutesRedistributionsMembre = [];
let demandesRetraitMembre = [];
let diffusionsMembre = [];
let mesMessagesPdgMembre = [];
let propositionsNouveauContratMembre = [];
let parametresInteretsMembre = { pdg: 0.70, collecteur: 0.30, redistribution: 0 };

const loginScreen = document.getElementById('loginScreen');
const loading = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');
const loginError = document.getElementById('loginError');

function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.cpct-tina.local`;
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const telephone = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  loginError.textContent = '';

  if (!telephone || !password) {
    loginError.textContent = 'Veuillez remplir tous les champs.';
    return;
  }

  const email = telephoneVersEmailTechnique(telephone);

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = "Téléphone ou mot de passe incorrect.";
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    let compteValide = false;
    try {
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      if (userSnap.exists() && userSnap.data().role === 'membre' && userSnap.data().statut !== 'supprime') {
        compteValide = true;
      }
    } catch (e) {
      console.error(e);
    }

    if (!compteValide) {
      await signOut(auth);
      currentUser = null;
      dashboard.classList.add('hidden');
      loading.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      loginError.textContent = "Ce compte a été supprimé. Contactez votre PDG ou votre collecteur.";
      return;
    }

    currentUser = user;
    loginScreen.classList.add('hidden');
    loading.classList.remove('hidden');
    await chargerDonneesMembre(user.uid);
    loading.classList.add('hidden');
    dashboard.classList.remove('hidden');
    ajouterBoutonChangerMotDePasse();
  } else {
    currentUser = null;
    dashboard.classList.add('hidden');
    loading.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }
});

document.getElementById('membre-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  try {
    const url = await uploaderPhotoProfil(currentUser.uid, file);
    await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
    if (currentMemberData) currentMemberData.photoURL = url;
    document.getElementById('membre-avatar').src = url;
    afficherMessage('retraitMsg', 'Photo de profil mise à jour.', 'green');
  } catch (err) {
    console.error(err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de la photo : " + err.message, 'red');
  }
});

function ajouterBoutonChangerMotDePasse() {
  if (document.getElementById('btn-changer-mdp')) return;
  const btnLogout = document.getElementById('logoutBtn');
  if (!btnLogout) return;
  btnLogout.insertAdjacentHTML(
    'beforebegin',
    `<button type="button" id="btn-changer-mdp" style="width:auto; margin-right:8px;">Changer mon mot de passe</button>`
  );
  document.getElementById('btn-changer-mdp').addEventListener('click', ouvrirChangementMotDePasse);
}

function ouvrirChangementMotDePasseModal(html) {
  let overlay = document.getElementById('modal-overlay-mdp');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay-mdp';
    Object.assign(overlay.style, {
      position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 1000,
    });
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay-mdp') overlay.remove();
    });
  }
  const carte = document.createElement('div');
  Object.assign(carte.style, {
    background: 'white', borderRadius: '12px', padding: '24px',
    width: '85%', maxWidth: '350px',
  });
  carte.innerHTML = html;
  overlay.innerHTML = '';
  overlay.appendChild(carte);
  return overlay;
}

function ouvrirChangementMotDePasse() {
  const overlay = ouvrirChangementMotDePasseModal(`
    <h2 style="color:#0d6efd;">Changer mon mot de passe</h2>
    <p style="color:#666; font-size:13px; margin-bottom:12px;">Confirmez votre mot de passe actuel puis saisissez le nouveau.</p>
    <form id="form-changer-mdp">
      <label style="display:block; margin-bottom:10px;">Mot de passe actuel
        <input type="password" name="ancien" required style="width:100%; margin-top:4px;" />
      </label>
      <label style="display:block; margin-bottom:10px;">Nouveau mot de passe (6 caractères min)
        <input type="password" name="nouveau" minlength="6" required style="width:100%; margin-top:4px;" />
      </label>
      <label style="display:block; margin-bottom:14px;">Confirmer le nouveau mot de passe
        <input type="password" name="confirmation" minlength="6" required style="width:100%; margin-top:4px;" />
      </label>
      <div id="changer-mdp-msg" style="font-size:13px; margin-bottom:10px;"></div>
      <div style="display:flex; gap:8px;">
        <button type="button" id="btn-annuler-mdp" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById('btn-annuler-mdp').addEventListener('click', () => overlay.remove());
  document.getElementById('form-changer-mdp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ancien = fd.get('ancien');
    const nouveau = fd.get('nouveau');
    const confirmation = fd.get('confirmation');
    const msgZone = document.getElementById('changer-mdp-msg');

    if (nouveau !== confirmation) {
      msgZone.textContent = 'Les deux mots de passe ne correspondent pas.';
      msgZone.style.color = 'red';
      return;
    }

    try {
      const emailTechnique = telephoneVersEmailTechnique(currentMemberData.telephone);
      await changerMotDePasse(emailTechnique, ancien, nouveau);
      msgZone.textContent = 'Mot de passe modifié avec succès.';
      msgZone.style.color = 'green';
      setTimeout(() => overlay.remove(), 1200);
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        msgZone.textContent = 'Mot de passe actuel incorrect.';
      } else {
        msgZone.textContent = 'Erreur : ' + err.message;
      }
      msgZone.style.color = 'red';
    }
  });
}

// ==========================================================
// --- NOUVEAU (13 sept 2026) : bouton "COMMUNICATION" créé en JS.
// Masque par défaut les diffusions du PDG, le fil de messages privés et le
// formulaire de réponse. Un clic sur le bouton affiche/masque ces zones.
// ==========================================================
function initialiserBoutonCommunicationMembre() {
  if (document.getElementById('btn-communication-membre')) return;
  const ids = ['diffusionsMembreList', 'filPdgMessagesMembre', 'form-message-pdg-membre'];
  const cartes = [];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const carte = el.closest('.card') || el.parentElement;
    if (carte && !cartes.includes(carte)) cartes.push(carte);
  });
  if (cartes.length === 0) return;

  cartes.forEach((c) => c.classList.add('hidden'));

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-communication-membre';
  btn.textContent = 'COMMUNICATION';
  btn.style.width = '100%';
  btn.style.marginBottom = '10px';
  btn.style.background = '#0d6efd';
  btn.style.color = 'white';
  btn.addEventListener('click', () => {
    const masque = cartes[0].classList.contains('hidden');
    cartes.forEach((c) => c.classList.toggle('hidden', !masque));
  });
  cartes[0].insertAdjacentElement('beforebegin', btn);
}

async function chargerDonneesMembre(uid) {
  try {
    const memberRef = doc(db, 'users', uid);
    const memberSnap = await getDoc(memberRef);

    if (memberSnap.exists()) {
      currentMemberData = memberSnap.data();
      document.getElementById('memberName').textContent = currentMemberData.nom || 'Membre';
      document.getElementById('membre-avatar').src = currentMemberData.photoURL || AVATAR_DEFAUT;

      if (currentMemberData.parrain_id) {
        const collecteurSnap = await getDoc(doc(db, 'users', currentMemberData.parrain_id));
        if (collecteurSnap.exists()) {
          const collecteur = collecteurSnap.data();
          document.getElementById('collecteurNom').textContent = collecteur.nom || '';
          document.getElementById('collecteurTelephone').textContent = collecteur.telephone || '';
        }
      }
    } else {
      document.getElementById('memberName').textContent = 'Membre';
      document.getElementById('membre-avatar').src = AVATAR_DEFAUT;
    }
    ecouterCotisations(uid);
    ecouterContratsMembre(uid);
    ecouterHistoriqueRetraits(uid);
    ecouterPretsMembre(uid);
    ecouterRemboursements();
    ecouterDepensesMembre(uid);
    ecouterRedistributionsMembre(uid);
    ecouterPropositionReconduction(uid);
    ecouterDiffusionsMembre();
    ecouterMessagesPdgMembre(uid);
    ecouterParametresMembre();
    ecouterPropositionsNouveauContrat(uid);
    initialiserBoutonCommunicationMembre();

  } catch (err) {
    console.error('Erreur chargement membre :', err);
  }
}

function ecouterContratsMembre(uid) {
  const q = query(
    collection(db, 'contracts'),
    where('membre_id', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    contratsTousMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rafraichirTableauDeBord();
  });
}

function ecouterPretsMembre(uid) {
  const q = query(collection(db, 'prets'), where('membre_id', '==', uid));
  onSnapshot(q, (snapshot) => {
    tousPretsMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rafraichirTableauDeBord();
  });
}

function ecouterRemboursements() {
  onSnapshot(collection(db, 'remboursements_prets'), (snapshot) => {
    tousRemboursementsMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rafraichirTableauDeBord();
  });
}

function ecouterDepensesMembre(uid) {
  const q = query(collection(db, 'depenses'), where('membre_id', '==', uid));
  onSnapshot(q, (snapshot) => {
    toutesDepensesMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rafraichirTableauDeBord();
  });
}

function ecouterRedistributionsMembre(uid) {
  const q = query(collection(db, 'redistributions_interets'), where('membre_id', '==', uid));
  onSnapshot(q, (snapshot) => {
    toutesRedistributionsMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    rafraichirTableauDeBord();
  });
}

function ecouterParametresMembre() {
  onSnapshot(doc(db, 'parametres', 'interets_types_annuels'), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      parametresInteretsMembre = {
        pdg: Number(d.pdg ?? 0.70),
        collecteur: Number(d.collecteur ?? 0.30),
        redistribution: Number(d.redistribution ?? 0),
      };
    }
  });
}

function calculerEpargneNetteContratLocal(contrat) {
  const typeContrat = contrat.type_contrat || 'journalier';
  const versements = versementsConfirmesMembre.filter((v) => v.contract_id === contrat.id);

  if (typeContrat === 'journalier') {
    return versements.filter((v) => v.jour_numero !== 1).reduce((s, v) => s + Number(v.montant || 0), 0);
  }
  let epargne = versements.reduce((s, v) => s + Number(v.montant || 0), 0);
  const depensesNonCompensees = toutesDepensesMembre
    .filter((d) => d.contract_id === contrat.id && !d.compensee)
    .reduce((s, d) => s + Number(d.montant || 0), 0);
  const redistributionsRecues = toutesRedistributionsMembre
    .filter((r) => r.contract_id === contrat.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  return epargne - depensesNonCompensees + redistributionsRecues;
}

function trouverPretActif(contratId) {
  return tousPretsMembre.find((p) => p.contract_id === contratId && p.statut === 'actif') || null;
}

function calculerMontantDuPret(pret) {
  return calculerMontantDuPretGeneralise(pret, tousRemboursementsMembre);
}

function calculerSoldeDisponibleContrat(contrat) {
  const epargneNette = calculerEpargneNetteContratLocal(contrat);
  const pret = trouverPretActif(contrat.id);
  const pretDu = pret ? calculerMontantDuPret(pret) : 0;
  return Math.max(0, epargneNette - pretDu);
}

function calculerAnciensContratsNonSoldes() {
  const idsActifs = new Set(contratsTousMembre.filter((c) => c.statut === 'actif').map((c) => c.id));
  const anciensNonSoldes = contratsTousMembre.filter((c) =>
    c.statut === 'cloture' && !c.epargne_soldee && !idsActifs.has(c.id)
  );
  const total = anciensNonSoldes.reduce(
    (s, c) => s + Math.max(0, calculerEpargneNetteContratLocal(c)), 0
  );
  return { anciensNonSoldes, total };
}

function contratsActifs() {
  return contratsTousMembre.filter((c) => c.statut === 'actif');
}

function rafraichirTableauDeBord() {
  renderMesContrats();
  mettreAJourContratNonSolde();
  mettreAJourSelecteurRetrait();
}

function renderMesContrats() {
  const zone = document.getElementById('mesContratsZone');
  if (!zone) return;

  const actifs = contratsActifs();

  if (actifs.length === 0) {
    zone.innerHTML = '<div class="card"><p style="color:#999; font-size:13px;">Aucun contrat en cours.</p></div>';
    return;
  }

  const versementsConfirmesTous = versementsConfirmesMembre;

  zone.innerHTML = actifs.map((contrat) => {
    const typeContrat = contrat.type_contrat || 'journalier';
    const infoType = infoTypeContrat(typeContrat);
    const dureeTotale = contrat.duree_totale || infoType.duree;
    const versementsContrat = versementsConfirmesTous
      .filter((v) => v.contract_id === contrat.id)
      .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
    const periodesPayees = versementsContrat.length;
    const epargneNette = calculerEpargneNetteContratLocal(contrat);
    const solde = Math.max(0, epargneNette);
    const pret = trouverPretActif(contrat.id);
    const soldeDisponible = calculerSoldeDisponibleContrat(contrat);
    const statutInactif = calculerStatutContrat(contrat, versementsConfirmesTous) === 'inactif';

    const depensesNonCompensees = toutesDepensesMembre.filter((d) => d.contract_id === contrat.id && !d.compensee);
    const totalDepensesNonCompensees = depensesNonCompensees.reduce((s, d) => s + Number(d.montant || 0), 0);
    const redistributionsRecues = toutesRedistributionsMembre.filter((r) => r.contract_id === contrat.id);
    const totalRedistributionsRecues = redistributionsRecues.reduce((s, r) => s + Number(r.montant || 0), 0);

    const idListe = `cotis-list-${contrat.id}`;
    const idTitre = `cotis-titre-${contrat.id}`;

    return `
      <div class="contrat-card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${infoType.label}</strong>
          ${statutInactif ? '<span class="badge refuse" style="width:auto;">Inactif</span>' : ''}
        </div>
        <div class="contrat-solde">${formatMontant(solde)}</div>
        <p style="text-align:center; color:#666; font-size:12px; margin-bottom:8px;">
          ${infoType.labelPeriode.charAt(0).toUpperCase() + infoType.labelPeriode.slice(1)} ${periodesPayees}/${dureeTotale} ·
          ${infoType.labelVersement} : ${formatMontant(contrat.montant_mise)}
        </p>
        ${pret ? `
          <div class="pret-card" style="margin:10px 0;">
            <p><strong>Prêt en cours</strong></p>
            <p>Capital emprunté : ${formatMontant(pret.montant_initial)}</p>
            <p>Montant dû actuellement : <strong>${formatMontant(calculerMontantDuPret(pret))}</strong></p>
            <p style="font-size:12px; color:#c0392b;">Aucune nouvelle demande de retrait ou de prêt n'est possible sur ce contrat tant que ce prêt n'est pas totalement remboursé.</p>
          </div>
        ` : ''}
        ${totalDepensesNonCompensees > 0 ? `
          <p style="font-size:13px; color:#e67e22; font-weight:bold; margin-top:6px;">Dépenses non compensées : ${formatMontant(totalDepensesNonCompensees)}</p>
          <div style="max-height:100px; overflow-y:auto; margin-top:4px;">
            ${depensesNonCompensees.map((d) => `
              <div class="cotis-row"><span>${d.date_depense || ''} — ${d.libelle}</span><span>${formatMontant(d.montant)}</span></div>
            `).join('')}
          </div>
        ` : ''}
        ${totalRedistributionsRecues > 0 ? `<p style="font-size:12px; color:#198754; margin-top:6px;">Redistribution d'intérêt reçue (cumul) : ${formatMontant(totalRedistributionsRecues)}</p>` : ''}
        <h3 class="collapsible-title" id="${idTitre}" style="margin-top:12px; font-size:14px;">Historique des versements</h3>
        <div id="${idListe}" class="hidden" style="margin-top:6px;">
          ${versementsContrat.length === 0
            ? '<p style="color:#999; font-size:13px;">Aucune cotisation enregistrée.</p>'
            : versementsContrat.map((v) => `
                <div class="cotis-row"><span>${formatDate(v.date)}</span><span>${formatMontant(v.montant)}</span></div>
              `).join('')
          }
        </div>
      </div>
    `;
  }).join('');

  actifs.forEach((contrat) => {
    const titre = document.getElementById(`cotis-titre-${contrat.id}`);
    const liste = document.getElementById(`cotis-list-${contrat.id}`);
    if (titre && liste) {
      titre.addEventListener('click', () => {
        liste.classList.toggle('hidden');
        titre.classList.toggle('ouvert');
      });
    }
  });
}
// === FIN MEMBRE — PARTIE 1/2 ===// === MEMBRE — PARTIE 2/2 ===
function mettreAJourContratNonSolde() {
  const zone = document.getElementById('contratNonSoldeZone');
  if (!zone) return;

  const { total: totalNonSolde } = calculerAnciensContratsNonSoldes();

  if (totalNonSolde > 0) {
    zone.innerHTML = `
      <div class="pret-card" style="border-left-color:#c0392b;">
        <p><strong style="color:#c0392b;">Contrat(s) non soldé(s)</strong></p>
        <p>Épargne non retirée d'ancien(s) contrat(s) : <strong>${formatMontant(totalNonSolde)}</strong></p>
        <p style="font-size:12px; color:#999;">Pour la retirer, choisissez ce contrat ci-dessous et tapez ce montant dans "Demander un retrait".</p>
      </div>
    `;
  } else {
    zone.innerHTML = '';
  }
}

function mettreAJourSelecteurRetrait() {
  const select = document.getElementById('contratSelectionneRetrait');
  const champZone = document.getElementById('champSelectionContratRetrait');
  if (!select) return;

  const actifs = contratsActifs();
  const { anciensNonSoldes } = calculerAnciensContratsNonSoldes();
  const options = [];

  actifs.forEach((c) => {
    const infoType = infoTypeContrat(c.type_contrat || 'journalier');
    options.push({ value: c.id, label: `${infoType.label} — en cours` });
  });
  anciensNonSoldes.forEach((c) => {
    const infoType = infoTypeContrat(c.type_contrat || 'journalier');
    options.push({ value: c.id, label: `${infoType.label} — contrat terminé, non soldé` });
  });

  const valeurActuelle = select.value;
  select.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  if (options.some((o) => o.value === valeurActuelle)) {
    select.value = valeurActuelle;
  }

  if (champZone) {
    champZone.classList.toggle('hidden', options.length <= 1);
  }
}

function ecouterPropositionReconduction(uid) {
  const q = query(
    collection(db, 'propositions_reconduction'),
    where('membre_id', '==', uid),
    where('statut', '==', 'en_attente')
  );
  onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      propositionActuelle = null;
      afficherPropositionReconduction();
      return;
    }
    const d = snapshot.docs[0];
    propositionActuelle = { id: d.id, ...d.data() };
    afficherPropositionReconduction();
  });
}

function afficherPropositionReconduction() {
  const zone = document.getElementById('propositionZone');
  if (!zone) return;
  if (!propositionActuelle) {
    zone.innerHTML = '';
    return;
  }
  zone.innerHTML = `
    <div class="proposition-card">
      <p><strong>Votre contrat est arrivé à son terme.</strong></p>
      <p>Souhaitez-vous reconduire votre épargne ?</p>
      <button id="btn-reconduire-memes-termes">Reconduire aux mêmes conditions</button>
      <button id="btn-reconduire-modifie">Reconduire avec modification</button>
      <button id="btn-refuser-reconduction">Ne pas reconduire</button>
    </div>
  `;
  document.getElementById('btn-reconduire-memes-termes').addEventListener('click', () => repondreProposition('reconduit_meme_termes'));
  document.getElementById('btn-reconduire-modifie').addEventListener('click', ouvrirModificationMontant);
  document.getElementById('btn-refuser-reconduction').addEventListener('click', () => repondreProposition('refuse'));
}

function ecouterPropositionsNouveauContrat(uid) {
  const q = query(
    collection(db, 'propositions_nouveau_contrat'),
    where('membre_id', '==', uid),
    where('statut', '==', 'en_attente')
  );
  onSnapshot(q, (snapshot) => {
    propositionsNouveauContratMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    afficherPropositionsNouveauContrat();
  });
}

function afficherPropositionsNouveauContrat() {
  let zone = document.getElementById('nouveauxContratsZone');
  if (!zone) {
    zone = document.createElement('div');
    zone.id = 'nouveauxContratsZone';
    const propositionZoneEl = document.getElementById('propositionZone');
    if (propositionZoneEl && propositionZoneEl.parentElement) {
      propositionZoneEl.insertAdjacentElement('afterend', zone);
    } else {
      dashboard.prepend(zone);
    }
  }

  if (propositionsNouveauContratMembre.length === 0) {
    zone.innerHTML = '';
    return;
  }

  zone.innerHTML = propositionsNouveauContratMembre.map((p) => {
    const infoType = infoTypeContrat(p.type_contrat || 'journalier');
    return `
      <div class="proposition-card" data-id="${p.id}">
        <p><strong>Votre collecteur vous propose un nouveau contrat : ${infoType.label}</strong></p>
        <p>${infoType.labelVersement} : ${formatMontant(p.montant_periode)}${p.frais_inscription ? ` — Frais d'inscription : ${formatMontant(p.frais_inscription)}` : ''}</p>
        <p style="font-size:12px; color:#666;">Ce contrat s'ajoutera à votre/vos contrat(s) en cours si vous confirmez. Vous pouvez aussi le rejeter.</p>
        <button data-action="confirmer-nouveau-contrat" data-id="${p.id}">Confirmer</button>
        <button data-action="rejeter-nouveau-contrat" data-id="${p.id}">Rejeter</button>
      </div>
    `;
  }).join('');

  zone.querySelectorAll('[data-action="confirmer-nouveau-contrat"]').forEach((btn) => {
    btn.addEventListener('click', () => confirmerNouveauContrat(btn.dataset.id));
  });
  zone.querySelectorAll('[data-action="rejeter-nouveau-contrat"]').forEach((btn) => {
    btn.addEventListener('click', () => rejeterNouveauContrat(btn.dataset.id));
  });
}

async function confirmerNouveauContrat(propositionId) {
  const proposition = propositionsNouveauContratMembre.find((p) => p.id === propositionId);
  if (!proposition) return;

  try {
    const typeContrat = proposition.type_contrat || 'journalier';
    const infoType = infoTypeContrat(typeContrat);
    const contratData = {
      membre_id: currentUser.uid,
      membre_nom: currentMemberData ? currentMemberData.nom : '',
      collecteur_id: proposition.collecteur_id,
      statut: 'actif',
      type_contrat: typeContrat,
      duree_totale: infoType.duree,
      montant_mise: proposition.montant_periode,
      date_debut: new Date().toISOString(),
    };
    if (typeContrat === 'journalier') {
      contratData.commission = proposition.montant_periode;
    } else {
      contratData.frais_inscription = proposition.frais_inscription || 0;
    }

    const contratRef = await addDoc(collection(db, 'contracts'), contratData);

    if (typeContrat === 'journalier') {
      await addDoc(collection(db, 'payments'), {
        contract_id: contratRef.id,
        collecteur_id: proposition.collecteur_id,
        membre_id: currentUser.uid,
        montant: proposition.montant_periode,
        jour_numero: 1,
        statut: 'collecte',
        date: serverTimestamp(),
      });
    } else if (proposition.frais_inscription > 0) {
      const montantPdg = proposition.frais_inscription * parametresInteretsMembre.pdg;
      const montantCollecteur = proposition.frais_inscription * parametresInteretsMembre.collecteur;
      await addDoc(collection(db, 'frais_inscription'), {
        contract_id: contratRef.id,
        membre_id: currentUser.uid,
        collecteur_id: proposition.collecteur_id,
        montant_total: proposition.frais_inscription,
        montant_pdg: montantPdg,
        montant_collecteur: montantCollecteur,
        date: serverTimestamp(),
      });
    }

    await updateDoc(doc(db, 'propositions_nouveau_contrat', proposition.id), {
      statut: 'accepte',
      contrat_cree_id: contratRef.id,
      date_reponse: serverTimestamp(),
    });

    afficherMessage('retraitMsg', 'Nouveau contrat confirmé et ajouté à vos contrats.', 'green');
  } catch (err) {
    console.error('Erreur confirmation nouveau contrat :', err);
    afficherMessage('retraitMsg', "Erreur lors de la confirmation du contrat.", 'red');
  }
}

async function rejeterNouveauContrat(propositionId) {
  try {
    await updateDoc(doc(db, 'propositions_nouveau_contrat', propositionId), {
      statut: 'refuse',
      date_reponse: serverTimestamp(),
    });
    afficherMessage('retraitMsg', 'Proposition de nouveau contrat rejetée.', 'green');
  } catch (err) {
    console.error('Erreur rejet nouveau contrat :', err);
    afficherMessage('retraitMsg', "Erreur lors du rejet.", 'red');
  }
}

function ecouterCotisations(uid) {
  const q = query(
    collection(db, 'payments'),
    where('membre_id', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    tousPaiementsMembre = snapshot.docs.map((d) => d.data());
    versementsConfirmesMembre = tousPaiementsMembre.filter((d) => d.statut !== 'annule');
    rafraichirTableauDeBord();
  });
}

function libelleTypeRetrait(type) {
  const labels = {
    'pret': 'Prêt (en cours de contrat)',
    'solde_contrat_termine': 'Solde de contrat terminé',
    'retrait_final': 'Retrait final (clôture du contrat)',
  };
  return labels[type] || 'Retrait';
}

function ecouterHistoriqueRetraits(uid) {
  const q = query(
    collection(db, 'withdrawalRequests'),
    where('memberId', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    const list = document.getElementById('withdrawalHistory');
    list.innerHTML = '';

    demandesRetraitMembre = snapshot.docs.map((d) => d.data());
    rafraichirTableauDeBord();

    if (snapshot.empty) {
      list.innerHTML = '<p style="color:#999; font-size:13px;">Aucune demande pour le moment.</p>';
      return;
    }

    const docs = [...demandesRetraitMembre]
      .sort((a, b) => (b.dateCreation?.toMillis?.() || 0) - (a.dateCreation?.toMillis?.() || 0));

    docs.forEach((data) => {
      const row = document.createElement('div');
      row.className = 'cotis-row';
      row.innerHTML = `
        <span>${formatMontant(data.montant)} — <small>${libelleTypeRetrait(data.type)}</small><br>
        <small style="color:#999;">${formatDateHeure(data.dateCreation)}</small></span>
        ${badgeStatut(data.statut)}
      `;
      list.appendChild(row);
    });
  });
}

function evaluerCasRetrait(montant, contratId) {
  const contrat = contratsTousMembre.find((c) => c.id === contratId);
  if (!contrat) {
    return { decision: 'rejet', message: "Contrat introuvable. Veuillez réessayer." };
  }

  const pretActifDuContrat = trouverPretActif(contrat.id);
  if (pretActifDuContrat) {
    const montantDu = calculerMontantDuPret(pretActifDuContrat);
    return {
      decision: 'rejet',
      message: `Vous avez déjà un prêt en cours sur ce contrat (${formatMontant(montantDu)} dû). Aucune nouvelle demande de retrait ou de prêt n'est possible tant qu'il n'est pas totalement remboursé.`,
    };
  }

  const estContratTermineNonSolde = contrat.statut === 'cloture' && !contrat.epargne_soldee;
  const epargneNette = calculerEpargneNetteContratLocal(contrat);

  if (estContratTermineNonSolde) {
    if (montant > epargneNette) {
      return { decision: 'rejet', message: `Retrait impossible : le montant dépasse l'épargne non soldée de ce contrat (${formatMontant(epargneNette)}).` };
    }
    return {
      decision: 'accepte',
      type: 'solde_contrat_termine',
      contratId: contrat.id,
      message: 'Demande envoyée à votre collecteur : ce retrait sera traité comme un solde de contrat terminé.',
    };
  }

  if (contrat.statut !== 'actif') {
    return { decision: 'rejet', message: "Ce contrat n'est plus actif." };
  }

  if (montant > epargneNette) {
    return { decision: 'rejet', message: "Retrait impossible : le montant dépasse votre épargne nette actuelle sur ce contrat." };
  }

  if (montant === epargneNette) {
    return {
      decision: 'accepte',
      type: 'retrait_final',
      contratId: contrat.id,
      message: 'Demande envoyée à votre collecteur : ce retrait clôturera ce contrat si votre collecteur la confirme.',
    };
  }

  return {
    decision: 'accepte',
    type: 'pret',
    contratId: contrat.id,
    message: 'Demande envoyée à votre collecteur : ce retrait sera traité comme un prêt sur ce contrat, en attente de sa validation.',
  };
}

document.getElementById('demandeRetraitBtn').addEventListener('click', async () => {
  const montantInput = document.getElementById('montantRetrait');
  const montant = parseFloat(montantInput.value);
  const contratId = document.getElementById('contratSelectionneRetrait').value;
  const retraitMsg = document.getElementById('retraitMsg');
  retraitMsg.textContent = '';

  if (!montant || montant <= 0) {
    afficherMessage('retraitMsg', 'Veuillez entrer un montant valide.', 'red');
    return;
  }

  if (!contratId) {
    afficherMessage('retraitMsg', "Vous n'avez aucun contrat éligible à un retrait actuellement.", 'red');
    return;
  }

  if (!currentMemberData || !currentMemberData.parrain_id) {
    afficherMessage('retraitMsg', "Aucun collecteur n'est rattaché à votre compte. Contactez le PDG.", 'red');
    return;
  }

  const demandeDejaEnCours = demandesRetraitMembre.some((d) => d.statut === 'en_attente' && d.contractId === contratId);
  if (demandeDejaEnCours) {
    afficherMessage('retraitMsg', 'Vous avez déjà une demande en attente pour ce contrat. Attendez son traitement avant d\'en envoyer une nouvelle.', 'red');
    return;
  }

  const resultat = evaluerCasRetrait(montant, contratId);

  if (resultat.decision === 'rejet') {
    afficherMessage('retraitMsg', resultat.message, 'red');
    return;
  }

  try {
    await addDoc(collection(db, 'withdrawalRequests'), {
      memberId: currentUser.uid,
      memberName: currentMemberData ? currentMemberData.nom : '',
      collecteur_id: currentMemberData.parrain_id,
      montant: montant,
      statut: 'en_attente',
      type: resultat.type,
      contractId: resultat.contratId,
      dateCreation: serverTimestamp(),
    });
    afficherMessage('retraitMsg', resultat.message, 'green');
    montantInput.value = '';
  } catch (err) {
    console.error('Erreur demande de retrait :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de la demande.", 'red');
  }
});

async function repondreProposition(choix) {
  if (!propositionActuelle) return;
  try {
    await updateDoc(doc(db, 'propositions_reconduction', propositionActuelle.id), {
      statut: choix,
      date_reponse: serverTimestamp(),
    });
    afficherMessage('retraitMsg', 'Votre réponse a été enregistrée.', 'green');
  } catch (err) {
    console.error('Erreur réponse proposition :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de votre réponse.", 'red');
  }
}

function ouvrirModificationMontant() {
  const nouveauMontant = prompt('Quel nouveau montant de versement souhaitez-vous ? (GNF)');
  if (nouveauMontant === null) return;
  const montantNum = parseFloat(nouveauMontant);
  if (isNaN(montantNum) || montantNum <= 0) {
    afficherMessage('retraitMsg', 'Montant invalide.', 'red');
    return;
  }
  enregistrerModificationMontant(montantNum);
}

async function enregistrerModificationMontant(nouveauMontant) {
  if (!propositionActuelle) return;
  try {
    await updateDoc(doc(db, 'propositions_reconduction', propositionActuelle.id), {
      statut: 'reconduit_modifie',
      nouveau_montant_mise: nouveauMontant,
      date_reponse: serverTimestamp(),
    });
    afficherMessage('retraitMsg', 'Votre demande de modification a été envoyée au PDG.', 'green');
  } catch (err) {
    console.error('Erreur modification montant :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de votre demande.", 'red');
  }
}

function ecouterDiffusionsMembre() {
  const q = query(collection(db, 'diffusions'), where('groupe_cible', '==', 'membres'));
  onSnapshot(q, (snapshot) => {
    diffusionsMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDiffusionsMembre();
  });
}

function renderDiffusionsMembre() {
  const container = document.getElementById('diffusionsMembreList');
  if (!container) return;

  const diffusionsTriees = [...diffusionsMembre].sort(
    (a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0)
  );

  if (diffusionsTriees.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucun message du PDG pour le moment.</p>';
    return;
  }

  container.innerHTML = diffusionsTriees.slice(0, 10).map((d) => `
    <div style="background:#f4f6f8; border-radius:8px; padding:10px; margin-bottom:8px;">
      <p style="font-size:13px;">${d.contenu}</p>
      <p style="font-size:11px; color:#999; margin-top:4px;">${formatDateHeure(d.date)}</p>
    </div>
  `).join('');
}

function ecouterMessagesPdgMembre(uid) {
  const q = query(collection(db, 'messages_prives'), where('participant_id', '==', uid));
  onSnapshot(q, (snapshot) => {
    mesMessagesPdgMembre = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFilPdgMembre();
  });
}

function renderFilPdgMembre() {
  const container = document.getElementById('filPdgMessagesMembre');
  const badge = document.getElementById('badgeMessagesNonLusMembre');
  if (!container) return;

  const messages = [...mesMessagesPdgMembre].sort(
    (a, b) => (a.date?.toMillis?.() || 0) - (b.date?.toMillis?.() || 0)
  );

  if (messages.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucun échange pour le moment. Écrivez au PDG ci-dessous.</p>';
  } else {
    container.innerHTML = messages.map((m) => `
      <div style="align-self:${m.expediteur_role === 'membre' ? 'flex-end' : 'flex-start'}; background:${m.expediteur_role === 'membre' ? '#0d6efd' : '#f0f0f0'}; color:${m.expediteur_role === 'membre' ? 'white' : '#222'}; border-radius:10px; padding:8px 12px; max-width:80%;">
        <p style="font-size:14px;">${m.contenu}</p>
        <p style="font-size:11px; opacity:0.7; margin-top:4px;">${formatDateHeure(m.date)}</p>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  const nonLus = messages.filter((m) => m.expediteur_role === 'pdg' && m.lu_participant === false);
  if (badge) {
    if (nonLus.length > 0) {
      badge.textContent = nonLus.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  const btnCommunicationMembre = document.getElementById('btn-communication-membre');
  if (btnCommunicationMembre) {
    btnCommunicationMembre.style.background = nonLus.length > 0 ? '#198754' : '#0d6efd';
  }

  nonLus.forEach(async (m) => {
    try {
      await updateDoc(doc(db, 'messages_prives', m.id), { lu_participant: true });
    } catch (err) {
      console.error(err);
    }
  });
}

document.getElementById('form-message-pdg-membre').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const contenu = fd.get('contenu').trim();
  if (!contenu || !currentMemberData) return;

  try {
    await addDoc(collection(db, 'messages_prives'), {
      participant_id: currentUser.uid,
      participant_nom: currentMemberData.nom,
      participant_role: 'membre',
      expediteur_id: currentUser.uid,
      expediteur_role: 'membre',
      contenu,
      date: serverTimestamp(),
      lu_pdg: false,
      lu_participant: true,
    });
    e.target.reset();
  } catch (err) {
    console.error(err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi du message : " + err.message, 'red');
  }
});

document.getElementById('titre-historique-demandes').addEventListener('click', () => {
  document.getElementById('withdrawalHistory').classList.toggle('hidden');
  document.getElementById('titre-historique-demandes').classList.toggle('ouvert');
});
// === FIN MEMBRE — PARTIE 2/2 ===
