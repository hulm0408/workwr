// Verifies that the Realtime Database rejects unauthenticated access.
//
// Usage:
//   FIREBASE_DB_URL=https://<project>-default-rtdb.firebaseio.com npm run verify:firebase-rules
//
// Optional:
//   FIREBASE_DB_AUTH=<database-secret>  also checks authenticated access
//
// The probe is a GET on a random, non-existent path. It never reads or writes
// real data. Exit code 0 = rules locked; 1 = rules open / misconfigured.

const base = String(
  process.env.FIREBASE_DB_URL || 'https://vuvhbjbi-default-rtdb.firebaseio.com'
).trim().replace(/\/+$/, '');

const auth = String(process.env.FIREBASE_DB_AUTH || '').trim();
const probe = `__security_probe__${Date.now()}_${Math.random().toString(36).slice(2)}.json`;

async function probeUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.text().catch(() => '');
  return { status: res.status, body: body.slice(0, 200) };
}

let failed = false;

try {
  const unauth = await probeUrl(`${base}/${probe}`);
  if (unauth.status === 401 || unauth.status === 403) {
    console.log(`UNAUTH ${unauth.status} - database rules are LOCKED (expected)`);
  } else if (unauth.status === 423) {
    failed = true;
    console.error('UNAUTH 423 - database is DEACTIVATED (not serving data).');
    console.error('  Rules cannot be verified. Owner: restore/export/delete it, then lock or remove the default source.');
    console.error(`  body:  ${unauth.body}`);
  } else if (unauth.status === 200) {
    failed = true;
    console.error(`UNAUTH 200 - database is OPEN to unauthenticated access`);
    console.error(`  probe: ${base}/${probe}`);
    console.error(`  body:  ${unauth.body}`);
  } else {
    failed = true;
    console.error(`UNAUTH ${unauth.status} - unexpected response; investigate`);
    console.error(`  probe: ${base}/${probe}`);
    console.error(`  body:  ${unauth.body}`);
  }
} catch (error) {
  failed = true;
  console.error(`UNAUTH request failed: ${error?.message || error}`);
}

if (auth) {
  try {
    const authed = await probeUrl(`${base}/${probe}?auth=${encodeURIComponent(auth)}`);
    if (authed.status === 200) {
      console.log('AUTH   200 - authenticated access works (expected with FIREBASE_DB_AUTH)');
    } else {
      failed = true;
      console.error(`AUTH   ${authed.status} - FIREBASE_DB_AUTH is wrong or lacks access`);
      console.error(`  body: ${authed.body}`);
    }
  } catch (error) {
    failed = true;
    console.error(`AUTH request failed: ${error?.message || error}`);
  }
} else {
  console.log('AUTH   skipped - FIREBASE_DB_AUTH not set');
}

if (failed) {
  console.error('\nFAIL: lock the database before running the bot against it. See SECURITY.md.');
  process.exit(1);
}

console.log('\nOK: unauthenticated access is denied.');
