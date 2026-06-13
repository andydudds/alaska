// Mirror iCloud shared albums -> Supabase, for the Duddleston travel archive.
//
// Runs SERVER-SIDE only (GitHub Action). Why it can't run in the browser:
//   - Apple's sharedstreams endpoints are CORS-protected (gotcha A)
//   - the download URLs Apple hands back expire, so we must re-host every
//     photo to Supabase Storage and store THAT url, never the iCloud one (gotcha B)
//   - HEIC derivatives get converted to JPEG so thumbnails never break (gotcha C)
//
// Idempotent: dedupes on (trip, photo_guid), so hourly runs never double-insert.

import { createClient } from '@supabase/supabase-js';
import heicConvert from 'heic-convert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = 'trip-photos';

// Graceful skip so the schedule doesn't spam failure emails before you've
// added the secrets / token. Configure them and it lights up on the next run.
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.log('› SUPABASE_URL / SUPABASE_SERVICE_ROLE not set — skipping (add the GitHub secrets to enable).');
  process.exit(0);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ---------------------------------------------------------------- iCloud API

const ICLOUD_HEADERS = {
  'Content-Type': 'text/plain',
  Origin: 'https://www.icloud.com',
  Referer: 'https://www.icloud.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Photo-Mirror',
};

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Best-effort initial host. If it's wrong, Apple replies 330 with the real
// host in X-Apple-MMe-Host and we retry there — so this only saves a round trip.
function initialHost(token) {
  const seg = token[0] === 'A' ? token.substring(1, 2) : token.substring(1, 3);
  let n = 0;
  for (const c of seg) n = n * 62 + Math.max(0, BASE62.indexOf(c));
  return `p${n || 1}-sharedstreams.icloud.com`;
}

async function icloudPost(host, token, path, body) {
  return fetch(`https://${host}/${token}/sharedstreams/${path}`, {
    method: 'POST',
    headers: ICLOUD_HEADERS,
    body: JSON.stringify(body),
  });
}

// POST {streamCtag:null} to /webstream, following the 330 host redirect.
async function getWebstream(token) {
  let host = initialHost(token);
  for (let i = 0; i < 4; i++) {
    const res = await icloudPost(host, token, 'webstream', { streamCtag: null });
    if (res.status === 330) {
      const body = await res.json().catch(() => ({}));
      host = body['X-Apple-MMe-Host'] || res.headers.get('x-apple-mme-host') || host;
      continue;
    }
    if (!res.ok) throw new Error(`webstream HTTP ${res.status}`);
    return { host, stream: await res.json() };
  }
  throw new Error('webstream: too many redirects');
}

// POST photoGuids to /webasseturls -> map of checksum -> {url_location,url_path}
async function getAssetUrls(host, token, guids) {
  const items = {};
  for (let i = 0; i < guids.length; i += 25) {
    const chunk = guids.slice(i, i + 25);
    const res = await icloudPost(host, token, 'webasseturls', { photoGuids: chunk });
    if (!res.ok) throw new Error(`webasseturls HTTP ${res.status}`);
    const body = await res.json();
    Object.assign(items, body.items || {});
  }
  return items;
}

function assetUrl(item) {
  if (!item || !item.url_location || !item.url_path) return null;
  return `https://${item.url_location}${item.url_path}`;
}

// Largest derivative wins (best resolution available on the web stream).
function largestDerivative(photo) {
  const list = Object.values(photo.derivatives || {}).filter((d) => d && d.checksum);
  if (!list.length) return null;
  list.sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0));
  return list[0];
}

// ---------------------------------------------------------------- helpers

function ymdInTz(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(iso)); // YYYY-MM-DD in the trip's local time
}
function addDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
// Map a capture timestamp to a trip day number (1-based), clamped to the range.
function tripDay(trip, iso) {
  if (!iso) return 1;
  const ymd = ymdInTz(iso, trip.tz);
  if (ymd < trip.start) return 1;
  let cur = trip.start;
  let day = 1;
  while (cur <= trip.end) {
    if (cur === ymd) return day;
    cur = addDay(cur);
    day += 1;
  }
  return day - 1; // after the trip ended -> last day
}

