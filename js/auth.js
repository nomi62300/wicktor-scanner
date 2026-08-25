/* ==========================================================================
   Wicktor — Supabase Auth + account-scoped watchlist
   Phase 3: real accounts, additive alongside the existing access-code
   gate in js/app.js (owner's explicit call: coexist, don't replace).
   Kept in its own file per the paused backlog plan's own recommendation,
   cleanly separated from app.js's existing DOM/state assumptions.

   Publishable key below is meant to be public client-side — Supabase's
   security boundary is RLS (see supabase/migrations/*_watchlist.sql),
   not key secrecy. Not a secret, unlike the CMC proxy's real API key.
   ========================================================================== */

const Auth = (() => {
  const SUPABASE_URL = 'https://fpyfetynfobfrpunnnhv.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_95VI9mw_oHduFoqUlToCmg_CpfPucLC';

  // Audit F4: window.supabase comes from a CDN <script> tag, which can be
  // blocked (ad-blocker, offline, CDN outage). createClient() throwing here
  // used to abort this whole IIFE, leaving the global `Auth` unassigned —
  // every later `Auth.xxx` call site (star clicks, Watchlist tab, Account
  // panel) then threw ReferenceError instead of degrading gracefully.
  let client = null;
  try {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  } catch (e) {
    console.warn('[Auth] Supabase client unavailable — CDN may be blocked; auth features disabled', e);
  }

  let currentUser = null;
  const listeners = [];

  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      currentUser = session ? session.user : null;
      listeners.forEach(fn => fn(currentUser));
    });
  }

  /** Call once on page load — resolves once the current session (if any) is known. */
  async function init() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    currentUser = data.session ? data.session.user : null;
    return currentUser;
  }

  function onChange(fn) { listeners.push(fn); }
  function getUser() { return currentUser; }

  async function signUp(email, password) {
    if (!client) throw new Error('Sign-up is unavailable right now — the auth service failed to load.');
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    if (!client) throw new Error('Sign-in is unavailable right now — the auth service failed to load.');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
  }

  // ------------------------------------------------------------ Watchlist
  // RLS (auth.uid() = user_id) is the real security boundary — the
  // .eq('user_id', ...) filters here are defense-in-depth, not the
  // actual enforcement.
  const watchlist = {
    async list() {
      if (!currentUser) return [];
      const { data, error } = await client
        .from('watchlist')
        .select('symbol, market')
        .eq('user_id', currentUser.id);
      if (error) { console.warn('[Auth] watchlist list failed', error); return []; }
      return data || [];
    },
    async add(symbol, market) {
      if (!currentUser) return false;
      const { error } = await client
        .from('watchlist')
        .insert({ user_id: currentUser.id, symbol, market });
      if (error) { console.warn('[Auth] watchlist add failed', error); return false; }
      return true;
    },
    async remove(symbol, market) {
      if (!currentUser) return false;
      const { error } = await client
        .from('watchlist')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('symbol', symbol)
        .eq('market', market);
      if (error) { console.warn('[Auth] watchlist remove failed', error); return false; }
      return true;
    }
  };

  return { client, init, onChange, getUser, signUp, signIn, signOut, watchlist };
})();
