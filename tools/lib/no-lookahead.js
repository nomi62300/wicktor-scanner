'use strict';
/* ==========================================================================
   Wicktor — lookahead tripwire.

   tools/lib/align.js documents what a lookahead bug costs here: ten
   copy-pasted alignment functions read a context bar's FINISHED ohlc before
   that bar had closed, and the buggy version scored +0.033 to +0.070R better
   on identical trades — "lookahead worth roughly the entire size of the
   crypto edge every one of these tools has ever reported."

   That was found by accident. This makes it mechanical: wrap the bar array
   so that any read of an index beyond the decision bar THROWS. A code
   review promises the state machine does not peek; this proves it, over a
   whole synthetic year, on every bar.

   Test-only. Never wrap in a production path: the Proxy is ~50x slower than
   a plain array read.
   ========================================================================== */

/**
 * sealed(bars, i) — a view of `bars` readable only up to and including `i`.
 * `length` reports i+1, so `bars.length - 1` is the decision bar and normal
 * backward iteration works unchanged.
 */
function sealed(bars, i) {
  if (!(i >= 0)) throw new Error('sealed: decision index must be >= 0');
  return new Proxy(bars, {
    get(target, prop, recv) {
      if (prop === 'length') return Math.min(i + 1, target.length);
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const k = Number(prop);
        if (k > i) {
          const e = new Error(
            `LOOKAHEAD: read of bar[${k}] while the decision bar is ${i}. ` +
            `That bar had not closed yet; its high/low/close describe the decision bar's future.`);
          e.lookahead = true; e.index = k; e.decisionIndex = i;
          throw e;
        }
        return target[k];
      }
      // Array methods operate on the sealed length via the same trap.
      const v = Reflect.get(target, prop, recv);
      if (typeof v === 'function') return v.bind(recv);
      return v;
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) <= i;
      return Reflect.has(target, prop);
    }
  });
}

module.exports = { sealed };
