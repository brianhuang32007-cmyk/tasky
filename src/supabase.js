// The only module that talks to Supabase — the same boundary rule storage.js
// follows for localStorage. Accounts arrive through here and nothing else has
// to know the provider's name.
//
// The client is loaded with a *dynamic* import rather than a static one, for
// two reasons. It keeps the library off the critical path for anyone who never
// signs in, and it survives tools/build_preview.py: that bundler flattens the
// module graph into one classic <script>, where a top-level `import` would be
// a syntax error. `import()` is an expression and works in both.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const CDN = 'https://esm.sh/@supabase/supabase-js@2';

/** Whether the project has been pointed at a Supabase instance yet. */
export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let clientPromise = null;

/**
 * The shared client, created on first use. Rejects rather than returning a
 * half-built client when the config is missing, so every call site fails in
 * the same obvious way instead of erroring deep inside the library.
 */
function client() {
  if (!isConfigured()) return Promise.reject(new Error('Supabase is not configured'));

  if (!clientPromise) {
    clientPromise = import(/* @vite-ignore */ CDN).then(({ createClient }) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // The redirect back from Google carries the session in the URL.
          detectSessionInUrl: true,
        },
      }),
    );
  }

  return clientPromise;
}

/**
 * Supabase hands the session back in the URL after an OAuth round trip — as
 * `?code=` under PKCE, or `#access_token=` under the implicit flow.
 *
 * Reading and clearing are two separate steps *on purpose*. The client reads
 * the URL when it is created, and it is created lazily, so anything that
 * strips the parameters before then destroys the session instead of tidying
 * up after it. This only reports; clearAuthParams() does the tidying, and the
 * caller must not run it until the client has had its turn.
 */
export function authRedirectInfo() {
  const query = new URL(location.href).searchParams;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));

  const error = query.get('error_description') || hash.get('error_description');
  const present = query.has('code') || hash.has('access_token') || Boolean(error);

  return { present, error };
}

/**
 * Takes the auth parameters back out of the address bar once they have been
 * consumed, and points the hash wherever the caller wants to land. The app
 * routes on the hash, so leaving `access_token` there would have the router
 * trying to open a page by that name.
 */
export function clearAuthParams(targetHash) {
  const url = new URL(location.href);
  for (const key of ['code', 'state', 'error', 'error_code', 'error_description']) {
    url.searchParams.delete(key);
  }
  url.hash = targetHash || '#account';
  history.replaceState(null, '', url.toString());
}

/** The current session, or null. Never throws — callers render either way. */
export async function currentUser() {
  if (!isConfigured()) return null;

  try {
    const { data } = await (await client()).auth.getSession();
    return data.session?.user ?? null;
  } catch {
    return null;
  }
}

/** Fires on sign-in, sign-out and token refresh, in this tab and after a redirect. */
export async function onAuthChange(handler) {
  if (!isConfigured()) return;

  try {
    const supabase = await client();
    supabase.auth.onAuthStateChange((_event, session) => handler(session?.user ?? null));
  } catch {
    // An unreachable CDN is reported by the page that tried to sign in, not here.
  }
}

/**
 * Every call below returns `{ error }` rather than throwing, because each one
 * has a message the user needs to read. Supabase's own messages are already
 * written for people ("Invalid login credentials"), so they are passed
 * through rather than replaced with something vaguer.
 */
const attempt = async (run) => {
  if (!isConfigured()) return { error: 'Sign-in is not set up for this copy of Tasky yet.' };

  try {
    const { error } = await run(await client());
    return { error: error ? error.message : null };
  } catch (err) {
    return { error: `Could not reach the sign-in service. ${err.message}` };
  }
};

export const signIn = (email, password) =>
  attempt((s) => s.auth.signInWithPassword({ email, password }));

/**
 * With email confirmation on — Supabase's default — this sends a link rather
 * than signing the user straight in, which is why the caller reports "check
 * your email" rather than assuming a session now exists.
 */
export const signUp = (email, password, profile = {}) =>
  attempt((s) => s.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${location.origin}${location.pathname}`,
      // Lands in the user's own `user_metadata`, which Supabase creates with
      // the account. A profile table would need its own RLS policies before it
      // could hold anything; this needs nothing and is already scoped to the
      // one user, so it is the right home until there is a reason to move.
      data: profile,
    },
  }));

/**
 * Returns to the page it left from. That URL must also be listed under
 * Authentication -> URL Configuration in Supabase, or the provider refuses the
 * redirect — localhost and the deployed origin both need an entry.
 */
export const signInWithGoogle = () =>
  attempt((s) => s.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}${location.pathname}` },
  }));

export const signOut = () => attempt((s) => s.auth.signOut());
