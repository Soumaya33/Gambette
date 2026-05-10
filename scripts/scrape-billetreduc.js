// ============================================================
// GAMBETTE — Scraper BilletRéduc v3 → CSV (+ Supabase optionnel)
// Amélioration : décodage HTML, dates/heures/prix/adresse corrects
//
// Usage :
//   node scrape-billetreduc.js           → CSV uniquement
//   node scrape-billetreduc.js --insert  → CSV + Supabase
//   node scrape-billetreduc.js --debug URL → debug une fiche
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const https = require('https');
const fs    = require('fs');

const SUPABASE_URL = 'https://xwykpuytwjiwuxhpeqrt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eWtwdXl0d2ppd3V4aHBlcXJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc2OTUsImV4cCI6MjA5MzQyMzY5NX0.eOwSEwEuKChEV-oygJkpimKPO7vT4aiHm7oPiKYveGE';

const INSERT_TO_SUPABASE = process.argv.includes('--insert');
const DEBUG_URL = process.argv.includes('--debug') ? process.argv[process.argv.indexOf('--debug') + 1] : null;
const CSV_FILE = `gambette_billetreduc_${new Date().toISOString().slice(0,10)}.csv`;

const LISTING_PAGES = [
  'https://www.billetreduc.com/bordeaux/spectacles-enfants',
  'https://www.billetreduc.com/bordeaux/theatre-enfants',
  'https://www.billetreduc.com/bordeaux/comedie-musicale-enfants',
  'https://www.billetreduc.com/bordeaux/concerts-enfants',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DÉCODAGE HTML ────────────────────────────────────────────
function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '') // enlever balises HTML restantes
    .replace(/\s+/g, ' ').trim();
}

