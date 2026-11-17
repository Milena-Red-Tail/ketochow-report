import { gunzipSync } from 'node:zlib';
import { authOf, brandSlug, store, DATA_KEY, META_KEY, json } from './_shared.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
/* KetoChow (Nov 2026): one request may carry about 6 MB, and the packed
   document outgrows that. The page then sends it in parts —
   ?upload=<id>&part=<i>&of=<n> — each kept in the store until the last one
   arrives; the last joins them and is saved like a single answer. */
const PART_MAX = 5 * 1024 * 1024;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  /* SameSite=Lax already stops a cross-site form from carrying the cookie;
     requiring a header a plain form cannot set closes the rest. */
  if (req.headers.get('x-report-write') !== '1') {
    return json({ error: 'missing write header' }, 400);
  }
  const auth = await authOf(req);
  if (!auth || auth.role !== 'team') return json({ error: 'team only' }, 403);

  const asked = new URL(req.url).searchParams.get('brand');
  if (asked && asked !== brandSlug()) {
    return json({ error: 'this project only serves ' + brandSlug() }, 403);
  }

  let buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return json({ error: 'empty body' }, 400);
  const q = new URL(req.url).searchParams;
  const upload = q.get('upload');
  if (upload) {
    if (!/^[a-z0-9]{8,40}$/.test(upload)) return json({ error: 'bad upload id' }, 400);
    const part = Number(q.get('part')), of = Number(q.get('of'));
    if (!(of >= 1 && of <= 40 && part >= 0 && part < of)) return json({ error: 'bad part' }, 400);
    if (buf.length > PART_MAX) return json({ error: 'part too large' }, 413);
    const tmp = await store('report');
    await tmp.set('upload:' + upload + ':' + part, new Uint8Array(buf).buffer);
    if (part < of - 1) return json({ ok: true, part: part, of: of });
    /* the last part: join them all, in order */
    const parts = [];
    for (let i = 0; i < of; i++) {
      const v = await tmp.get('upload:' + upload + ':' + i, { type: 'arrayBuffer' });
      if (v == null) return json({ error: 'part ' + i + ' of ' + of + ' is missing — save again' }, 409);
      parts.push(Buffer.from(v));
    }
    for (let i = 0; i < of; i++) { try { await tmp.delete('upload:' + upload + ':' + i); } catch (e) { /* left for the next save */ } }
    buf = Buffer.concat(parts);
  }
  if (buf.length > MAX_BYTES) return json({ error: 'too large' }, 413);

  let ds;
  try {
    /* the browser gzips before sending — a three-year dataset is megabytes
       raw and well under a hundred kilobytes compressed */
    const raw = req.headers.get('x-report-gzip') === '1'
      ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    ds = JSON.parse(raw);
  } catch (e) {
    return json({ error: 'could not read that payload' }, 400);
  }
  if (!ds || typeof ds !== 'object' || !ds.daily) {
    return json({ error: 'that does not look like a dataset' }, 400);
  }

  ds.savedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  ds.savedBy = auth.user;
  const days = Object.keys(ds.daily);
  days.sort();

  const s = await store('report');
  await s.setJSON(DATA_KEY, ds);
  /* A small companion record, so the hub's cards page can say when this brand
     was last updated without pulling the whole dataset across to find out. */
  await s.setJSON(META_KEY, {
    savedAt: ds.savedAt, savedBy: auth.user, days: days.length,
    from: days[0] || null, to: days[days.length - 1] || null,
  });
  return json({ ok: true, savedAt: ds.savedAt, savedBy: auth.user,
                brand: brandSlug(), days: days.length });
};

export const config = { path: '/api/save' };
