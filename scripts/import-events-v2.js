// ============================================================
// GAMBETTE — Script d'import OpenAgenda → Supabase
// Usage : node import-events-v2.js
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SUPABASE_URL = 'https://xwykpuytwjiwuxhpeqrt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eWtwdXl0d2ppd3V4aHBlcXJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc2OTUsImV4cCI6MjA5MzQyMzY5NX0.eOwSEwEuKChEV-oygJkpimKPO7vT4aiHm7oPiKYveGE';
const OPENAGENDA_API_KEY = 'faab715615fb42d4a7b680672354e480';
const OPENAGENDA_BASE    = 'https://api.openagenda.com/v2';

const AGENDAS = [
  { uid: '83549053', slug: 'bordeaux-metropole',              nom: 'Bordeaux Metropole' },
  { uid: '5538134',  slug: 'ville-de-bordeaux-contributeurs', nom: 'Ville de Bordeaux' },
  { uid: '19327333', slug: 'bordeaux-tourisme',               nom: 'Bordeaux Tourisme' },
];

const KEYWORDS_STRONG = [
  'jeune public','spectacle jeune public','tout-petit','tout-petits','bambin','bebe','bebes',
  'creche','maternelle','primaire','periscolaire','centre de loisirs','accueil de loisirs',
  'nounours','doudou','atelier enfant','atelier enfants','atelier famille','atelier parents',
  'sortie famille','activite famille','activite enfant','activite enfants',
  'animation enfant','animation enfants','animation famille','spectacle enfant','spectacle enfants',
  'cinema enfant','film enfant','seance enfant','cirque enfant','cirque famille',
  'conte enfant','conte pour enfants','conte pour enfant','theatre enfant','theatre enfants',
  'theatre jeunesse','eveil musical','eveil corporel','baby gym','baby yoga','baby pilates','baby',
  'children','kids activity','for kids','kermesse','carnaval enfant','carnaval famille',
  'marionnette','marionnettes','scolaire','ecole maternelle','ecole primaire','ecole elementaire',
  'parentalite','allaitement','maternite','naissance','portage','eveil bebe',
  'atelier bebe','massage bebe','yoga bebe','sophrologie naissance','preparation accouchement',
  // versions avec accents aussi
  'bébé','bébés','parentalité','maternité','éveil bébé','atelier bébé','massage bébé',
];

const KEYWORDS_EXCLUDE = [
  'adulte uniquement','reserve aux adultes','18+','18 ans et plus',
  'soiree','afterwork','apero','aperitif','cocktail','club de nuit','boite','discotheque',
  'brunch electronik','conference','colloque','reunion','conseil municipal','assemblee',
  'seminaire','debat','forum','atelier pour devenir entrepreneur',
  'degustation','oenologie','cave','vins','biere','hyrox','crossfit','marathon','triathlon',
  'national 2','ligue 2','championnat de france de football',
  'brocante','antiquaires','brocanteurs','antiquites',
  'electronik','dj set','techno','dedicace de','speed dating',
  'cours de cuisine','atelier couture','atelier numerique','atelier de langue',
  'atelier occitan','atelier gascon','open mic','stand-up adulte','rencontre adulte',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDateRange() {
  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 60);
  return {
    from: now.toISOString().split('T')[0],
    to:   future.toISOString().split('T')[0],
  };
}

const TODAY    = new Date().toISOString().split('T')[0];
const todayStr = new Date().toLocaleDateString('fr-CA');

// ── FILTRE DATE ───────────────────────────────────────────────
// Garder si : date_fin >= today OU (pas de date_fin ET date_debut >= today)
function isNotPast(event) {
  const { begin, end } = parseTiming(event);
  const dateDebut = begin ? begin.split('T')[0] : null;
  const dateFin   = end   ? end.split('T')[0]   : null;

  if (dateFin)   return dateFin   >= TODAY;
  if (dateDebut) return dateDebut >= TODAY;
  return true;
}

