export function genererCodeParrain(prefixe) {
  const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += caracteres[Math.floor(Math.random() * caracteres.length)];
  }
  return `${prefixe}-${code}`;
}

export function formatGNF(montant) {
  const n = Number(montant) || 0;
  return n.toLocaleString("fr-FR") + " GNF";
}

export function formatDate(dateVal) {
  if (!dateVal) return "—";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function moisDeDate(dateVal) {
  if (!dateVal) return "inconnu";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function nomMois(cleMoisAnnee) {
  const [annee, mois] = cleMoisAnnee.split("-");
  const d = new Date(Number(annee), Number(mois) - 1, 1);
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

// --- Ne compte QUE les versements confirmés par le PDG ; commission = part PDG (70%) uniquement ---
const PART_COMMISSION_PDG = 0.70;

export function calculerSoldes(payments, contracts) {
  let totalEpargnesConfirmees = 0;
  let totalCommissionsBrutesConfirmees = 0;
  const parMois = {};

  for (const p of payments) {
    if (p.statut !== "confirme") continue; // ignore tout ce qui n'est pas encore confirmé par le PDG

    const cle = moisDeDate(p.date);
    if (!parMois[cle]) parMois[cle] = { epargnes: 0, commissions: 0 };

    if (p.jour_numero === 1) {
      totalCommissionsBrutesConfirmees += p.montant;
      parMois[cle].commissions += p.montant * PART_COMMISSION_PDG;
    } else {
      totalEpargnesConfirmees += p.montant;
      parMois[cle].epargnes += p.montant;
    }
  }

  const totalCommissions = totalCommissionsBrutesConfirmees * PART_COMMISSION_PDG;

  return { totalEpargnes: totalEpargnesConfirmees, totalCommissions, parMois };
}

export function calculerStatutContrat(contrat, versementsConfirmes) {
  if (!contrat || contrat.statut !== 'actif') return contrat ? contrat.statut : null;

  const versementsDuContrat = versementsConfirmes.filter((v) => v.contract_id === contrat.id);
  let dateReference;

  if (versementsDuContrat.length === 0) {
    dateReference = contrat.date_debut ? new Date(contrat.date_debut) : null;
  } else {
    const dernier = versementsDuContrat.reduce((a, b) => {
      const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date || 0);
      const db = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date || 0);
      return db > da ? b : a;
    });
    dateReference = dernier.date && dernier.date.toDate ? dernier.date.toDate() : new Date(dernier.date);
  }

  if (!dateReference) return 'actif';
  const diffJours = Math.floor((new Date() - dateReference) / (1000 * 60 * 60 * 24));
  return diffJours >= 7 ? 'inactif' : 'actif';
}

export function notifier(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast-visible"));
  setTimeout(() => {
    el.classList.remove("toast-visible");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
