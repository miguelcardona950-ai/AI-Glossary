// Everything that talks to Supabase lives in this file.
//
// Each exported function either returns data or throws a DbError. Its `kind`
// says what went wrong, so the screens can tell "can't connect" apart from
// "wrong password" or "the table doesn't exist yet":
//
//   offline      this device has no connection
//   timeout      the database took too long to answer
//   unreachable  Supabase didn't respond, or answered with a server error
//   setup        the database answered, but the terms table is missing
//   auth         the sign-in is no longer valid
//   invalid      the request was rejected (wrong password, term too long, ...)
//   notfound     the term doesn't exist any more
//   unknown      anything else

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const REQUEST_TIMEOUT_MS = 10_000; // give up on a single request after this long
const DEADLINE_MS = 12_000;        // ...and on a whole operation, including refreshing the sign-in
const PAGE_SIZE = 1000;            // Supabase returns at most 1000 rows per request
const AUTH_STORAGE_KEY = 'glossary-auth';
const COLUMNS = 'id, term, definition, created_at, updated_at';
const TIMEOUT_MESSAGE = 'Request timed out';

export class DbError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'DbError';
    this.kind = kind;
  }
}

let lastConnectionFailureAt = 0; // when a request last failed outright (no answer at all)

// fetch() that gives up instead of hanging on a bad connection.
function fetchWithTimeout(resource, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  options.signal?.addEventListener('abort', () => controller.abort());

  return fetch(resource, { ...options, signal: controller.signal })
    .catch((error) => {
      if (timedOut) throw new Error(TIMEOUT_MESSAGE);
      lastConnectionFailureAt = Date.now();
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: fetchWithTimeout },
  // The library normally retries failed reads quietly for up to a minute.
  // Fail fast instead, so the app can tell you there's a problem.
  db: { retry: false },
  auth: {
    storageKey: AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // the app uses the # part of the address for its own screens
  },
});

// Turns a Supabase error (and the HTTP status that came with it) into a DbError.
function classify(error, status) {
  const message = error?.message ?? String(error);
  const code = error?.code ?? '';

  if (message.includes(TIMEOUT_MESSAGE)) {
    return new DbError('timeout', 'The database took too long to answer.');
  }
  // Status 0 means no answer came back at all.
  if (status === 0 || error?.name === 'AuthRetryableFetchError') {
    const kind = navigator.onLine === false ? 'offline' : 'unreachable';
    return new DbError(kind, 'Could not reach the database.');
  }
  if (status >= 500) return new DbError('unreachable', `Supabase answered with an error (${status}).`);
  if (code === 'PGRST205' || code === '42P01') return new DbError('setup', 'The terms table does not exist yet.');
  if (status === 401 || code === '42501' || code === 'PGRST301' || code === 'PGRST303') {
    return new DbError('auth', 'Your sign-in has expired.');
  }
  if (code === 'PGRST116') return new DbError('notfound', 'That term no longer exists.');
  if (code === '23514') return new DbError('invalid', 'The term must be 1–200 characters, and the definition under 20,000.');
  return new DbError('unknown', message);
}

// Runs one operation with an overall time limit, turning any failure into a DbError.
async function attempt(operation) {
  // Don't even try when the phone says it's offline: the answer is immediate,
  // instead of waiting out the timeouts.
  if (navigator.onLine === false) throw new DbError('offline', 'This device is offline.');

  const startedAt = Date.now();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // The sign-in library retries failed connections by itself, so running out of
      // time can mean "couldn't connect at all" rather than "slow". Say which.
      reject(
        lastConnectionFailureAt >= startedAt
          ? new DbError(navigator.onLine === false ? 'offline' : 'unreachable', 'Could not reach the database.')
          : new DbError('timeout', 'The database took too long to answer.'),
      );
    }, DEADLINE_MS);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    throw error instanceof DbError ? error : classify(error);
  } finally {
    clearTimeout(timer);
  }
}

// Awaits a table query and returns its rows, or throws a DbError.
async function rows(query) {
  const { data, error, status } = await query;
  if (error) throw classify(error, status);
  return data;
}

// ---------- Terms ----------

// Every term, newest first.
export function listTerms() {
  return attempt(async () => {
    const terms = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = await rows(
        supabase
          .from('terms')
          .select(COLUMNS)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, from + PAGE_SIZE - 1),
      );
      terms.push(...page);
      if (page.length < PAGE_SIZE) return terms;
    }
  });
}

// The id is made on the phone (crypto.randomUUID) and "upsert" means
// "insert, or update if that id already exists". So if the connection drops
// after the database saved the term but before the phone heard back, pressing
// Save again updates that same term instead of creating a duplicate.
export function addTerm({ id, term, definition }) {
  return attempt(() => rows(supabase.from('terms').upsert({ id, term, definition }).select(COLUMNS).single()));
}

export function updateTerm(id, { term, definition }) {
  return attempt(() => rows(supabase.from('terms').update({ term, definition }).eq('id', id).select(COLUMNS).single()));
}

export function deleteTerm(id) {
  return attempt(() => rows(supabase.from('terms').delete().eq('id', id)));
}

// ---------- Signing in ----------

function hasSavedSession() {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

// The saved sign-in on this device, or null if there isn't a valid one.
// Throws a connection DbError if the sign-in couldn't be checked, so the app
// doesn't ask for your password when the real problem is the connection.
export async function getSession() {
  if (!hasSavedSession()) return null; // nothing to check, so no need for the network
  return attempt(async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error?.name === 'AuthRetryableFetchError') throw classify(error, 0);
    return data.session ?? null; // any other error means the saved sign-in is no longer valid
  });
}

export function signIn(email, password) {
  return attempt(async () => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return data.session;
    if (error.name === 'AuthRetryableFetchError') throw classify(error, 0);
    if (error.code === 'invalid_credentials') throw new DbError('invalid', 'Wrong email or password.');
    if (error.code === 'email_not_confirmed') {
      throw new DbError('invalid', 'This account’s email isn’t confirmed. In Supabase, open Authentication → Users and confirm it.');
    }
    throw new DbError('unknown', error.message);
  });
}

export function signOut() {
  return attempt(async () => {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw classify(error, error.status ?? 0);
  });
}

// Calls back when this device gets signed out, including by the library itself
// (for example, when a saved sign-in turns out to have been revoked).
export function onSignedOut(callback) {
  supabase.auth.onAuthStateChange((event) => {
    // Supabase recommends not doing more work inside this callback directly.
    if (event === 'SIGNED_OUT') setTimeout(callback, 0);
  });
}
