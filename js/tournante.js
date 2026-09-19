// js/tournante.js — Tontine tournante (espace PDG)
import {
  auth, db, onAuthStateChanged, doc, getDoc, setDoc, updateDoc,
  collection, onSnapshot, serverTimestamp, creerCompteSecondaire,
} from "./firebase-config.js";
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { formatGNF, formatDate, notifier } from "./utils.js";
import { adhererCaisse, finaliserAdhesionsEnAttente } from "./tournante-commun.js";

// ---------- Constantes ----------
const PCT_COLLECTEUR = 30;
const PCT_SECURITE = 40; // le PDG reçoit le reste (30 % + arrondis)
const PCT_CAUTION_SUGGEREE = 12;

const PERIODICITES = {
  jour: "Journalière",
  semaine: "Hebdomadaire",
  mois: "Mensuelle",
  trimestre: "Trimestrielle",
  semestre: "Semestrielle",
  annee: "Annuelle",
};

const INFRACTIONS_PAR_DEFAUT = [
  "Bavardage",
  "Téléphone qui sonne",
  "Dispute",
  "Trouble à l'ordre public",
  "Manque de respect à la hiérarchie",
  "Bagarre",
];

const LIB_PRESENCE = {
  present: "Présent",
  absent: "Absent",
  retardataire: "Retardataire",
  boycotteur: "Boycotteur",
};

const PHASES = {
  ouverture: "Appel d'ouverture",
  en_cours: "Réunion en cours",
  cloture: "Appel de clôture",
  cloturee: "Réunion clôturée",
};

// ---------- État ----------
const etat = {
  actif: false,
  unsubs: [],
  utilisateurs: [],
  caisses: [],
  membres: [],
  reunions: [],
  operations: [],
  propositions: [],
  vue: { type: "liste", caisseId: null, reunionId: null },
  occupe: false,
};

