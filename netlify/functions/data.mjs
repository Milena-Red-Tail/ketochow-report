import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { authOf, brandSlug, store, DATA_KEY, legacyDataKey, json }
  from './_shared.mjs';

/* KetoChow (Nov 2026): the document runs past what one function answer may
   carry (about 6 MB). A page that says it can unpack gzip (x-report-gzip: 1)
   gets it packed, and in parts of PART bytes when even packed it is larger:
   the first answer says how many parts and a stamp of the document; the rest
   are asked for with ?part=i&stamp=…, and a stamp that no longer matches (the
   report was saved in between) answers 409 so the page starts again. */
const PART = Number(process.env.REPORT_PART_BYTES) || 3500000;
function packed(body) {
  const gz = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
  const stamp = createHash('sha1').update(gz).digest('hex').slice(0, 16);
  const n = Math.max(1, Math.ceil(gz.length / PART));
  return { gz, stamp, n };
}
function packedAnswer(body, req) {
  const u = new URL(req.url);
  const p = packed(body);
  const part = Number(u.searchParams.get('part') || 0);
  if (part) {
    if (u.searchParams.get('stamp') !== p.stamp) return json({ error: 'the report changed' }, 409);
    if (!(part > 0 && part < p.n)) return json({ error: 'no such part' }, 404);
  }
  /* the page already holds this very document (its browser cache): say so
     and send nothing (Nov 2026) */
  if (!part && req.headers.get('x-report-have') === p.stamp) {
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store',
      'x-report-gzip': '1', 'x-report-same': '1', 'x-report-parts': String(p.n), 'x-report-stamp': p.stamp } });
  }
  const slice = p.gz.subarray(part * PART, Math.min(p.gz.length, (part + 1) * PART));
  return new Response(slice, { status: 200, headers: {
    'content-type': 'application/octet-stream', 'cache-control': 'no-store',
    'x-report-gzip': '1', 'x-report-parts': String(p.n), 'x-report-stamp': p.stamp } });
}

/**
 * What a brand is sent.
 *
 * The report is the brand's own trading, and it is shown to them whole:
 * costs, margin and break-even included. Red-Tail works out those figures
 * from a cost file the brand itself provides, so hiding them back from the
 * brand was never protecting anything — it only made their copy of the
 * report read as if the numbers were missing.
 *
 * One thing does not travel: the upload log. That is the record of Red-Tail's
 * own work on the document — who saved it, what was dropped on it and when —
 * and it belongs with the upload page, which a brand cannot open.
 */
function forViewer(ds) {
  /* A brand selling in several countries keeps one dataset per country under
     `markets`; each is treated the same way, so no country's log travels by
     being the one nobody looked at. */
  if (ds && ds.markets && typeof ds.markets === 'object') {
    const out = Object.assign({}, ds);
    out.markets = {};
    Object.keys(ds.markets).forEach(function (c) {
      out.markets[c] = stripOne(ds.markets[c] || {});
    });
    delete out.log;
    return out;
  }
  return stripOne(ds);
}

function stripOne(ds) {
  const out = Object.assign({}, ds);
  delete out.log;
  /* the Products page's saved versions are the team's working history — a
     viewer gets the list as it stands, not every version of it */
  delete out.prodHistory;
  return out;
}

export default async (req) => {
  const auth = await authOf(req);
  if (!auth) return json({ error: 'not signed in' }, 401);

  /* The page still sends ?brand= — the same file runs on the shared site. Here
     there is only one brand and the answer never depends on the query string,
     but a request naming a different brand is a sign something is pointed at
     the wrong project, and saying so is more useful than quietly serving the
     wrong report. */
  const asked = new URL(req.url).searchParams.get('brand');
  if (asked && asked !== brandSlug()) {
    return json({ error: 'this project only serves ' + brandSlug() }, 403);
  }

  const role = auth.role === 'team' ? 'admin' : 'viewer';
  const s = await store('report');
  let ds = null;
  try { ds = await s.get(DATA_KEY, { type: 'json' }); } catch (e) { ds = null; }
  /* Data copied over from the shared site arrives under its old branded key.
     Read it once more here so the split does not look like data loss; the next
     save writes it to the bare key and this stops mattering. */
  if (!ds) { try { ds = await s.get(legacyDataKey(), { type: 'json' }); } catch (e) { ds = null; } }
  const body = ds ? { role: role, brand: brandSlug(), dataset: role === 'admin' ? ds : forViewer(ds) }
                  : { role: role, brand: brandSlug(), dataset: null };
  if (req.headers.get('x-report-gzip') === '1') return packedAnswer(body, req);
  return json(body);
};

export const config = { path: '/api/data' };
