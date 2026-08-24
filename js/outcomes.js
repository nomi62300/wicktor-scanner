/* ==========================================================================
   Wicktor — Outcome Journal Storage
   Shared by js/app.js (logs new entries from the detail modal) and
   js/journal.js (journal.html's own page). localStorage-based, no
   Supabase — matches the existing watchlist/discovered/settings pattern.
   ========================================================================== */

const Outcomes = (() => {
  const STORAGE_KEY = 'wicktor:outcomes';
  const MAX_ENTRIES = 200;
  // Re-opening the same coin's modal repeatedly in one sitting shouldn't
  // spam duplicate log entries — this is "first time opened" in spirit
  // without tracking actual scan ids.
  const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveAll(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
  }

  /**
   * Logs a new entry unless one for the same `key` was already logged
   * within the dedupe window. Returns true if it actually logged.
   * entry: { key, band, score, side, entryPrice }
   */
  function logIfNew(entry) {
    const list = loadAll();
    const now = Date.now();
    const recentDup = list.find(e => e.key === entry.key && (now - e.timestamp) < DEDUPE_WINDOW_MS);
    if (recentDup) return false;
    list.unshift({ ...entry, timestamp: now, outcome: null });
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    saveAll(list);
    return true;
  }

  function setOutcome(index, outcome) {
    const list = loadAll();
    if (!list[index]) return;
    list[index].outcome = outcome;
    saveAll(list);
  }

  function clearAll() {
    saveAll([]);
  }

  return { STORAGE_KEY, loadAll, saveAll, logIfNew, setOutcome, clearAll };
})();

if (typeof module !== 'undefined') module.exports = Outcomes;