// ── FETCH HTML ───────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const reqUrl = new URL(url);
    const options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Referer': 'https://www.billetreduc.com/',
      },
      timeout: 20000,
    };
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${reqUrl.hostname}${res.headers.location}`;
        return fetchHtml(redir).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// ── EXTRAIRE LES URLS ────────────────────────────────────────
function extractShowUrls(html) {
  const urls = new Set();
  const regex = /href="(https?:\/\/www\.billetreduc\.com\/spectacle\/[a-z0-9\-]+-\d+[^"]*)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) urls.add(m[1].split('?')[0].split('#')[0]);
  return [...urls];
}

// ── PARSER UNE FICHE SPECTACLE ───────────────────────────────
function parseShowPage(html, url) {

  // Décoder les entités HTML dans l'attribut type des balises script
  // BilletRéduc encode ld+json en ld&#x2B;json
  const normalizedHtml = html.replace(/application\/ld&#x2B;json/gi, 'application/ld+json');

  if (DEBUG_URL) {
    console.log('\n=== JSON-LD blocks trouvés ===');
  }

  // 1. Essayer JSON-LD
  const jldBlocks = normalizedHtml.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];

  if (DEBUG_URL) console.log(`  ${jldBlocks.length} blocks JSON-LD`);

  for (const block of jldBlocks) {
    try {
      const json = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
      const data = JSON.parse(json);
      if (DEBUG_URL) {
        const t = Array.isArray(data) ? data.map(d => d['@type']) : data['@type'];
        console.log('  Type:', JSON.stringify(t), '— name:', data.name || '(liste)');
      }
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const type = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
        const validTypes = ['Event','TheaterEvent','MusicEvent','ChildrensEvent','SocialEvent','Festival','ExhibitionEvent'];
        if (!validTypes.includes(type)) continue;

        const nom = decodeHtml(item.name || '');
        if (!nom || nom.length < 3) continue;

        // Dates
        let dateDebut = null, dateFin = null, heure = null;
        if (item.startDate) {
          const d = new Date(item.startDate);
          dateDebut = d.toISOString().split('T')[0];
          const h = d.getHours(), mn = d.getMinutes();
          if (h > 0 || mn > 0) heure = `${String(h).padStart(2,'0')}h${String(mn).padStart(2,'0')}`;
        }
        if (item.endDate) dateFin = new Date(item.endDate).toISOString().split('T')[0];

        // Ignorer passés
        const dateRef = dateFin || dateDebut;
        if (dateRef && new Date(dateRef + 'T23:59:59') < new Date()) return null;

        // Lieu
        const loc = item.location || {};
        const locName = decodeHtml(loc.name || '');
        const street  = decodeHtml(loc.address?.streetAddress || '');
        const city    = decodeHtml(loc.address?.addressLocality || 'Bordeaux');
        const adresse = [locName, street, city].filter(Boolean).join(', ');
        const lat = loc.geo?.latitude  ? parseFloat(loc.geo.latitude)  : null;
        const lng = loc.geo?.longitude ? parseFloat(loc.geo.longitude) : null;

        // Tarif
        let tarif = null;
        if (item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          const prices = offers.map(o => parseFloat(o.price)).filter(p => !isNaN(p) && p >= 0);
          if (prices.length > 0) {
            const min = Math.min(...prices);
            tarif = min === 0 ? 'Gratuit' : `Dès ${min}€`;
          }
        }

        // Image
        const imgRaw = item.image;
        let imageUrl = typeof imgRaw === 'string' ? imgRaw
          : Array.isArray(imgRaw) ? imgRaw[0]
          : imgRaw?.url || null;
        if (imageUrl && typeof imageUrl !== 'string') imageUrl = null;

        // Catégorie
        const txt = (nom + ' ' + (item.description || '')).toLowerCase();
        let categorie = 'theatre';
        if (txt.match(/concert|musique|chanson|orchestre|jazz/)) categorie = 'musique';

        return {
          nom, adresse, latitude: lat, longitude: lng,
          date_debut: dateDebut, date_fin: dateFin, heure,
          categorie,
          description: decodeHtml(item.description || '').slice(0, 800) || null,
          tarif, image_url: imageUrl, lien_reservation: url, valide: false,
        };
      }
    } catch(e) {
      if (DEBUG_URL) console.log('JSON-LD parse error:', e.message);
    }
  }

  // 2. Fallback : scraper les balises HTML directement
  if (DEBUG_URL) console.log('\n=== Fallback HTML scraping ===');

  // Titre : BilletRéduc format = "Nom du spectacle - Nom du lieu - Billet Réduc"
  const titleTag = normalizedHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawTitle = titleTag?.[1] || '';
  const titleParts = decodeHtml(rawTitle).split('-').map(p => p.trim());
  // Enlever "Billet Réduc" en dernier
  const cleanParts = titleParts.filter(p => !p.match(/billet\s*r[eé]duc/i));
  const nom = cleanParts[0] || '';
  const venueFromTitle = cleanParts[1] || ''; // Ex: "Théâtre l'Inox"

  if (!nom || nom.length < 3) return null;

  // Image og:image
  const ogImg = normalizedHtml.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  const imageUrl = ogImg ? ogImg[1] : null;

  // Description og:description
  const ogDesc = normalizedHtml.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i);
  const description = ogDesc ? decodeHtml(ogDesc[1]).slice(0, 800) : null;

  // Chercher dates dans le HTML (patterns courants BilletRéduc)
  // Format : "Du 10 mai 2026 au 15 juin 2026" ou "Le 10 mai 2026"
  const MOIS = { janvier:1,février:2,mars:3,avril:4,mai:5,juin:6,
    juillet:7,août:8,septembre:9,octobre:10,novembre:11,décembre:12 };

  let dateDebut = null, dateFin = null, heure = null;

  const dateRangeMatch = normalizedHtml.match(/[Dd]u\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+au\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  const dateSingleMatch = normalizedHtml.match(/[Ll]e\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  const dateSimpleMatch = normalizedHtml.match(/(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i);

  if (dateRangeMatch) {
    const [,d1,m1,y1,d2,m2,y2] = dateRangeMatch;
    const mo1 = MOIS[m1.toLowerCase()], mo2 = MOIS[m2.toLowerCase()];
    if (mo1) dateDebut = `${y1}-${String(mo1).padStart(2,'0')}-${String(d1).padStart(2,'0')}`;
    if (mo2) dateFin   = `${y2}-${String(mo2).padStart(2,'0')}-${String(d2).padStart(2,'0')}`;
  } else if (dateSingleMatch) {
    const [,d,m,y] = dateSingleMatch;
    const mo = MOIS[m.toLowerCase()];
    if (mo) dateDebut = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  } else if (dateSimpleMatch) {
    const [,d,m,y] = dateSimpleMatch;
    const mo = MOIS[m.toLowerCase()];
    if (mo) dateDebut = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // Heure
  const heureMatch = normalizedHtml.match(/\b(\d{1,2})h(\d{0,2})\b/);
  if (heureMatch) {
    const h = heureMatch[1], mn = heureMatch[2] || '00';
    if (parseInt(h) >= 8 && parseInt(h) <= 23) heure = `${String(h).padStart(2,'0')}h${mn.padStart(2,'0')}`;
  }

  // Lieu — d'abord depuis le titre, puis cherche dans le HTML
  let adresse = 'Bordeaux';
  if (venueFromTitle && venueFromTitle.length > 3) {
    adresse = venueFromTitle + ', Bordeaux';
  } else {
    const lieuMatch = normalizedHtml.match(/(?:Salle|Théâtre|Espace|Centre|Cinéma|Auditorium|Médiathèque)[^<\n]{3,60}/i);
    if (lieuMatch) adresse = decodeHtml(lieuMatch[0]).trim() + ', Bordeaux';
  }

  // Tarif
  const prixMatch = normalizedHtml.match(/(\d+[,.]?\d*)\s*€/);
  let tarif = null;
  if (prixMatch) {
    const prix = parseFloat(prixMatch[1].replace(',', '.'));
    tarif = prix === 0 ? 'Gratuit' : `Dès ${prix}€`;
  }

  // Ignorer si passé
  const dateRef = dateFin || dateDebut;
  if (dateRef && new Date(dateRef + 'T23:59:59') < new Date()) return null;

  if (DEBUG_URL) {
    console.log('Parsed:', { nom, dateDebut, dateFin, heure, adresse, tarif });
  }

  return {
    nom, adresse, latitude: null, longitude: null,
    date_debut: dateDebut, date_fin: dateFin, heure,
    categorie: 'theatre', description, tarif,
    image_url: imageUrl, lien_reservation: url, valide: false,
  };
}

// ── CSV ──────────────────────────────────────────────────────
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/\r?\n/g, ' ').trim();
  return (str.includes(';') || str.includes('"')) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

const CSV_HEADER = 'nom;date_debut;date_fin;heure;adresse;latitude;longitude;categorie;tarif;description;image_url;lien_reservation;valide';
const buildCsvRow = r => [
  r.nom, r.date_debut, r.date_fin, r.heure, r.adresse,
  r.latitude, r.longitude, r.categorie, r.tarif,
  r.description?.slice(0,200), r.image_url, r.lien_reservation, 'false'
].map(escapeCsv).join(';');

// ── SUPABASE ─────────────────────────────────────────────────
const TODAY = new Date().toISOString().split('T')[0];

async function upsertEvent(evt) {
  // Chercher si l'événement existe déjà par nom
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/evenements?nom=eq.${encodeURIComponent(evt.nom)}&select=id,valide,categorie,age_min,age_max,date_debut&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  ).then(r => r.json()).then(rows => rows[0] || null).catch(() => null);

  if (existing) {
    // Mettre à jour UNIQUEMENT si la date_debut en base est passée
    // et que la nouvelle date calculée est dans le futur
    const existingDatePast = !existing.date_debut || existing.date_debut < TODAY;
    const newDateFuture    = evt.date_debut && evt.date_debut >= TODAY;

    if (!existingDatePast || !newDateFuture) {
      return 'skipped';
    }

    // NE PAS toucher : valide, categorie, age_min, age_max
    const patch = {
      date_debut:       evt.date_debut,
      date_fin:         evt.date_fin,
      heure:            evt.heure,
      adresse:          evt.adresse,
      description:      evt.description,
      tarif:            evt.tarif,
      image_url:        evt.image_url,
      lien_reservation: evt.lien_reservation,
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) { console.warn(`  ❌ PATCH: ${(await res.text()).slice(0,80)}`); return 'error'; }
    return 'updated';
  }

  // Insérer si l'événement n'existe pas
  const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(evt),
  });
  if (!res.ok) { console.warn(`  ❌ INSERT: ${(await res.text()).slice(0,80)}`); return 'error'; }
  return 'ok';
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {

  // Mode debug : inspecter une seule URL
  if (DEBUG_URL) {
    console.log(`\n🔍 DEBUG: ${DEBUG_URL}\n`);
    const html = await fetchHtml(DEBUG_URL);
    const evt = parseShowPage(html, DEBUG_URL);
    console.log('\n✅ Résultat parsé :');
    console.log(JSON.stringify(evt, null, 2));
    return;
  }

  console.log('\n🎭 Scraper BilletRéduc v3 → Gambette');
  console.log(INSERT_TO_SUPABASE ? '   Mode : CSV + Supabase\n' : '   Mode : CSV uniquement\n');

  // ÉTAPE 1 : Collecter les URLs
  console.log('── Étape 1 : Collecte des URLs ──\n');
  const allUrls = new Set();
  for (const page of LISTING_PAGES) {
    process.stdout.write(`  📄 ${page.split('/').slice(-2).join('/')}… `);
    try {
      const html = await fetchHtml(page);
      const urls = extractShowUrls(html);
      process.stdout.write(`${urls.length} spectacles\n`);
      urls.forEach(u => allUrls.add(u));
    } catch(e) { process.stdout.write(`⚠️  ${e.message}\n`); }
    await sleep(800);
  }

  console.log(`\n  Total URLs : ${allUrls.size}`);
  if (allUrls.size === 0) {
    console.log('\n❌ Aucune URL — BilletRéduc bloque ce réseau. Essaie en 4G ou autre WiFi.\n');
    return;
  }

  // ÉTAPE 2 : Scraper chaque fiche
  console.log('\n── Étape 2 : Scraping des fiches ──\n');
  const events = [];
  const urls = [...allUrls];

  for (let i = 0; i < urls.length; i++) {
    try {
      const html = await fetchHtml(urls[i]);
      const evt = parseShowPage(html, urls[i]);
      if (evt) {
        events.push(evt);
        console.log(`  ✅ [${i+1}/${urls.length}] ${evt.nom.slice(0,55)}${evt.date_debut ? ' (' + evt.date_debut + ')' : ''}`);
      } else {
        console.log(`  ⏭️  [${i+1}/${urls.length}] Passé/ignoré : ${urls[i].split('/').pop()}`);
      }
    } catch(e) {
      console.log(`  ⚠️  [${i+1}/${urls.length}] ${e.message}`);
    }
    await sleep(600);
  }

  // ÉTAPE 3 : CSV
  fs.writeFileSync(CSV_FILE, '\uFEFF' + [CSV_HEADER, ...events.map(buildCsvRow)].join('\n'), 'utf8');
  console.log(`\n📄 CSV : ${CSV_FILE} — ${events.length} spectacles`);
  console.log('   → Vérifie dans Excel, puis relance avec --insert\n');

  // ÉTAPE 4 : Supabase
  if (INSERT_TO_SUPABASE && events.length > 0) {
    console.log(`🚀 Insertion de ${events.length} événements…\n`);
    let ins = 0, upd = 0, skip = 0, err = 0;
    for (const evt of events) {
      const r = await upsertEvent(evt);
      if (r === 'ok')       { ins++;  console.log(`  ✅ ${evt.nom.slice(0,60)}`); }
      else if (r === 'updated') { upd++;  console.log(`  ↻  ${evt.nom.slice(0,60)}`); }
      else if (r === 'skipped') { skip++; }
      else err++;
      await sleep(100);
    }
    console.log(`\n✅ Insérés: ${ins} | Mis à jour: ${upd} | Déjà à jour: ${skip} | Erreurs: ${err}`);
    console.log('   UPDATE evenements SET valide = true WHERE valide = false;\n');
  }
}

main().catch(console.error);

// Stratégie :
//   1. Récupère la liste des spectacles enfants Bordeaux
//   2. Filtre uniquement les URLs /spectacle/
//   3. Scrape chaque fiche individuelle pour les vraies données
//
// Usage :
//   node scrape-billetreduc.js           → CSV uniquement
//   node scrape-billetreduc.js --insert  → CSV + Supabase
