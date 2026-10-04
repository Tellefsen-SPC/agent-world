/**
 * Ledger reads via the Compass Worker's /ledger/scan proxy (worker/ledger-read.mjs).
 *
 * The Compass Supabase project is provisioned through Lovable Cloud, so no Supabase URL or
 * service-role key is available on this machine — Lovable-Cloud-managed projects don't expose
 * either outside Lovable itself. The Worker already holds that access; this client just asks it
 * for events + rows over the same bearer token /events already uses. Read only: this file has no
 * method that writes, and never sees the Supabase key.
 */
import { withTimeout, isTransientStatus } from './health.mjs'

export function createLedgerClient(cfg, { fetchImpl = globalThis.fetch, log = () => {}, retryDelayMs = 1000 } = {}) {
  // U37: a deadline on every scan, and one retry when the failure is the kind that passes.
  const get = withTimeout(fetchImpl, cfg.ledgerTimeoutMs ?? 25_000)
  const attempt = async (url, init) => {
    try {
      const res = await get(url, init)
      return { res, transient: isTransientStatus(res.status) }
    } catch (err) {
      if (err?.name === 'TimeoutError') throw err // a timeout is not worth a second wait
      return { err, transient: true }
    }
  }
  return {
    /**
     * { events, rows } — every ops_run_events row at or after sinceIso, oldest first, plus the
     * ops_skill_runs rows for the runs those events belong to. Paging is the Worker's problem now.
     */
    async scanSince(sinceIso) {
      const url = `${cfg.ledgerUrl}?since=${encodeURIComponent(sinceIso)}`
      const init = { headers: { Authorization: `Bearer ${cfg.eventsBearerToken}`, Accept: 'application/json' } }
      let out = await attempt(url, init)
      if (out.transient) {
        log(`ledger: ${out.err ? out.err.message : out.res.status} — retrying once`)
        await new Promise((r) => setTimeout(r, retryDelayMs))
        out = await attempt(url, init)
      }
      if (out.err) throw out.err
      const res = out.res
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`ledger read ${res.status}${body?.error ? `: ${body.error}` : ''}`)
      }
      const body = await res.json()
      // U37: an answer that is not { events, rows } is refused, not folded into a world of nonsense.
      const events = body?.events ?? []
      const rows = body?.rows ?? []
      if (!Array.isArray(events) || !Array.isArray(rows)) throw new Error('ledger read: the answer is not { events, rows }')
      log(`ledger: ${events.length} events, ${rows.length} rows since ${sinceIso}`)
      return { events, rows }
    },
  }
}
