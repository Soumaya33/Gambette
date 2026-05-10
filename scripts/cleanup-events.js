// ============================================================
// GAMBETTE — Nettoyage des événements terminés
// Supprime les événements dont la date est passée
// Appelé automatiquement par import-evenements.bat
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SUPABASE_URL = 'https://xwykpuytwjiwuxhpeqrt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eWtwdXl0d2ppd3V4aHBlcXJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc2OTUsImV4cCI6MjA5MzQyMzY5NX0.eOwSEwEuKChEV-oygJkpimKPO7vT4aiHm7oPiKYveGE';

async function supa(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) throw new Error(await res.text());
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

async function main() {
  // Marge de 2 jours pour éviter de supprimer des événements récurrents
  // dont la date_fin est celle d'une occurrence passée mais la série continue
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const cutoff = twoDaysAgo.toISOString().split('T')[0];
  console.log(`\nNettoyage des evenements termines (avant le ${cutoff})...\n`);

  // Tentative suppression via API REST
  let total = 0;

  try {
    // Cas 1 : date_fin renseignée et passée
    const res1 = await fetch(`${SUPABASE_URL}/rest/v1/evenements?date_fin=lt.${cutoff}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation',
        'Content-Type': 'application/json',
      },
    });
    if (res1.ok) {
      const del1 = await res1.json().catch(() => []);
      total += Array.isArray(del1) ? del1.length : 0;
      console.log(`  Supprimes (avec date_fin) : ${Array.isArray(del1) ? del1.length : 0}`);
    } else {
      console.warn(`  Policy bloque DELETE date_fin — utilise Supabase SQL Editor`);
    }

    // Cas 2 : pas de date_fin mais date_debut passée
    const res2 = await fetch(`${SUPABASE_URL}/rest/v1/evenements?date_fin=is.null&date_debut=lt.${cutoff}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation',
        'Content-Type': 'application/json',
      },
    });
    if (res2.ok) {
      const del2 = await res2.json().catch(() => []);
      total += Array.isArray(del2) ? del2.length : 0;
      console.log(`  Supprimes (sans date_fin) : ${Array.isArray(del2) ? del2.length : 0}`);
    } else {
      console.warn(`  Policy bloque DELETE date_debut — utilise Supabase SQL Editor`);
    }

    // Dédoublonnage : même nom → garder la date la plus proche
    const res3 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/deduplicate_events`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    // Si la fonction RPC n'existe pas, on ignore silencieusement
    if (res3.ok) console.log('  Doublons nettoyes via RPC');

    console.log(`\n  Total supprime : ${total} evenements passes\n`);

    if (total === 0) {
      console.log('  Si des evenements passes sont encore visibles, lance dans Supabase SQL Editor :');
      console.log(`  DELETE FROM evenements`);
      console.log(`  WHERE (date_fin IS NOT NULL AND date_fin < '${today}')`);
      console.log(`     OR (date_fin IS NULL AND date_debut < '${today}');\n`);
    }

  } catch(e) {
    console.error('Erreur :', e.message);
  }
}

main().catch(e => {
  console.error('Erreur fatale :', e.message);
  process.exit(1);
});