function guessCategory(event) {
  const text = [
    event.title?.fr || '', event.description?.fr || '',
    (event.keywords?.fr || []).join(' '), (event.category || []).join(' '),
  ].join(' ').toLowerCase();

  if (text.match(/parentalité|parentalite|allaitement|maternité|maternite|naissance|portage|massage.*bébé|yoga.*bébé|éveil.*bébé|atelier.*bébé/)) return 'parents';
  if (text.match(/concert|musique|chanson|orchestre|jazz/))                       return 'musique';
  if (text.match(/spectacle|théâtre|theatre|cirque|marionnette|conte|comedie/))  return 'theatre';
  if (text.match(/sport|foot|rugby|tennis|gym|natation|danse|yoga/))             return 'sport';
  if (text.match(/expo|musée|musee|patrimoine|visite|galerie/))                  return 'expos';
  if (text.match(/science|découverte|decouverte|astro|planétarium|éveil|éveil/)) return 'sciences';
  if (text.match(/atelier|créatif|peinture|dessin|poterie|cuisine|bricolage/))   return 'ateliers';
  if (text.match(/balade|randonnée|randonnee|forêt|foret|jardin|nature/))        return 'nature';
  if (text.match(/piscine|baignade|lac|plage|aqua/))                             return 'eau';
  if (text.match(/ciné|cinema|film|projection/))                                 return 'musique';
  return 'ateliers';
}

