/**
 * Viewer context — Permission model, M1 slot. The adapter passes a viewer from day one so M3 can
 * swap in an identity (Supabase Auth + RLS + ops_world_grants) without redesigning anything.
 * No auth here, no policy read: one user, one preset from the environment, Owner by default.
 *
 * Presets are the whole vocabulary (WORLD_ACCESS_POLICY draft, 2026-09-05). A sixth is a decision.
 */
/**
 * content_status is the content signature gate (AUTO_RUN_POLICY.content_system, added 2026-09-06
 * — after the permission model was drafted). It is Owner-only by design: the signature is
 * Christoffer's own act on the Content row, and the status poller resolves it. Seen live
 * 2026-09-06: without it, a real content-agent draft waiting for signature rendered with no `?`.
 *
 * approval is Compass's approval layer (src/lib/approval, 2026-10-06): a proposal waiting for an approver is a
 * gate_waiting with surface "approval" and gate "approval:<proposal id>", decided in the Compass console. It is an
 * internal approval like pending_approval, so the operator taps it too; client and prime never see it.
 */
export const ALL_SURFACES = ['pending_approval', 'class_b_gate', 'decision', 'client_gate', 'content_status', 'approval']

export const PRESETS = {
  owner: { scope: 'campus', capabilities: ['view', 'tap', 'ratify', 'ask', 'layout', 'admin'], surfaces: ALL_SURFACES },
  operator: { scope: 'campus', capabilities: ['view', 'tap'], surfaces: ['pending_approval', 'class_b_gate', 'approval'] },
  viewer: { scope: 'campus', capabilities: ['view'], surfaces: [] },
  client: { scope: 'town', capabilities: ['view', 'tap'], surfaces: ['client_gate'] },
  prime: { scope: 'town', capabilities: ['view', 'tap'], surfaces: ['client_gate'] },
}

export function makeViewer({ tenant = 'tellefsen', preset = 'owner', pack = '' } = {}) {
  const p = PRESETS[preset] || PRESETS.viewer
  const viewer = {
    tenant,
    preset: PRESETS[preset] ? preset : 'viewer',
    /** The World Pack the viewer's planet wears (U12) — set per scan from WORLD_COMPANIES, never stored. */
    pack,
    scope: p.scope,
    capabilities: [...p.capabilities],
    surfaces: [...p.surfaces],
    /** A ? renders only for someone who can resolve it (D2, 2026-09-05). */
    canTap(gate) {
      return viewer.capabilities.includes('tap') && viewer.surfaces.includes(gate?.surface)
    },
    /** The layout file is the world's only write; Owner only, so the map stays sticky for everyone. */
    canWriteLayout() {
      return viewer.capabilities.includes('layout')
    },
    /** The PA (U16, ES-4.6) is asked only by a viewer holding `ask` — of the presets, the Owner. Every ask spends tokens. */
    canAsk() {
      return viewer.capabilities.includes('ask')
    },
  }
  return viewer
}

export const ownerViewer = () => makeViewer({ preset: 'owner' })