// ---------- Utilitaires ----------
function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function entier(v) { return Math.max(0, Math.round(Number(v) || 0)); }
function nouvelId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function aujourdhui() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function racine() { return document.getElementById("tab-tournantes"); }
function melanger(tab) {
  const a = [...tab];
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function libelleStatutCaisse(s) {
  return s === "inscriptions" ? "Inscriptions ouvertes" : s === "en_cours" ? "En cours" : "Clôturée";
}
function classeStatutCaisse(s) {
  return s === "inscriptions" ? "badge-suspendu" : s === "en_cours" ? "badge-actif" : "tt-badge-fin";
}

function dateDuTour(caisse, tour) {
  const d = new Date(`${caisse.date_limite_inscription}T00:00:00`);
  const n = tour - 1;
  switch (caisse.periodicite) {
    case "jour": d.setDate(d.getDate() + n); break;
    case "semaine": d.setDate(d.getDate() + 7 * n); break;
    case "mois": d.setMonth(d.getMonth() + n); break;
    case "trimestre": d.setMonth(d.getMonth() + 3 * n); break;
    case "semestre": d.setMonth(d.getMonth() + 6 * n); break;
    default: d.setFullYear(d.getFullYear() + n);
  }
  return d;
}

function inscriptionsOuvertes(caisse) {
  return caisse.statut === "inscriptions" &&
    new Date() <= new Date(`${caisse.date_limite_inscription}T23:59:59`);
}

// ---------- Sélecteurs ----------
const caisseCourante = () => etat.caisses.find((c) => c.id === etat.vue.caisseId);
const reunionCourante = () => etat.reunions.find((r) => r.id === etat.vue.reunionId);
const idReunion = (caisseId, tour) => `${caisseId}_t${tour}`;
const reunionDuTour = (caisseId, tour) => etat.reunions.find((r) => r.id === idReunion(caisseId, tour));

function membresDe(caisseId) {
  return etat.membres
    .filter((m) => m.caisse_id === caisseId)
    .sort((a, b) => ((a.rang ?? 9999) - (b.rang ?? 9999)) || ((a.ordre_inscription ?? 0) - (b.ordre_inscription ?? 0)));
}
function soldeSecurite(membreId) {
  return etat.operations
    .filter((o) => o.membre_id === membreId)
    .reduce((s, o) => s + Number(o.montant || 0), 0);
}
function totalArrieres(membre) {
  return (membre.arrieres || []).reduce((s, a) => s + Number(a.montant || 0), 0);
}

// ---------- Répartition 30 / 30 / 40 ----------
function calculerRepartition(total, nbMembres) {
  const collecteur = Math.floor((total * PCT_COLLECTEUR) / 100);
  const securiteTotal = Math.floor((total * PCT_SECURITE) / 100);
  const parMembre = nbMembres > 0 ? Math.floor(securiteTotal / nbMembres) : 0;
  const distribue = parMembre * nbMembres;
  const pdg = total - collecteur - distribue; // 30 % + reste d'arrondi
  return { total, collecteur, parMembre, distribue, pdg };
}

const refOp = () => doc(collection(db, "tournante_operations"));

function nouvelleOperation(caisse, membreId, type, montant, libelle, contexte = {}) {
  return {
    caisse_id: caisse.id,
    membre_id: membreId,
    type,
    montant,
    libelle,
    tour: contexte.tour ?? null,
    reunion_id: contexte.reunion_id ?? null,
    date: serverTimestamp(),
    auteur_id: auth.currentUser ? auth.currentUser.uid : null,
  };
}

function ajouterRepartition(batch, caisse, membres, rep, libelle, contexte, membreConcerne) {
  if (rep.pdg !== 0 || rep.collecteur !== 0) {
    batch.set(doc(collection(db, "frais_inscription")), {
      contract_id: null,
      membre_id: membreConcerne ?? null,
      collecteur_id: caisse.collecteur_id,
      montant_total: rep.total,
      montant_pdg: rep.pdg,
      montant_collecteur: rep.collecteur,
      date: serverTimestamp(),
      source: "tontine_tournante",
      caisse_id: caisse.id,
      libelle,
    });
  }
  if (rep.parMembre !== 0) {
    membres.forEach((m) => {
      batch.set(refOp(), nouvelleOperation(caisse, m.id, "part_securite", rep.parMembre, libelle, contexte));
    });
  }
}

async function executer(fn, messageSucces) {
  if (etat.occupe) return;
  etat.occupe = true;
  try {
    await fn();
    if (messageSucces) notifier(messageSucces, "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + (err.message || err), "erreur");
  } finally {
    etat.occupe = false;
  }
}

// ---------- Modal ----------
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
function confirmer(titre, texte, libelleBouton, onOk) {
  ouvrirModal(`
    <h2>${titre}</h2>
    <p class="subtitle-sm">${texte}</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="tt-annuler">Annuler</button>
      <button type="button" class="btn btn-primary" id="tt-ok">${libelleBouton}</button>
    </div>
  `);
  document.getElementById("tt-annuler").addEventListener("click", fermerModal);
  document.getElementById("tt-ok").addEventListener("click", async () => {
    fermerModal();
    await onOk();
  });
}

// ---------- Styles ----------
function injecterStyles() {
  if (document.getElementById("tt-styles")) return;
  const s = document.createElement("style");
  s.id = "tt-styles";
  s.textContent = `
    .tt-badge-fin { background: #e9ecef; color: #555; }
    .tt-neg { color: #c0392b; font-weight: bold; }
    .tt-ligne { background: #fff; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(12,23,41,0.05); }
    .tt-groupe { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .tt-btn { flex: 1; min-width: 80px; padding: 9px 6px; font-size: 13px; border-radius: 8px; border: 1.5px solid var(--gris-clair); background: #fff; color: var(--indigo-deep); cursor: pointer; font-weight: 600; font-family: inherit; }
    .tt-btn.oui { background: var(--emeraude); border-color: var(--emeraude); color: #fff; }
    .tt-btn.non { background: var(--terre-cuite); border-color: var(--terre-cuite); color: #fff; }
    .tt-btn.perm { background: var(--or); border-color: var(--or); color: var(--indigo-deep); }
    .tt-btn:disabled { opacity: 0.45; cursor: default; }
    .tt-etiquette { font-size: 11px; color: var(--gris); margin-top: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    .tt-chip { display: inline-block; background: #f4f6f8; border-radius: 14px; padding: 4px 10px; font-size: 12px; margin: 6px 6px 0 0; }
    .tt-chip button { background: none; border: none; color: #c0392b; font-weight: bold; cursor: pointer; margin-left: 4px; }
  `;
  document.head.appendChild(s);
}

// ---------- Rendu ----------
function render() {
  const el = racine();
  if (!el || !etat.actif) return;
  injecterStyles();
  const caisse = caisseCourante();
  if (etat.vue.type === "reunion" && caisse) {
    el.innerHTML = htmlReunion(caisse, reunionCourante());
  } else if (etat.vue.type === "caisse" && caisse) {
    el.innerHTML = htmlCaisse(caisse);
  } else {
    etat.vue = { type: "liste", caisseId: null, reunionId: null };
    el.innerHTML = htmlListe();
  }
}

function htmlListe() {
  const caisses = [...etat.caisses].sort((a, b) => (b.date_creation || "").localeCompare(a.date_creation || ""));
  const cartes = caisses.length === 0
    ? `<p class="empty-state">Aucune caisse tournante. Créez la première avec le bouton ci-dessus.</p>`
    : caisses.map((c) => {
        const nb = membresDe(c.id).length;
        return `
          <div class="entity-card" data-action="ouvrir-caisse" data-id="${c.id}">
            <div class="entity-card-top">
              <div>
                <p class="entity-nom">${esc(c.nom)}</p>
                <p class="entity-sub">${esc(PERIODICITES[c.periodicite] || "")} · cotisation ${formatGNF(c.montant_cotisation)} · ${nb} membre(s)</p>
                <p class="entity-sub">Collecteur : ${esc(c.collecteur_nom)}${c.statut === "en_cours" ? ` · tour ${c.tour_actuel}/${c.nb_tours}` : ""}</p>
              </div>
              <span class="badge ${classeStatutCaisse(c.statut)}">${libelleStatutCaisse(c.statut)}</span>
            </div>
          </div>`;
      }).join("");
  return `
    <div class="list-header">
      <h2>Caisses tournantes</h2>
      <button class="btn btn-secondary btn-sm" data-action="nouvelle-caisse">+ Nouvelle caisse</button>
    </div>
    <p class="subtitle-sm">Les membres cotisent à chaque période et la cagnotte revient à tour de rôle à l'un d'eux, jusqu'à ce que tous aient reçu la leur.</p>
    <div class="entity-list">${cartes}</div>`;
}

function ligneInfo(label, valeur) {
  return `<div class="detail-line"><span>${label}</span><span>${valeur}</span></div>`;
}

function htmlCaisse(c) {
  const membres = membresDe(c.id);
  const nb = membres.length;
  const nbTours = c.statut === "inscriptions" ? nb : c.nb_tours;
  const cagnotte = c.montant_cotisation * nbTours;
  const cautionSuggeree = Math.round((c.montant_cotisation * Math.max(nb, 1) * PCT_CAUTION_SUGGEREE) / 100);
  const b = c.bareme || {};
  const infractions = c.infractions || [];

  let actions = "";
  if (c.statut === "inscriptions") {
    actions = `
      <div class="actions-row">
        <button class="btn btn-secondary" data-action="ajouter-membre">+ Ajouter un membre</button>
        <button class="btn btn-primary" data-action="demarrer-tontine">Démarrer la tontine</button>
      </div>
      ${inscriptionsOuvertes(c) ? "" : `<p class="subtitle-sm" style="color:#c0392b;">La date limite des inscriptions est dépassée : plus d'ajout possible, vous pouvez démarrer la tontine.</p>`}`;
  } else if (c.statut === "en_cours") {
    const r = reunionDuTour(c.id, c.tour_actuel);
    actions = `
      <div class="actions-row">
        <button class="btn btn-primary" data-action="ouvrir-reunion">${r ? "Reprendre la feuille" : "Ouvrir la réunion"} du tour ${c.tour_actuel}</button>
      </div>
      <p class="subtitle-sm">Réunion prévue le ${formatDate(dateDuTour(c, c.tour_actuel))}.</p>`;
  }

  const reunionsCloses = etat.reunions
    .filter((r) => r.caisse_id === c.id && r.statut === "cloturee")
    .sort((a, b2) => b2.tour - a.tour);
  const historique = reunionsCloses.length === 0 ? "" : `
    <div class="zone-titre">Réunions clôturées</div>
    ${reunionsCloses.map((r) => `
      <div class="entity-card" data-action="voir-reunion" data-id="${r.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">Tour ${r.tour} — ${esc(r.beneficiaire_nom)}</p>
            <p class="entity-sub">Cagnotte ${formatGNF(r.pot)} · ${r.pot_verse ? "remise confirmée" : "<span class='tt-neg'>remise à confirmer</span>"}</p>
          </div>
          <span class="badge tt-badge-fin">Voir</span>
        </div>
      </div>`).join("")}`;

  const blocMembres = membres.length === 0
    ? `<p class="empty-state">Aucun membre inscrit.</p>`
    : membres.map((m) => {
        const solde = soldeSecurite(m.id);
        const arr = totalArrieres(m);
        return `
          <div class="entity-card" style="cursor:default;">
            <div class="entity-card-top">
              <div>
                <p class="entity-nom">${m.rang ? `<span class="type-badge">Tour ${m.rang}</span> ` : ""}${esc(m.nom)}</p>
                <p class="entity-sub">${esc(m.telephone)}${arr > 0 ? ` · <span class="tt-neg">Arriéré : ${formatGNF(arr)}</span>` : ""}</p>
              </div>
              <span class="badge ${solde < 0 ? "badge-licencie" : "badge-actif"}">${formatGNF(solde)}</span>
            </div>
            <p class="entity-sub" style="margin-top:6px;">Solde de sécurité${solde < 0 ? " — dette à régulariser" : ""}</p>
            <div class="entity-actions">
              ${c.statut !== "inscriptions" ? `<button class="btn btn-ghost-sm" data-action="reapprovisionner" data-mid="${m.id}">Réapprovisionner</button>` : ""}
              ${c.statut === "cloturee" && solde > 0 && !m.solde_retire ? `<button class="btn btn-primary btn-sm" data-action="retirer-solde" data-mid="${m.id}">Retirer le solde</button>` : ""}
              ${m.solde_retire ? `<span class="entity-sub">Solde retiré</span>` : ""}
            </div>
          </div>`;
      }).join("");

  return `
    <button class="btn btn-ghost-sm" data-action="retour-liste" style="margin-bottom:12px;">← Retour aux caisses</button>
    <div class="card" style="margin-bottom:14px;">
      <div class="entity-card-top">
        <h2 style="font-size:18px;">${esc(c.nom)}</h2>
        <span class="badge ${classeStatutCaisse(c.statut)}">${libelleStatutCaisse(c.statut)}</span>
      </div>
      ${c.statut === "en_cours" ? `<p class="subtitle-sm" style="margin-top:6px;">Tour ${c.tour_actuel} sur ${c.nb_tours}</p>` : ""}
      ${ligneInfo("Siège", esc(c.siege))}
      ${ligneInfo("Date de création", formatDate(c.date_creation))}
      ${ligneInfo("Périodicité", esc(PERIODICITES[c.periodicite] || ""))}
      ${ligneInfo("Montant de la cotisation", formatGNF(c.montant_cotisation))}
      ${ligneInfo(c.statut === "inscriptions" ? "Cagnotte actuelle (cotisation × membres)" : "Cagnotte par tour", formatGNF(cagnotte))}
      ${ligneInfo("Date limite des inscriptions", formatDate(c.date_limite_inscription))}
      ${ligneInfo("Collecteur", `${esc(c.collecteur_nom)} · ${esc(c.collecteur_telephone || "—")}`)}
      ${ligneInfo("Frais d'inscription", formatGNF(c.frais_inscription))}
      ${ligneInfo("Caution (solde de sécurité)", formatGNF(c.montant_caution))}
      ${c.statut === "inscriptions" ? `<p class="subtitle-sm" style="margin-top:6px;">Repère : ${PCT_CAUTION_SUGGEREE} % de la cagnotte actuelle = ${formatGNF(cautionSuggeree)}.</p>` : ""}
      ${ligneInfo("Pénalité de retard", formatGNF(b.retard))}
      ${ligneInfo("Pénalité d'absence", formatGNF(b.absence))}
      ${ligneInfo("Pénalité de boycott", formatGNF(b.boycott))}
      ${ligneInfo("Pénalité de cotisation impayée", formatGNF(b.cotisation_impayee))}
      <p class="subtitle-sm" style="margin-top:10px;">Infractions : ${infractions.length === 0 ? "aucune" : infractions.map((i) => `${esc(i.libelle)} (${formatGNF(i.montant)})`).join(" · ")}</p>
      <p class="subtitle-sm">Répartition des frais et pénalités : PDG 30 % · Collecteur 30 % · Solde de sécurité des membres 40 %.</p>
    </div>
    ${actions}
    ${historique}
    <div class="zone-titre">Membres (${nb})</div>
    <div class="entity-list">${blocMembres}</div>`;
}

function groupePresence(mid, champ, valeur, permission) {
  const dis = permission ? "disabled" : "";
  return `
    <div class="tt-groupe">
      <button class="tt-btn ${valeur === "present" ? "oui" : ""}" ${dis} data-action="presence" data-mid="${mid}" data-champ="${champ}" data-val="present">Présent</button>
      <button class="tt-btn ${valeur === "absent" ? "non" : ""}" ${dis} data-action="presence" data-mid="${mid}" data-champ="${champ}" data-val="absent">Absent</button>
    </div>`;
}

function htmlLigneMembre(c, r, m) {
  const l = (r.lignes || {})[m.id] || {};
  const arrieres = totalArrieres(m);
  const du = c.montant_cotisation + arrieres;
  const solde = soldeSecurite(m.id);
  const infr = (r.infractions || []).filter((i) => i.membre_id === m.id);
  const res = (r.resultats || {})[m.id];
  const termine = r.statut === "cloturee";
  const estBenef = r.beneficiaire_id === m.id;

  let corps = "";
  if (termine) {
    if (res) {
      const penalites = Number(res.penalite_appel || 0) + Number(res.penalite_cotisation || 0);
      corps = `<p class="entity-sub" style="margin-top:6px;">${LIB_PRESENCE[res.presence] || "—"} · ${res.cotise ? "Cotisé" : "Non cotisé"}${penalites > 0 ? ` · pénalités de clôture : ${formatGNF(penalites)}` : ""}</p>`;
    }
  } else {
    if (r.statut === "ouverture") {
      corps += `
        <p class="tt-etiquette">Appel d'ouverture</p>
        ${groupePresence(m.id, "debut", l.debut, l.permission)}
        <div class="tt-groupe">
          <button class="tt-btn ${l.permission ? "perm" : ""}" data-action="permission" data-mid="${m.id}">Permission accordée</button>
        </div>`;
    } else {
      corps += `<p class="entity-sub" style="margin-top:6px;">Ouverture : ${l.permission ? "Permission (compté présent)" : (LIB_PRESENCE[l.debut] || "—")}</p>`;
    }
    if (r.statut === "cloture") {
      corps += `
        <p class="tt-etiquette">Appel de clôture</p>
        ${groupePresence(m.id, "fin", l.fin, l.permission)}`;
    }
    if (r.statut !== "ouverture") {
      corps += `
        <p class="tt-etiquette">Cotisation</p>
        <div class="tt-groupe">
          <button class="tt-btn ${l.cotise === true ? "oui" : ""}" data-action="cotise" data-mid="${m.id}" data-val="oui">Cotisé</button>
          <button class="tt-btn ${l.cotise === false ? "non" : ""}" data-action="cotise" data-mid="${m.id}" data-val="non">Non cotisé</button>
        </div>
        <div class="tt-groupe">
          <button class="tt-btn" data-action="infraction" data-mid="${m.id}">+ Ajouter infraction</button>
        </div>`;
    }
  }

  const chips = infr.map((i) => `
    <span class="tt-chip">${esc(i.libelle)} — ${formatGNF(i.montant)}${i.annulee ? " (annulée)" : ""}
      ${!i.annulee && !termine ? `<button type="button" data-action="annuler-infraction" data-iid="${i.id}">✕</button>` : ""}
    </span>`).join("");

  return `
    <div class="tt-ligne">
      <div class="entity-card-top">
        <div>
          <p class="entity-nom">${esc(m.nom)}${estBenef ? ` <span class="type-badge">Bénéficiaire</span>` : ""}</p>
          <p class="entity-sub">${esc(m.telephone)} · Solde de sécurité : <span class="${solde < 0 ? "tt-neg" : ""}">${formatGNF(solde)}</span></p>
          <p class="entity-sub">À cotiser : <b>${formatGNF(du)}</b>${arrieres > 0 ? ` <span class="tt-neg">(dont arriéré ${formatGNF(arrieres)})</span>` : ""}</p>
        </div>
      </div>
      ${corps}
      ${chips}
    </div>`;
}

function htmlReunion(c, r) {
  const retour = `<button class="btn btn-ghost-sm" data-action="retour-caisse" style="margin-bottom:12px;">← Retour à la caisse</button>`;
  if (!r) return `${retour}<p class="empty-state">Chargement de la feuille…</p>`;

  const membres = membresDe(c.id);
  const nbCotises = Object.values(r.lignes || {}).filter((l) => l.cotise === true).length;
  let boutonPhase = "";
  if (r.statut === "ouverture") boutonPhase = `<button class="btn btn-primary" data-action="valider-ouverture">Valider l'appel d'ouverture</button>`;
  else if (r.statut === "en_cours") boutonPhase = `<button class="btn btn-primary" data-action="passer-cloture">Passer à l'appel de clôture</button>`;
  else if (r.statut === "cloture") boutonPhase = `<button class="btn btn-primary" data-action="cloturer-reunion">Clôturer la réunion et facturer</button>`;

  let bilanFinal = "";
  if (r.statut === "cloturee") {
    const ratt = r.rattrapages || [];
    bilanFinal = `
      <div class="card" style="margin-bottom:14px;">
        <h3 style="font-size:15px;">Cagnotte du tour ${r.tour}</h3>
        ${ligneInfo("Bénéficiaire", esc(r.beneficiaire_nom))}
        ${ligneInfo("Cagnotte collectée", formatGNF(r.pot))}
        ${r.pot_verse
          ? `<p class="subtitle-sm" style="margin-top:8px;">✓ Remise confirmée le ${formatDate(r.date_pot)}.</p>`
          : `<button class="btn btn-primary" data-action="remise-pot" style="margin-top:10px;">Confirmer la remise de la cagnotte</button>`}
        ${ratt.length > 0 ? `
          <h3 style="font-size:14px; margin-top:16px;">Rattrapages à remettre</h3>
          ${ratt.map((x) => ligneInfo(`${esc(x.membre_nom)} → ${esc(x.beneficiaire_nom)} (tour ${x.tour_origine})`, formatGNF(x.montant))).join("")}
          ${r.rattrapages_remis
            ? `<p class="subtitle-sm" style="margin-top:8px;">✓ Rattrapages remis.</p>`
            : `<button class="btn btn-secondary" data-action="remise-rattrapages" style="margin-top:10px;">Confirmer la remise des rattrapages</button>`}` : ""}
      </div>`;
  }

  return `
    ${retour}
    <div class="card" style="margin-bottom:14px;">
      <div class="entity-card-top">
        <h2 style="font-size:17px;">${esc(c.nom)} — Tour ${r.tour}/${c.nb_tours}</h2>
        <span class="badge badge-suspendu">${PHASES[r.statut] || ""}</span>
      </div>
      ${ligneInfo("Bénéficiaire du tour", esc(r.beneficiaire_nom))}
      ${ligneInfo("Cagnotte attendue", formatGNF(c.montant_cotisation * membres.length))}
      ${r.statut !== "cloturee" ? ligneInfo("Déjà cotisé", `${nbCotises} / ${membres.length}`) : ""}
      <div class="actions-row" style="margin-top:12px;">${boutonPhase}</div>
    </div>
    ${bilanFinal}
    ${membres.map((m) => htmlLigneMembre(c, r, m)).join("")}`;
}

// ---------- Création d'une caisse ----------
function ligneInfractionHtml(libelle = "", montant = "") {
  return `
    <div class="tt-infr-row" style="display:flex; gap:6px; margin-bottom:6px;">
      <input type="text" class="tt-infr-libelle" placeholder="Infraction" value="${esc(libelle)}" style="flex:2; min-width:0;" />
      <input type="number" class="tt-infr-montant" placeholder="GNF" min="0" value="${esc(montant)}" style="flex:1; min-width:0;" />
      <button type="button" class="btn btn-ghost-sm tt-infr-suppr">✕</button>
    </div>`;
}

function ouvrirNouvelleCaisse() {
  const collecteurs = etat.utilisateurs.filter((u) => u.role === "collecteur" && u.statut === "actif");
  if (collecteurs.length === 0) {
    notifier("Créez d'abord un collecteur actif.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Nouvelle caisse tournante</h2>
    <form id="form-caisse-tournante">
      <div class="field-row"><label>Nom de la caisse</label><input type="text" name="nom" required /></div>
      <div class="field-row"><label>Siège</label><input type="text" name="siege" required /></div>
      <div class="field-row"><label>Date de création</label><input type="date" name="date_creation" value="${aujourdhui()}" required /></div>
      <div class="field-row">
        <label>Périodicité des cotisations</label>
        <select name="periodicite" required>
          ${Object.entries(PERIODICITES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
      </div>
      <div class="field-row"><label>Date limite des inscriptions</label><input type="date" name="date_limite_inscription" required /></div>
      <div class="field-row"><label>Montant de la cotisation (GNF)</label><input type="number" name="montant_cotisation" min="1" required /></div>
      <div class="field-row">
        <label>Collecteur</label>
        <select name="collecteur_id" required>
          ${collecteurs.map((c) => `<option value="${c.uid}">${esc(c.nom)} — ${esc(c.telephone || "")}</option>`).join("")}
        </select>
      </div>
      <div class="field-row"><label>Frais d'inscription (GNF)</label><input type="number" name="frais_inscription" min="0" value="0" required /></div>
      <div class="field-row">
        <label>Caution / solde de sécurité initial (GNF)</label>
        <input type="number" name="montant_caution" min="0" value="0" required />
        <span class="subtitle-sm">Repère : environ ${PCT_CAUTION_SUGGEREE} % de la cagnotte (cotisation × nombre de membres). Les frais d'inscription sont prélevés sur cette caution.</span>
      </div>
      <h3 style="font-size:14px; margin-top:6px;">Barème des pénalités (GNF)</h3>
      <div class="field-row"><label>Retard</label><input type="number" name="p_retard" min="0" value="0" required /></div>
      <div class="field-row"><label>Absence</label><input type="number" name="p_absence" min="0" value="0" required /></div>
      <div class="field-row"><label>Boycott (présent à l'ouverture, absent à la clôture)</label><input type="number" name="p_boycott" min="0" value="0" required /></div>
      <div class="field-row"><label>Cotisation impayée</label><input type="number" name="p_cotisation" min="0" value="0" required /></div>
      <h3 style="font-size:14px; margin-top:6px;">Infractions pendant la réunion</h3>
      <div id="liste-infractions-form">
        ${INFRACTIONS_PAR_DEFAUT.map((l) => ligneInfractionHtml(l, "")).join("")}
      </div>
      <button type="button" class="btn btn-ghost-sm" id="btn-add-infraction" style="width:auto;">+ Ajouter une infraction</button>
      <p class="subtitle-sm" style="margin-top:8px;">Les frais d'inscription et chaque pénalité sont répartis ainsi : 30 % PDG, 30 % collecteur, 40 % sur le solde de sécurité des membres.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler">Annuler</button>
        <button type="submit" class="btn btn-primary">Créer la caisse</button>
      </div>
    </form>
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("btn-add-infraction").addEventListener("click", () => {
    document.getElementById("liste-infractions-form").insertAdjacentHTML("beforeend", ligneInfractionHtml());
  });
  document.getElementById("liste-infractions-form").addEventListener("click", (e) => {
    const b = e.target.closest(".tt-infr-suppr");
    if (b) b.closest(".tt-infr-row").remove();
  });

  document.getElementById("form-caisse-tournante").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const collecteur = collecteurs.find((c) => c.uid === fd.get("collecteur_id"));
    const montantCotisation = entier(fd.get("montant_cotisation"));
    const frais = entier(fd.get("frais_inscription"));
    const caution = entier(fd.get("montant_caution"));
    const dateCreation = fd.get("date_creation");
    const limite = fd.get("date_limite_inscription");

    if (!collecteur) { notifier("Choisissez un collecteur.", "erreur"); return; }
    if (montantCotisation <= 0) { notifier("Le montant de la cotisation doit être positif.", "erreur"); return; }
    if (frais > caution) { notifier("Les frais d'inscription ne peuvent pas dépasser la caution.", "erreur"); return; }
    if (limite < dateCreation) { notifier("La date limite des inscriptions doit suivre la date de création.", "erreur"); return; }

    const infractions = Array.from(document.querySelectorAll("#liste-infractions-form .tt-infr-row"))
      .map((row) => ({
        id: nouvelId(),
        libelle: row.querySelector(".tt-infr-libelle").value.trim(),
        montant: entier(row.querySelector(".tt-infr-montant").value),
      }))
      .filter((i) => i.libelle);

    executer(async () => {
      await setDoc(doc(collection(db, "caisses_tournantes")), {
        nom: String(fd.get("nom")).trim(),
        siege: String(fd.get("siege")).trim(),
        date_creation: dateCreation,
        periodicite: fd.get("periodicite"),
        date_limite_inscription: limite,
        montant_cotisation: montantCotisation,
        collecteur_id: collecteur.uid,
        collecteur_nom: collecteur.nom,
        collecteur_telephone: collecteur.telephone || "",
        frais_inscription: frais,
        montant_caution: caution,
        bareme: {
          retard: entier(fd.get("p_retard")),
          absence: entier(fd.get("p_absence")),
          boycott: entier(fd.get("p_boycott")),
          cotisation_impayee: entier(fd.get("p_cotisation")),
        },
        infractions,
        repartition: { pdg: 30, collecteur: 30, securite: 40 },
        statut: "inscriptions",
        tour_actuel: 0,
        nb_tours: 0,
        pdg_id: auth.currentUser ? auth.currentUser.uid : null,
        date_enregistrement: serverTimestamp(),
      });
      fermerModal();
    }, "Caisse créée.");
  });
}

// ---------- Membres ----------
function afficherIdentifiants(nom, telephone, motDePasse) {
  ouvrirModal(`
    <h2>Identifiants du membre</h2>
    <p class="subtitle-sm">À transmettre oralement à ${esc(nom)}</p>
    <div class="detail-line"><span>Téléphone</span><span><b>${esc(telephone)}</b></span></div>
    <div class="detail-line"><span>Mot de passe</span><span><b>${esc(motDePasse)}</b></span></div>
    <p class="subtitle-sm" style="color:#c0392b; margin-top:8px;">Ce mot de passe ne sera plus affiché : transmettez-le maintenant.</p>
    <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-id" style="flex:1;">J'ai transmis les identifiants</button></div>
  `);
  document.getElementById("modal-fermer-id").addEventListener("click", fermerModal);
}

function ouvrirAjoutMembre(caisse) {
  if (!inscriptionsOuvertes(caisse)) {
    notifier("Les inscriptions sont closes pour cette caisse.", "erreur");
    return;
  }
  const dejaInscrits = new Set(membresDe(caisse.id).map((m) => m.membre_uid).filter(Boolean));
  const candidats = etat.utilisateurs
    .filter((u) => u.role === "membre" && u.statut !== "supprime" && !dejaInscrits.has(u.uid))
    .sort((a, b) => String(a.nom || "").localeCompare(String(b.nom || ""), "fr"));

  ouvrirModal(`
    <h2>Ajouter un membre</h2>
    <p class="subtitle-sm">Caution à verser : <b>${formatGNF(caisse.montant_caution)}</b>, dont <b>${formatGNF(caisse.frais_inscription)}</b> de frais d'inscription prélevés sur cette caution (enregistrés automatiquement).</p>
    <form id="form-ajout-membre-tt">
      <label style="flex-direction:row; align-items:center; gap:8px;"><input type="radio" name="mode" value="existant" checked /> Membre TINA existant</label>
      <label style="flex-direction:row; align-items:center; gap:8px;"><input type="radio" name="mode" value="nouveau" /> Nouveau membre (création du compte)</label>
      <div id="bloc-existant" class="field-row" style="margin-top:8px;">
        <label>Membre</label>
        <select name="membre_uid">
          ${candidats.length === 0
            ? `<option value="">Aucun membre disponible</option>`
            : candidats.map((u) => `<option value="${u.uid}">${esc(u.nom)} — ${esc(u.telephone || "")}</option>`).join("")}
        </select>
      </div>
      <div id="bloc-nouveau" class="hidden" style="margin-top:8px;">
        <div class="field-row"><label>Nom complet</label><input type="text" name="nom" /></div>
        <div class="field-row"><label>Téléphone (identifiant de connexion)</label><input type="tel" name="telephone" /></div>
        <div class="field-row"><label>E-mail</label><input type="email" name="email" /></div>
        <div class="field-row"><label>Résidence</label><input type="text" name="residence" /></div>
        <p class="subtitle-sm">Le compte est créé automatiquement (mot de passe : 6 derniers chiffres du téléphone) et rattaché au collecteur de la caisse.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler">Annuler</button>
        <button type="submit" class="btn btn-primary">Inscrire</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.querySelectorAll("#form-ajout-membre-tt input[name='mode']").forEach((r) => {
    r.addEventListener("change", () => {
      const nouveau = document.querySelector("#form-ajout-membre-tt input[name='mode']:checked").value === "nouveau";
      document.getElementById("bloc-nouveau").classList.toggle("hidden", !nouveau);
      document.getElementById("bloc-existant").classList.toggle("hidden", nouveau);
    });
  });

  document.getElementById("form-ajout-membre-tt").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const mode = fd.get("mode");
    executer(async () => {
      let uid;
      let nom;
      let telephone;
      let identifiants = null;

      if (mode === "existant") {
        const u = candidats.find((x) => x.uid === fd.get("membre_uid"));
        if (!u) throw new Error("Choisissez un membre.");
        uid = u.uid;
        nom = u.nom;
        telephone = u.telephone || "";
      } else {
        nom = String(fd.get("nom") || "").trim();
        telephone = String(fd.get("telephone") || "").trim();
        const email = String(fd.get("email") || "").trim();
        const residence = String(fd.get("residence") || "").trim();
        if (!nom || !telephone || !email || !residence) throw new Error("Tous les champs du nouveau membre sont obligatoires.");
        const chiffres = telephone.replace(/\D/g, "");
        if (chiffres.length < 6) throw new Error("Numéro de téléphone invalide.");
        const motDePasse = chiffres.slice(-6);
        uid = await creerCompteSecondaire(`${chiffres}@membre.cpct-tina.local`, motDePasse);
        await setDoc(doc(db, "users", uid), {
          role: "membre",
          nom, telephone, email, residence,
          parrain_id: caisse.collecteur_id,
          statut: "actif",
          date_creation: serverTimestamp(),
        });
        identifiants = { telephone, motDePasse };
      }

      await adhererCaisse({ caisse, membreUid: uid, membreNom: nom, membreTelephone: telephone });
      fermerModal();
      if (identifiants) afficherIdentifiants(nom, identifiants.telephone, identifiants.motDePasse);
    }, mode === "existant" ? "Membre inscrit." : null);
  });
}

function ouvrirDemarrage(caisse) {
  const membres = membresDe(caisse.id);
  if (membres.length < 2) {
    notifier("Il faut au moins 2 membres pour démarrer la tontine.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Démarrer la tontine</h2>
    <p class="subtitle-sm">${membres.length} membres, donc ${membres.length} tours. Après le démarrage, plus aucune inscription n'est possible et l'ordre des tours est définitif.</p>
    <form id="form-demarrage-tt">
      <label style="flex-direction:row; align-items:center; gap:8px;"><input type="radio" name="mode" value="inscription" checked /> Ordre d'inscription</label>
      <label style="flex-direction:row; align-items:center; gap:8px;"><input type="radio" name="mode" value="tirage" /> Tirage au sort</label>
      <label style="flex-direction:row; align-items:center; gap:8px;"><input type="radio" name="mode" value="manuel" /> Ordre choisi manuellement</label>
      <div id="bloc-ordre-manuel" class="hidden" style="margin-top:8px;">
        ${membres.map((m, i) => `
          <div class="field-row">
            <label>${esc(m.nom)}</label>
            <input type="number" class="tt-rang" data-mid="${m.id}" min="1" max="${membres.length}" value="${i + 1}" />
          </div>`).join("")}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler">Annuler</button>
        <button type="submit" class="btn btn-primary">Démarrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.querySelectorAll("#form-demarrage-tt input[name='mode']").forEach((r) => {
    r.addEventListener("change", () => {
      const manuel = document.querySelector("#form-demarrage-tt input[name='mode']:checked").value === "manuel";
      document.getElementById("bloc-ordre-manuel").classList.toggle("hidden", !manuel);
    });
  });
  document.getElementById("form-demarrage-tt").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = document.querySelector("#form-demarrage-tt input[name='mode']:checked").value;
    let ordre;
    if (mode === "inscription") {
      ordre = membres.map((m) => m.id);
    } else if (mode === "tirage") {
      ordre = melanger(membres.map((m) => m.id));
    } else {
      const saisies = Array.from(document.querySelectorAll(".tt-rang")).map((i) => ({ mid: i.dataset.mid, rang: Number(i.value) }));
      const rangs = saisies.map((s) => s.rang).sort((a, b) => a - b);
      const valide = rangs.every((r, i) => r === i + 1);
      if (!valide) {
        notifier(`Les rangs doivent être tous différents, de 1 à ${membres.length}.`, "erreur");
        return;
      }
      ordre = saisies.sort((a, b) => a.rang - b.rang).map((s) => s.mid);
    }
    executer(async () => {
      const premier = membres.find((m) => m.id === ordre[0]);
      const batch = writeBatch(db);
      ordre.forEach((mid, i) => batch.update(doc(db, "tournante_membres", mid), { rang: i + 1 }));
      batch.update(doc(db, "caisses_tournantes", caisse.id), {
        statut: "en_cours",
        nb_tours: ordre.length,
        tour_actuel: 1,
        mode_ordre: mode,
        beneficiaire_nom: premier ? premier.nom : "",
        date_demarrage: serverTimestamp(),
      });
      await batch.commit();
      fermerModal();
    }, "Tontine démarrée.");
  });
}

function ouvrirReapprovisionnement(caisse, mid) {
  const membre = etat.membres.find((m) => m.id === mid);
  if (!membre) return;
  ouvrirModal(`
    <h2>Réapprovisionner — ${esc(membre.nom)}</h2>
    <p class="subtitle-sm">Solde de sécurité actuel : <b>${formatGNF(soldeSecurite(mid))}</b></p>
    <form id="form-reappro-tt">
      <div class="field-row"><label>Montant versé (GNF)</label><input type="number" name="montant" min="1" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-reappro-tt").addEventListener("submit", (e) => {
    e.preventDefault();
    const montant = entier(new FormData(e.target).get("montant"));
    if (montant <= 0) { notifier("Montant invalide.", "erreur"); return; }
    executer(async () => {
      const batch = writeBatch(db);
      batch.set(refOp(), nouvelleOperation(caisse, mid, "reapprovisionnement", montant, "Versement sur le solde de sécurité"));
      await batch.commit();
      fermerModal();
    }, "Solde réapprovisionné.");
  });
}

function ouvrirRetraitSolde(caisse, mid) {
  const membre = etat.membres.find((m) => m.id === mid);
  if (!membre) return;
  const solde = soldeSecurite(mid);
  if (solde <= 0) { notifier("Aucun solde à retirer.", "erreur"); return; }
  confirmer(
    `Retirer le solde — ${esc(membre.nom)}`,
    `Le membre récupère son solde de sécurité restant : <b>${formatGNF(solde)}</b>.`,
    "Confirmer le retrait",
    () => executer(async () => {
      const batch = writeBatch(db);
      batch.set(refOp(), nouvelleOperation(caisse, mid, "retrait_solde", -solde, "Retrait du solde de sécurité à la clôture"));
      batch.update(doc(db, "tournante_membres", mid), { solde_retire: true });
      await batch.commit();
    }, "Retrait enregistré.")
  );
}

// ---------- Réunion ----------
async function ouvrirReunion(caisse) {
  const tour = caisse.tour_actuel;
  const membres = membresDe(caisse.id);
  const benef = membres.find((m) => m.rang === tour);
  if (!benef) throw new Error("Bénéficiaire du tour introuvable.");
  const lignes = {};
  membres.forEach((m) => {
    lignes[m.id] = { nom: m.nom, permission: false, debut: null, fin: null, cotise: null };
  });
  await setDoc(doc(db, "tournante_reunions", idReunion(caisse.id, tour)), {
    caisse_id: caisse.id,
    tour,
    statut: "ouverture",
    date_reunion: serverTimestamp(),
    beneficiaire_id: benef.id,
    beneficiaire_nom: benef.nom,
    lignes,
    infractions: [],
    rattrapages: [],
    pot: 0,
    pot_verse: false,
    rattrapages_remis: false,
  });
}

function ouvrirChoixInfraction(caisse, reunion, mid) {
  const membre = etat.membres.find((m) => m.id === mid);
  const liste = (caisse.infractions || []).filter((i) => i.montant > 0);
  if (!membre) return;
  if (liste.length === 0) {
    notifier("Aucune infraction avec un montant n'est définie pour cette caisse.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Infraction — ${esc(membre.nom)}</h2>
    <p class="subtitle-sm">Touchez l'infraction commise : le membre est facturé aussitôt sur son solde de sécurité.</p>
    <div style="display:flex; flex-direction:column; gap:8px;">
      ${liste.map((i) => `<button type="button" class="btn btn-secondary" data-inf="${i.id}">${esc(i.libelle)} — ${formatGNF(i.montant)}</button>`).join("")}
    </div>
    <div class="modal-actions"><button type="button" class="btn btn-ghost-sm" id="modal-annuler">Fermer</button></div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.querySelectorAll("[data-inf]").forEach((b) => {
    b.addEventListener("click", () => {
      const infr = liste.find((i) => i.id === b.dataset.inf);
      fermerModal();
      executer(() => facturerInfraction(caisse.id, reunion.id, mid, infr), "Infraction facturée.");
    });
  });
}

async function facturerInfraction(caisseId, reunionId, mid, infr) {
  const caisse = etat.caisses.find((c) => c.id === caisseId);
  const reunion = etat.reunions.find((r) => r.id === reunionId);
  const membres = membresDe(caisseId);
  const membre = membres.find((m) => m.id === mid);
  if (!caisse || !reunion || !membre) throw new Error("Données introuvables.");
  if (reunion.statut === "cloturee") throw new Error("La réunion est déjà clôturée.");
  const montant = entier(infr.montant);
  if (montant <= 0) throw new Error("Montant d'infraction invalide.");

  const rep = calculerRepartition(montant, membres.length);
  const contexte = { tour: reunion.tour, reunion_id: reunion.id };
  const batch = writeBatch(db);
  batch.set(refOp(), nouvelleOperation(caisse, mid, "penalite", -montant, `${infr.libelle} (tour ${reunion.tour})`, contexte));
  ajouterRepartition(batch, caisse, membres, rep, `Part 40 % — ${infr.libelle} (tour ${reunion.tour})`, contexte, mid);
  const entree = {
    id: nouvelId(),
    membre_id: mid,
    membre_nom: membre.nom,
    libelle: infr.libelle,
    montant,
    rep,
    annulee: false,
    date_iso: new Date().toISOString(),
  };
  batch.update(doc(db, "tournante_reunions", reunion.id), { infractions: [...(reunion.infractions || []), entree] });
  await batch.commit();
}

async function annulerInfraction(caisseId, reunionId, iid) {
  const caisse = etat.caisses.find((c) => c.id === caisseId);
  const reunion = etat.reunions.find((r) => r.id === reunionId);
  if (!caisse || !reunion) throw new Error("Données introuvables.");
  if (reunion.statut === "cloturee") throw new Error("La réunion est clôturée.");
  const entree = (reunion.infractions || []).find((i) => i.id === iid);
  if (!entree || entree.annulee) return;
  const membres = membresDe(caisseId);
  const contexte = { tour: reunion.tour, reunion_id: reunion.id };
  const rep = entree.rep;
  const inverse = {
    total: -rep.total,
    pdg: -rep.pdg,
    collecteur: -rep.collecteur,
    parMembre: -rep.parMembre,
  };
  const batch = writeBatch(db);
  batch.set(refOp(), nouvelleOperation(caisse, entree.membre_id, "annulation_penalite", entree.montant, `Annulation : ${entree.libelle} (tour ${reunion.tour})`, contexte));
  ajouterRepartition(batch, caisse, membres, inverse, `Annulation part 40 % — ${entree.libelle} (tour ${reunion.tour})`, contexte, entree.membre_id);
  batch.update(doc(db, "tournante_reunions", reunion.id), {
    infractions: (reunion.infractions || []).map((i) => (i.id === iid ? { ...i, annulee: true } : i)),
  });
  await batch.commit();
}

function calculerBilan(caisse, reunion) {
  const membres = membresDe(caisse.id);
  const bareme = caisse.bareme || {};
  const erreurs = [];
  const resultats = {};
  const penalites = [];
  const arrieresMaj = {};
  const rattrapages = [];
  let cotises = 0;

  membres.forEach((m) => {
    const l = (reunion.lignes || {})[m.id] || {};
    const debut = l.permission ? "present" : l.debut;
    const fin = l.permission ? "present" : l.fin;
    if (!debut || !fin) { erreurs.push(`${m.nom} : appel d'ouverture ou de clôture manquant`); return; }
    if (l.cotise !== true && l.cotise !== false) { erreurs.push(`${m.nom} : cotisation non renseignée`); return; }

    let presence = "present";
    if (debut === "absent" && fin === "present") presence = "retardataire";
    else if (debut === "absent" && fin === "absent") presence = "absent";
    else if (debut === "present" && fin === "absent") presence = "boycotteur";

    const montantPresence = entier(
      presence === "retardataire" ? bareme.retard
        : presence === "absent" ? bareme.absence
        : presence === "boycotteur" ? bareme.boycott : 0
    );
    if (montantPresence > 0) {
      penalites.push({
        mid: m.id, nom: m.nom, montant: montantPresence,
        libelle: `${{ retardataire: "Retard", absent: "Absence", boycotteur: "Boycott" }[presence]} — tour ${reunion.tour}`,
      });
    }

    let penaliteCotisation = 0;
    if (l.cotise === true) {
      cotises++;
      if ((m.arrieres || []).length > 0) {
        arrieresMaj[m.id] = [];
        m.arrieres.forEach((a) => {
          const benef = membres.find((x) => x.rang === a.tour);
          rattrapages.push({
            membre_id: m.id,
            membre_nom: m.nom,
            tour_origine: a.tour,
            beneficiaire_id: benef ? benef.id : null,
            beneficiaire_nom: benef ? benef.nom : "—",
            montant: Number(a.montant || 0),
          });
        });
      }
    } else {
      arrieresMaj[m.id] = [...(m.arrieres || []), { tour: reunion.tour, montant: caisse.montant_cotisation }];
      penaliteCotisation = entier(bareme.cotisation_impayee);
      if (penaliteCotisation > 0) {
        penalites.push({ mid: m.id, nom: m.nom, montant: penaliteCotisation, libelle: `Cotisation impayée — tour ${reunion.tour}` });
      }
    }

    resultats[m.id] = {
      nom: m.nom,
      presence,
      cotise: l.cotise,
      penalite_appel: montantPresence,
      penalite_cotisation: penaliteCotisation,
    };
  });

  const total = penalites.reduce((s, p) => s + p.montant, 0);
  return { erreurs, resultats, penalites, total, arrieresMaj, rattrapages, cotises, pot: cotises * caisse.montant_cotisation };
}

function ouvrirApercuCloture(caisse, reunion) {
  const bilan = calculerBilan(caisse, reunion);
  if (bilan.erreurs.length > 0) {
    ouvrirModal(`
      <h2>Feuille incomplète</h2>
      <p class="subtitle-sm">Complétez d'abord :</p>
      <ul style="font-size:13px; padding-left:18px; margin-bottom:10px;">${bilan.erreurs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <div class="modal-actions"><button type="button" class="btn btn-primary" id="modal-annuler">Compris</button></div>
    `);
    document.getElementById("modal-annuler").addEventListener("click", fermerModal);
    return;
  }
  ouvrirModal(`
    <h2>Clôturer le tour ${reunion.tour}</h2>
    ${ligneInfo("Cagnotte collectée", formatGNF(bilan.pot))}
    ${ligneInfo("Bénéficiaire", esc(reunion.beneficiaire_nom))}
    ${bilan.rattrapages.length > 0 ? ligneInfo("Rattrapages payés", formatGNF(bilan.rattrapages.reduce((s, x) => s + x.montant, 0))) : ""}
    <h3 style="font-size:14px; margin-top:14px;">Pénalités qui vont être facturées</h3>
    ${bilan.penalites.length === 0
      ? `<p class="subtitle-sm">Aucune pénalité de clôture.</p>`
      : bilan.penalites.map((p) => ligneInfo(`${esc(p.nom)} — ${esc(p.libelle)}`, formatGNF(p.montant))).join("")}
    ${ligneInfo("Total des pénalités", formatGNF(bilan.total))}
    <p class="subtitle-sm" style="margin-top:8px;">Chaque non-cotisant devra doubler à la prochaine échéance. Cette clôture est définitive.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler">Annuler</button>
      <button type="button" class="btn btn-primary" id="tt-confirmer-cloture">Confirmer et facturer</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("tt-confirmer-cloture").addEventListener("click", () => {
    fermerModal();
    executer(() => cloturerReunion(caisse.id, reunion.id), "Réunion clôturée.");
  });
}

async function cloturerReunion(caisseId, reunionId) {
  const caisse = etat.caisses.find((c) => c.id === caisseId);
  const reunion = etat.reunions.find((r) => r.id === reunionId);
  if (!caisse || !reunion) throw new Error("Données introuvables.");
  if (reunion.statut !== "cloture") throw new Error("La réunion n'est pas à l'étape de clôture.");

  const membres = membresDe(caisseId);
  const bilan = calculerBilan(caisse, reunion);
  if (bilan.erreurs.length > 0) throw new Error(bilan.erreurs[0]);

  const nbEcritures = bilan.penalites.length + membres.length + Object.keys(bilan.arrieresMaj).length + 4;
  if (nbEcritures > 450) throw new Error("Trop de membres pour clôturer en une seule opération.");

  const contexte = { tour: reunion.tour, reunion_id: reunion.id };
  const batch = writeBatch(db);

  bilan.penalites.forEach((p) => {
    batch.set(refOp(), nouvelleOperation(caisse, p.mid, "penalite", -p.montant, p.libelle, contexte));
  });
  if (bilan.total > 0) {
    const rep = calculerRepartition(bilan.total, membres.length);
    ajouterRepartition(batch, caisse, membres, rep, `Part 40 % — pénalités de clôture (tour ${reunion.tour})`, contexte, null);
  }
  Object.entries(bilan.arrieresMaj).forEach(([mid, arr]) => {
    batch.update(doc(db, "tournante_membres", mid), { arrieres: arr });
  });
  batch.update(doc(db, "tournante_reunions", reunion.id), {
    statut: "cloturee",
    resultats: bilan.resultats,
    pot: bilan.pot,
    rattrapages: bilan.rattrapages,
    date_cloture: serverTimestamp(),
  });
  const dernier = reunion.tour >= caisse.nb_tours;
  const suivant = membres.find((m) => m.rang === reunion.tour + 1);
  batch.update(
    doc(db, "caisses_tournantes", caisse.id),
    dernier
      ? { statut: "cloturee", date_cloture: serverTimestamp() }
      : { tour_actuel: reunion.tour + 1, beneficiaire_nom: suivant ? suivant.nom : "" }
  );
  await batch.commit();
  etat.vue = { type: "caisse", caisseId: caisse.id, reunionId: null };
  render();
}

// ---------- Clics ----------
async function surClic(e) {
  const el = e.target.closest("[data-action]");
  const zone = racine();
  if (!el || !zone || !zone.contains(el)) return;
  const action = el.dataset.action;
  const caisse = caisseCourante();
  const reunion = reunionCourante();
  const mid = el.dataset.mid;

  switch (action) {
    case "nouvelle-caisse": ouvrirNouvelleCaisse(); break;
    case "ouvrir-caisse":
      etat.vue = { type: "caisse", caisseId: el.dataset.id, reunionId: null };
      render();
      break;
    case "retour-liste":
      etat.vue = { type: "liste", caisseId: null, reunionId: null };
      render();
      break;
    case "retour-caisse":
      etat.vue = { type: "caisse", caisseId: etat.vue.caisseId, reunionId: null };
      render();
      break;
    case "ajouter-membre": if (caisse) ouvrirAjoutMembre(caisse); break;
    case "demarrer-tontine": if (caisse) ouvrirDemarrage(caisse); break;
    case "reapprovisionner": if (caisse) ouvrirReapprovisionnement(caisse, mid); break;
    case "retirer-solde": if (caisse) ouvrirRetraitSolde(caisse, mid); break;
    case "voir-reunion":
      etat.vue = { type: "reunion", caisseId: etat.vue.caisseId, reunionId: el.dataset.id };
      render();
      break;
    case "ouvrir-reunion":
      if (!caisse) break;
      await executer(async () => {
        if (!reunionDuTour(caisse.id, caisse.tour_actuel)) await ouvrirReunion(caisse);
        etat.vue = { type: "reunion", caisseId: caisse.id, reunionId: idReunion(caisse.id, caisse.tour_actuel) };
        render();
      });
      break;
    case "presence": {
      if (!reunion) break;
      const champ = el.dataset.champ;
      if ((champ === "debut" && reunion.statut !== "ouverture") || (champ === "fin" && reunion.statut !== "cloture")) break;
      const actuel = ((reunion.lignes || {})[mid] || {})[champ];
      const nouveau = actuel === el.dataset.val ? null : el.dataset.val;
      updateDoc(doc(db, "tournante_reunions", reunion.id), { [`lignes.${mid}.${champ}`]: nouveau }).catch((err) => notifier("Erreur : " + err.message, "erreur"));
      break;
    }
    case "permission": {
      if (!reunion || reunion.statut !== "ouverture") break;
      const actuel = !!((reunion.lignes || {})[mid] || {}).permission;
      updateDoc(doc(db, "tournante_reunions", reunion.id), { [`lignes.${mid}.permission`]: !actuel }).catch((err) => notifier("Erreur : " + err.message, "erreur"));
      break;
    }
    case "cotise": {
      if (!reunion || (reunion.statut !== "en_cours" && reunion.statut !== "cloture")) break;
      const valeur = el.dataset.val === "oui";
      const actuel = ((reunion.lignes || {})[mid] || {}).cotise;
      const nouveau = actuel === valeur ? null : valeur;
      updateDoc(doc(db, "tournante_reunions", reunion.id), { [`lignes.${mid}.cotise`]: nouveau }).catch((err) => notifier("Erreur : " + err.message, "erreur"));
      break;
    }
    case "infraction":
      if (caisse && reunion && (reunion.statut === "en_cours" || reunion.statut === "cloture")) ouvrirChoixInfraction(caisse, reunion, mid);
      break;
    case "annuler-infraction":
      if (caisse && reunion) {
        const iid = el.dataset.iid;
        confirmer("Annuler cette infraction ?", "Le montant est rendu au membre et la répartition est inversée.", "Annuler l'infraction",
          () => executer(() => annulerInfraction(caisse.id, reunion.id, iid), "Infraction annulée."));
      }
      break;
    case "valider-ouverture": {
      if (!reunion || !caisse) break;
      const manquants = membresDe(caisse.id).filter((m) => {
        const l = (reunion.lignes || {})[m.id] || {};
        return !l.permission && !l.debut;
      });
      if (manquants.length > 0) {
        notifier(`Appel incomplet : ${manquants.map((m) => m.nom).join(", ")}`, "erreur");
        break;
      }
      updateDoc(doc(db, "tournante_reunions", reunion.id), { statut: "en_cours" }).catch((err) => notifier("Erreur : " + err.message, "erreur"));
      break;
    }
    case "passer-cloture":
      if (reunion) updateDoc(doc(db, "tournante_reunions", reunion.id), { statut: "cloture" }).catch((err) => notifier("Erreur : " + err.message, "erreur"));
      break;
    case "cloturer-reunion":
      if (caisse && reunion) ouvrirApercuCloture(caisse, reunion);
      break;
    case "remise-pot":
      if (reunion) {
        confirmer("Confirmer la remise", `La cagnotte de ${formatGNF(reunion.pot)} a bien été remise à ${esc(reunion.beneficiaire_nom)} ?`, "Oui, confirmer",
          () => executer(() => updateDoc(doc(db, "tournante_reunions", reunion.id), { pot_verse: true, date_pot: serverTimestamp() }), "Remise confirmée."));
      }
      break;
    case "remise-rattrapages":
      if (reunion) {
        confirmer("Confirmer les rattrapages", "Les sommes en retard ont bien été remises aux bénéficiaires concernés ?", "Oui, confirmer",
          () => executer(() => updateDoc(doc(db, "tournante_reunions", reunion.id), { rattrapages_remis: true }), "Rattrapages confirmés."));
      }
      break;
    default: break;
  }
}

// ---------- Écoutes Firestore ----------
function arreterEcoutes() {
  etat.unsubs.forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
  etat.unsubs = [];
}

function demarrerEcoutes() {
  arreterEcoutes();
  const abonner = (nom, cle, apres) => onSnapshot(
    collection(db, nom),
    (snap) => {
      etat[cle] = snap.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }));
      render();
      if (apres) apres();
    },
    (err) => console.error(`Écoute ${nom} :`, err)
  );
  etat.unsubs.push(
    abonner("users", "utilisateurs"),
    abonner("caisses_tournantes", "caisses"),
    abonner("tournante_membres", "membres"),
    abonner("tournante_reunions", "reunions"),
    abonner("tournante_operations", "operations"),
    // Adhésions confirmées par les membres : le PDG les finalise aussi (filet de sécurité)
    abonner("propositions_nouveau_contrat", "propositions", () => {
      finaliserAdhesionsEnAttente(etat.propositions).catch((err) => console.error(err));
    })
  );
}

function initialiser() {
  const zone = racine();
  if (!zone) {
    console.warn("tournante.js : élément #tab-tournantes introuvable (index.html à mettre à jour).");
    return;
  }
  zone.addEventListener("click", surClic);

  onAuthStateChanged(auth, async (user) => {
    arreterEcoutes();
    etat.actif = false;
    etat.vue = { type: "liste", caisseId: null, reunionId: null };
    if (!user) { zone.innerHTML = ""; return; }

    for (let i = 0; i < 4; i++) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) {
          if (snap.data().role === "pdg" && auth.currentUser && auth.currentUser.uid === user.uid) {
            etat.actif = true;
            demarrerEcoutes();
          }
          return;
        }
      } catch (err) {
        console.warn("tournante.js : lecture du profil impossible", err);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  });
}

initialiser();