function isKidsFriendly(event) {
  const titre   = (event.title?.fr || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const desc    = ((event.description?.fr || '') + ' ' + (event.longDescription?.fr || '')).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const textAll = titre + ' ' + desc;

  if (KEYWORDS_EXCLUDE.some(kw => textAll.includes(kw.toLowerCase()))) return false;

  const raw = event.timings?.[0];
  const beginStr = Array.isArray(raw) ? raw[0] : (raw?.begin || raw?.start || null);
  if (beginStr && new Date(beginStr).getHours() >= 19) return false;

  if (event.age?.min !== undefined && event.age?.max !== undefined
    && event.age.min <= 12 && event.age.max <= 18) return true;

  if (KEYWORDS_STRONG.some(kw => titre.includes(kw.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) return true;

  const childAudience = /\benfants?\b|\bkids?\b|\bjeune public\b|\btout[- ]?petits?\b|\bbebes?\b|\bbambins?\b|\bscolaires?\b/i;
  const childActivity = /\batelier\b|\bstage\b|\banimation\b|\bspectacle\b|\bconte\b|\bcirque\b|\bmarionnette\b|\beveil\b|\bbaby\b|\bjeux?\b/i;
  if (childAudience.test(titre) && childActivity.test(titre)) return true;

  const childPublicDesc = /\batelier[s]? (enfants?|famille|parents?)\b|\bpour les enfants?\b|\bdes \d+ ans\b|\b\d+[-/]\d+ ans\b|\bjeune public\b/i;
  if (childActivity.test(titre) && childPublicDesc.test(desc)) return true;

  return false;
}

function parseTiming(event) {
  const timings = event.timings;
  if (!timings || !timings.length) {
    // Fallback sur firstTiming/lastTiming
    return {
      begin: event.firstTiming?.begin || null,
      end:   event.lastTiming?.end    || null,
    };
  }

  // Chercher la prochaine occurrence à venir
  for (const raw of timings) {
    let begin = null, end = null;
    if (Array.isArray(raw))                { begin = raw[0]||null; end = raw[1]||null; }
    else if (raw && typeof raw==='object') { begin = raw.begin||raw.start||null; end = raw.end||null; }

    if (!begin) continue;
    const beginDateStr = begin.split('T')[0]; // YYYY-MM-DD
    // Si cette occurrence est aujourd'hui ou dans le futur → c'est la prochaine
    if (beginDateStr >= todayStr) {
      return { begin, end: end || begin };
    }
  }

  // Toutes les occurrences sont passées → prendre la dernière
  const last = timings[timings.length - 1];
  let begin = null, end = null;
  if (Array.isArray(last))                { begin = last[0]||null; end = last[1]||null; }
  else if (last && typeof last==='object') { begin = last.begin||last.start||null; end = last.end||null; }
  return { begin, end };
}

const DEBUG_IMAGE = process.argv.includes('--debug-image');

function parseImage(event) {
  if (!event.image) return null;

  const img = event.image;

  // Structure OpenAgenda : base = "https://cdn.openagenda.com/main/"
  //                        filename = "xxxx.base.image.jpg"
  // → URL complète = base + filename
  if (img.base && img.filename) {
    const base = img.base.endsWith('/') ? img.base : img.base + '/';
    return base + img.filename;
  }

  // Fallback : variante "full" si disponible (meilleure qualité)
  if (Array.isArray(img.variants)) {
    const full = img.variants.find(v => v.type === 'full');
    const best = full || img.variants[0];
    if (best?.filename && img.base) {
      const base = img.base.endsWith('/') ? img.base : img.base + '/';
      return base + best.filename;
    }
  }

  // Fallback : filename seul
  if (img.filename) return `https://cdn.openagenda.com/main/${img.filename}`;

  // Fallback : URL directe
  if (img.url) return img.url;
  if (typeof img === 'string' && img.startsWith('http')) return img;

  return null;
}

function parseReservationLink(event) {
  if (!Array.isArray(event.registration)) return null;
  const link = event.registration.find(r => r.type === 'link');
  return link?.value || null;
}

// ── FETCH OPENAGENDA ─────────────────────────────────────────
// "after" est un curseur renvoyé par l'API dans la réponse — PAS un offset numérique
async function fetchEvents(agendaUid, from, to, afterCursor) {
  const params = new URLSearchParams({
    key:            OPENAGENDA_API_KEY,
    size:           50,
    detailed:       1,
    'timings[gte]': from,
    'timings[lte]': to,
    relative:       'current,upcoming',
  });

  // after est un tableau renvoyé par l'API — ex: [1, 125325]
  // On le passe comme after[]=1&after[]=125325
  if (Array.isArray(afterCursor)) {
    afterCursor.forEach(v => params.append('after[]', v));
  }

  const url = `${OPENAGENDA_BASE}/agendas/${agendaUid}/events?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    console.warn(`  Erreur OpenAgenda ${res.status}: ${body.slice(0, 200)}`);
    return { events: [], total: 0 };
  }
  return res.json();
}

async function upsertEvent(evt) {
  // Chercher si l'événement existe déjà par nom
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/evenements?nom=eq.${encodeURIComponent(evt.nom)}&select=id,valide,categorie,age_min,age_max,date_debut&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  ).then(r => r.json()).then(rows => rows[0] || null).catch(() => null);

  if (existing) {
    // Mettre à jour UNIQUEMENT si la date_debut en base est passée
    // et que la nouvelle date calculée est dans le futur ou aujourd'hui
    const existingDatePast = !existing.date_debut || existing.date_debut < TODAY;
    const newDateFuture    = evt.date_debut && evt.date_debut >= TODAY;

    if (!existingDatePast || !newDateFuture) {
      return 'skipped'; // Date encore valide, rien à faire
    }

    // NE PAS toucher : valide, categorie, age_min, age_max
    const patch = {
      date_debut:       evt.date_debut,
      date_fin:         evt.date_fin,
      heure:            evt.heure,
      adresse:          evt.adresse,
      latitude:         evt.latitude,
      longitude:        evt.longitude,
      description:      evt.description,
      tarif:            evt.tarif,
      image_url:        evt.image_url,
      lien_reservation: evt.lien_reservation,
      lien_evenement:   evt.lien_evenement,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      console.warn(`  ❌ PATCH erreur: ${(await res.text()).slice(0, 80)}`);
      return 'error';
    }
    return 'updated';
  }

  // Insérer si l'événement n'existe pas encore
  const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(evt),
  });

  if (!res.ok) {
    console.warn(`  ❌ INSERT erreur: ${(await res.text()).slice(0, 80)}`);
    return 'error';
  }
  return 'ok';
}

async function main() {
  console.log('Import evenements Gambette...\n');
  const { from, to } = getDateRange();
  console.log(`Periode : ${from} -> ${to} (aujourd hui : ${TODAY})\n`);

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0, totalPast = 0, totalNotKids = 0, totalErrors = 0;

  for (const agenda of AGENDAS) {
    console.log(`\nAgenda : ${agenda.nom}`);

    let afterCursor = null; // null = 1ère page
    let pageNum     = 1;
    let hasMore     = true;

    while (hasMore) {
      let data;
      try { data = await fetchEvents(agenda.uid, from, to, afterCursor); }
      catch (e) { console.warn(`  Erreur: ${e.message}`); break; }

      const events = data.events || data.items || [];
      const total  = data.total  || 0;
      if (!events.length) { hasMore = false; break; }

      console.log(`  Page ${pageNum} — ${events.length} evenements (total: ${total})`);

      // Debug image : afficher la structure du 1er événement avec une image
      if (DEBUG_IMAGE && pageNum === 1) {
        const withImg = events.find(e => e.image);
        if (withImg) {
          console.log('\n=== DEBUG IMAGE (premier event avec image) ===');
          console.log('Titre:', withImg.title?.fr);
          console.log('Image objet:', JSON.stringify(withImg.image, null, 2).slice(0, 600));
          console.log('==============================================\n');
        }
      }

      for (const event of events) {
        if (!isNotPast(event)) { totalPast++; continue; }
        if (!isKidsFriendly(event)) { totalNotKids++; continue; }

        const nom         = event.title?.fr || event.title?.en || 'Evenement';
        const description = event.longDescription?.fr || event.description?.fr || null;
        const adresse     = event.location?.address || event.location?.name || null;
        const lat         = event.location?.latitude  || null;
        const lng         = event.location?.longitude || null;
        const categorie   = guessCategory(event);

        const { begin, end } = parseTiming(event);
        const date_debut = begin ? begin.split('T')[0] : null;

        // date_fin = fin de la SÉRIE complète (dernière occurrence) pour ne pas supprimer trop tôt
        const lastTiming = event.timings?.[event.timings.length - 1];
        let lastEnd = null;
        if (Array.isArray(lastTiming))                 lastEnd = lastTiming[1] || lastTiming[0] || null;
        else if (lastTiming && typeof lastTiming==='object') lastEnd = lastTiming.end || lastTiming.begin || null;
        const date_fin = lastEnd ? lastEnd.split('T')[0] : (end ? end.split('T')[0] : null);
        const heure = begin
          ? new Date(begin).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' })
          : null;

        let tarif = null;
        if (event.registration?.length > 0) {
          const reg = event.registration.find(r => ['link','email','phone'].includes(r.type));
          if (reg?.price === 0) tarif = 'Gratuit';
          else if (reg?.price)  tarif = `${reg.price}€`;
        }

        const row = {
          nom, adresse, latitude: lat, longitude: lng,
          date_debut, date_fin, heure, categorie, description, tarif,
          age_min:          event.age?.min ?? null,
          age_max:          event.age?.max ?? null,
          image_url:        parseImage(event),
          lien_reservation: parseReservationLink(event),
          conditions_acces: event.conditions?.fr || null,
          lien_evenement:   `https://openagenda.com/fr/${agenda.slug}/events/${event.slug}`,
          valide: false,
        };

        const result = await upsertEvent(row);
        if (result === 'ok')          { totalInserted++; console.log(`  + ${nom.slice(0,60)}`); }
        else if (result === 'updated') { totalUpdated++;  console.log(`  ↻ ${nom.slice(0,60)}`); }
        else if (result === 'skipped') { totalSkipped++; }
        else                           { totalErrors++; }

        await sleep(80);
      }

      // Lire le curseur "after" depuis la réponse API (tableau composite)
      afterCursor = Array.isArray(data.after) ? data.after : null;
      pageNum++;
      hasMore = !!afterCursor && events.length > 0;
      if (DEBUG_IMAGE) { hasMore = false; }
      await sleep(300);
    }
  }

  console.log('\n==========================================');
  console.log('Import termine !');
  console.log(`  Inseres             : ${totalInserted}`);
  console.log(`  Mis a jour          : ${totalUpdated}  (date passee -> prochaine occurrence)`);
  console.log(`  Deja a jour         : ${totalSkipped}`);
  console.log(`  Passes (ignores)    : ${totalPast}`);
  console.log(`  Non kids (ignores)  : ${totalNotKids}`);
  console.log(`  Erreurs             : ${totalErrors}`);
  console.log('==========================================');
  console.log('\nValide dans Supabase SQL Editor :');
  console.log('  UPDATE evenements SET valide = true WHERE valide = false;\n');
}

main().catch(console.error);