function canonicalUploader(photo, trip) {
  const first = (photo.contributorFirstName || '').trim();
  const last = (photo.contributorLastName || '').trim();
  const full = (photo.contributorFullName || `${first} ${last}`).trim();
  const aliases = trip.contributorAliases || {};
  for (const [from, to] of Object.entries(aliases)) {
    if (first.toLowerCase() === from.toLowerCase() || full.toLowerCase() === from.toLowerCase()) return to;
  }
  return first || full || 'Family';
}

function isHeic(buf, contentType) {
  if (/heic|heif/i.test(contentType || '')) return true;
  if (buf.length < 12) return false;
  const brand = buf.subarray(8, 12).toString('ascii');
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'heif'].includes(brand);
}

async function downloadAndNormalize(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  let buf = Buffer.from(await res.arrayBuffer());
  if (isHeic(buf, contentType)) {
    const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 });
    return { buf: Buffer.from(out), ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (/png/i.test(contentType)) return { buf, ext: 'png', contentType: 'image/png' };
  return { buf, ext: 'jpg', contentType: 'image/jpeg' };
}

// ---------------------------------------------------------------- per-trip

async function mirrorTrip(trip) {
  if (!trip.icloudToken || /PASTE_YOUR/i.test(trip.icloudToken)) {
    console.log(`› ${trip.slug}: no iCloud token yet — skipping.`);
    return;
  }
  console.log(`› ${trip.slug}: fetching shared stream…`);
  const { host, stream } = await getWebstream(trip.icloudToken);
  const photos = stream.photos || [];
  console.log(`  album has ${photos.length} photo(s).`);
  if (!photos.length) return;

  // dedupe: which guids are already mirrored for this trip
  const { data: existing, error: exErr } = await sb
    .from('photos').select('photo_guid').eq('trip', trip.slug).not('photo_guid', 'is', null);
  if (exErr) throw exErr;
  const seen = new Set((existing || []).map((r) => r.photo_guid));

  const fresh = photos.filter((p) => p.photoGuid && !seen.has(p.photoGuid));
  console.log(`  ${fresh.length} new, ${photos.length - fresh.length} already mirrored.`);
  if (!fresh.length) return;

  const assets = await getAssetUrls(host, trip.icloudToken, fresh.map((p) => p.photoGuid));

  let added = 0;
  let failed = 0;
  for (const photo of fresh) {
    try {
      const deriv = largestDerivative(photo);
      const url = deriv && assetUrl(assets[deriv.checksum]);
      if (!url) { console.log(`  · ${photo.photoGuid}: no downloadable derivative, skipping`); failed++; continue; }

      const { buf, ext, contentType } = await downloadAndNormalize(url);
      const path = `${trip.slug}/icloud/${photo.photoGuid}.${ext}`;

      const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType, upsert: true });
      if (up.error) throw up.error;
      const publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

      const iso = photo.dateCreated || photo.batchDateCreated || null;
      const ins = await sb.from('photos').insert({
        trip: trip.slug,
        source: 'icloud-mirror',
        photo_guid: photo.photoGuid,
        day: tripDay(trip, iso),
        uploader: canonicalUploader(photo, trip),
        caption: (photo.caption || '').trim() || null,
        image_url: publicUrl,
        featured: false,
      });
      // 23505 = unique violation: a concurrent run beat us to it. Not an error.
      if (ins.error && ins.error.code !== '23505') throw ins.error;
      if (!ins.error) added++;
    } catch (err) {
      failed++;
      console.log(`  · ${photo.photoGuid}: ${err.message || err}`);
    }
  }
  console.log(`  done: ${added} added, ${failed} failed.`);
}

// ---------------------------------------------------------------- main

const config = JSON.parse(await readFile(join(__dir, '..', 'trips.json'), 'utf8'));
let hadError = false;
for (const trip of config.trips || []) {
  try {
    await mirrorTrip(trip);
  } catch (err) {
    hadError = true;
    console.error(`✗ ${trip.slug}: ${err.message || err}`);
  }
}
process.exit(hadError ? 1 : 0);
