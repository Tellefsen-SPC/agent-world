// overlay/main.js — Agent World overlay: the selection panel (U11), the ontology skin (U12) and, since M2b,
// the still map (U28): a thread is a fixture (a project, a room board — idle, pinned still) or a request (the
// only thing that moves); the strip over the HUD's counts reads need you · blocked · running · shipped today.
//
// Per the seam Decision (2026-09-06): mounted from index.html, reads the handle main.js exposes
// (window.botCrossing → threads, colony, settings, hud), touches nothing under src/, writes nothing
// but a planet's own layout file through overlay/zones.mjs. Mounted BEFORE src/main.js so the fetch
// seam in zones.mjs is in place when the game's first poll goes out.
//
// U11 — the panel: the run, its zone, its state, and for a pending gate the gate's name and exactly
// what the human must do, in full; A is refused on a figure that is waiting on you.
// U13 — artifacts: the card lists what a run made (Open on a real link; a Compass reference is a
// label) and a speech bubble floats over the agent for a minute after a new one.
// U14 — the in-tray: every open ? as one list in N's order (oldest gate first); I toggles it, a row
// click flies to the figure, and N is taken over here so the key and the list can never disagree.
// U15 — Approve as a verb: on a tray row and on the card. Shows the instruction and the surface's name
// first, then opens the gate's surface (the same link Open uses). The row wears ⏳ until U6's cross-check
// clears the ? on a later poll; three polls without that and it is a ? again, "not seen yet". Nothing is
// written from here — the tap lands on the surface (Decision 2026-09-06; the write path is M3's /actions).
// U17 → U33 — signals: the suit is the skill's trust status (one colour per run_mode); a hand is a tray line and a
// dusty row for a silent skill the pack wants (never a figure); a ! is a request standing in a room; ✓ is a static
// state on the project fixture; a short cue on a NEW ? or ! only, M mutes (a render setting).
// U19 — the Steering Room: R (or the room's button) opens three read-only panels from the sidecar's
// GET /steering — Pipeline hot deals (Airtable, the hot-deals view's own order), the milestone board
// (next milestone per Active project, Notion) and the last three 🧠 Decisions (Notion); 5-min caches,
// nothing editable, an empty panel names its fix.
// U20 — prospect plots as decay: every Pipeline row neither Won nor Lost stands on the campus edge (a ring
// outside every cell the map holds), fading by days since last touch — full ≤ 7 d, half ≤ 30 d, ghost after.
// A render rule over the sidecar's rows: nothing stored, nothing written; Won or Lost and the plot is gone.
// U18 → U33 — sub-agents: children are a count on the parent's fixture running list or on the parent's request
// ("n sub-runs"); a child gets its own request only when it waits, on its root ancestor's plot, and N lands on it.
// U35 — spend (ES-4.13): a town card (a click on a town plot) and every room panel carry one line — tokens, list-price
// cost and the window — folded in overlay/spend.mjs from the sidecar's /spend through the pack's own room rule;
// Owner-only, nothing (not a blank line) for any other preset or under a pack that does not show it.
// U16 — the PA panel (ES-4.6): Owner only. P (or "Ask the PA" on the selection panel and the town card) opens it; it asks
// about the selected run, its town, a project's milestone or the whole firm through the sidecar's POST /ask, which holds
// the bearer (docs/adr/0008), and shows the answer, what it was based on, and every other status in plain words. The
// rules and the words are overlay/pa.mjs. No subject is a person; the placeholder asks about places and runs.
// U12 — the skin: the planet switcher (one planet per company from Compass), the pack the planet
// wears (skin, nouns, rooms), quiet towns (an Active client with no runs still gets its deck and
// name plate), and the empty planet ("no substrate yet"). Every name on screen arrives from the
// substrate through the adapter; none lives here or in a pack (npm test greps for them).
import { ready, getWorld, currentKey, currentPlanet, townsHere, isHome, switchTo, signals, onWorldLate, loadRoom, loadArchive, loadSpend, loadSpendToday, askPa, rooms as roomsOf } from './zones.mjs'
import { nextTownSlot } from '../server/harnesses/compass/layout.mjs'
import { altitudeOf, labelRule, plateText, placeCounts } from './lod.mjs'
import { homeTarget, homeDistance } from './home.mjs'
import { roomSections, skillRowsOf } from './rooms.mjs'
import { suitFor, SignalDiff, AW_MUTED, compassNotice } from './signals.mjs'
import { wear, pack, packOf, noun, roomFor } from './pack.mjs'
import { createLabel, Plot, PLOT_PALETTE, hashString, worldToHex } from '../src/world/plots.js'
import { artifactRows, BubbleTracker, newestArtifactAt, bubbleEligible } from './artifacts.mjs'
import { shelfSections, projectTab } from './archive.mjs'
import { foldSpend, spendLineFor, estLineFor, townLines, todayLineFor, todayIsCurrent, showSpend, summary as spendSummary } from './spend.mjs'
import { intrayRows, nextRow, withHands } from './intray.mjs'
import { ApproveTracker, approveIntent, openLabel } from './approve.mjs'
import { mayAsk, subjectsFor, pickSubject, requestBody, initialPa, paReduce, panelModel, MAX_QUESTION } from './pa.mjs'

const LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  celebrating: 'Shipped',
  idle: 'Idle',
  sleeping: 'Dormant',
  spawning: 'Arriving',
  leaving: 'Heading home',
}
const CHIP = { working: 'work', waiting: 'wait', blocked: 'block' }

const css = `
:root{--aw-accent:#e05a2b;--aw-ink:#e6e9ef;--aw-panel:rgba(12,14,18,.94);--aw-line:rgba(255,255,255,.1);--aw-wait:#8fb4ee;--aw-work:#7fd39a;--aw-block:#f28b8b;--aw-done:#e6c67f;--aw-quiet:#a9a8c0}
#aw-panel{position:fixed;left:84px;bottom:18px;width:min(580px,calc(100vw - 460px));z-index:40;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);
  border:1px solid var(--aw-line);border-radius:14px;padding:14px 16px 12px;backdrop-filter:blur(10px);
  box-shadow:0 12px 40px rgba(0,0,0,.5);display:none}
#aw-panel.on{display:block}
#aw-panel .h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px}
#aw-panel .skill{font-size:16px;font-weight:600}
#aw-panel .zone{opacity:.7;font-weight:400;margin-left:8px}
#aw-panel .id{opacity:.45;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap}
#aw-panel .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
#aw-panel .chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;background:rgba(255,255,255,.08)}
#aw-panel .chip.wait{background:color-mix(in srgb,var(--aw-wait) 22%,#000);color:var(--aw-wait)}
#aw-panel .chip.work{background:color-mix(in srgb,var(--aw-work) 22%,#000);color:var(--aw-work)}
#aw-panel .chip.block{background:color-mix(in srgb,var(--aw-block) 22%,#000);color:var(--aw-block)}
#aw-panel .chip.room{background:rgba(255,255,255,.05);color:var(--aw-quiet)}
#aw-panel .do{margin:8px 0 10px;padding:10px 12px;border-left:3px solid var(--aw-wait);background:color-mix(in srgb,var(--aw-wait) 8%,transparent);border-radius:6px}
#aw-panel .do.err{border-left-color:var(--aw-block);background:color-mix(in srgb,var(--aw-block) 8%,transparent)}
#aw-panel .do b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:4px}
#aw-panel a.ctx{color:var(--aw-wait);font-size:12px;margin-right:12px;text-decoration:none;opacity:.85}
#aw-panel a.ctx:hover{text-decoration:underline}
#aw-panel .do .gate{font-weight:600;margin-bottom:2px}
#aw-panel .note{opacity:.75;margin:6px 0 8px}
#aw-panel .row{display:flex;justify-content:space-between;align-items:center;gap:10px}
#aw-panel .arts{margin:6px 0 10px;border-top:1px solid var(--aw-line);padding-top:8px}
#aw-panel .sub{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0;cursor:pointer}
#aw-panel .sub:hover{text-decoration:underline}
#aw-panel .sub .st{opacity:.6;font-size:11px;white-space:nowrap}
#aw-panel .arts b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:4px}
#aw-panel .art{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0}
#aw-panel .art .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#aw-panel .art .sys{opacity:.55;font-size:11px;margin-left:8px}
#aw-panel .art .lbl{opacity:.5;font-size:11px;white-space:nowrap}
#aw-panel .art button{padding:3px 10px;font-size:12px;background:rgba(255,255,255,.1)}
#aw-panel .hint{opacity:.5;font-size:11px}
#aw-panel button{font:inherit;border:0;border-radius:8px;padding:7px 13px;cursor:pointer;background:var(--aw-accent);color:#fff}
#aw-panel button:disabled{opacity:.35;cursor:default}
.hud .stats .stat{display:none!important}
html[data-aw-altitude="orbit"] .hud .thread-pop{display:none!important}
html[data-aw-altitude="orbit"] #aw-panel{display:none!important}
#aw-alt{position:fixed;left:84px;bottom:6px;z-index:39;font:11px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-quiet);opacity:.7;pointer-events:none}
#aw-strip{display:flex;flex-wrap:wrap;gap:5px;pointer-events:auto}
#aw-strip .pill{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 9px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid var(--aw-line);font:12px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;color:var(--aw-ink)}
#aw-strip .pill:hover{background:rgba(255,255,255,.1)}
#aw-strip .pill[data-empty="true"]{opacity:.4}
#aw-strip .pill i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
#aw-strip .pill b{font-weight:650}
#aw-strip .pill span{color:#9a9aa6}
#aw-strip .pill.wait{color:var(--aw-wait)}#aw-strip .pill.block{color:var(--aw-block)}#aw-strip .pill.work{color:var(--aw-work)}#aw-strip .pill.done{color:var(--aw-done)}#aw-strip .pill.down{color:var(--aw-block);border-color:var(--aw-block)}
#aw-panel .fx{margin:6px 0 8px;padding:8px 12px;border-left:3px solid var(--aw-quiet);background:rgba(255,255,255,.04);border-radius:6px}
#aw-panel .fx b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:4px}
#aw-panel .fx .ms{display:flex;justify-content:space-between;gap:10px;padding:2px 0;opacity:.85}
#aw-panel .fx .ms.done{opacity:.55;text-decoration:line-through}
#aw-panel .shelf .fxb{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin:8px 0 2px}#aw-panel .shelf .r.done{opacity:.55}
#aw-toast{position:fixed;left:50%;bottom:140px;transform:translateX(-50%);background:color-mix(in srgb,var(--aw-wait) 22%,#000);color:var(--aw-ink);
  padding:9px 15px;border-radius:10px;font:13px system-ui,sans-serif;z-index:41;opacity:0;transition:opacity .2s;pointer-events:none}
#aw-toast.on{opacity:1}
#aw-tray{position:fixed;left:84px;top:14px;width:min(440px,calc(100vw - 460px));max-height:min(60vh,520px);overflow:auto;z-index:40;
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);
  border:1px solid var(--aw-line);border-radius:14px;padding:10px 12px 8px;backdrop-filter:blur(10px);box-shadow:0 12px 40px rgba(0,0,0,.5);display:none}
#aw-tray.on{display:block}
#aw-tray .h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
#aw-tray .h b{font-size:14px}
#aw-tray .h .hint{opacity:.5;font-size:11px}
#aw-tray .r{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:9px;cursor:pointer;border:1px solid transparent}
#aw-tray .r:hover{background:rgba(255,255,255,.05)}
#aw-tray .r.sel{background:color-mix(in srgb,var(--aw-wait) 16%,transparent);border-color:color-mix(in srgb,var(--aw-wait) 40%,transparent)}
#aw-tray .r .q{width:22px;height:22px;border-radius:6px;background:#1a2b46;color:var(--aw-wait);font-weight:700;display:grid;place-items:center;flex:none}
#aw-tray .r .m{flex:1;min-width:0}
#aw-tray .r .s{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aw-tray .r .g{opacity:.7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aw-tray .r .z{opacity:.5;font-size:11px}
#aw-tray .r .age{opacity:.55;font-size:11px;white-space:nowrap}
#aw-tray .empty{opacity:.6;padding:6px 8px}
#aw-tray .r button,#aw-panel button.ok{font:inherit;font-size:12px;border:0;border-radius:8px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,.1);color:var(--aw-ink);flex:none}
#aw-tray .r .q.err{background:color-mix(in srgb,var(--aw-block) 22%,#000);color:var(--aw-block)}
#aw-tray .r.hand{opacity:.7}#aw-tray .r .q.dusty{background:rgba(255,255,255,.06);color:var(--aw-quiet)}
#aw-tray .r .q.wait{background:color-mix(in srgb,var(--aw-done) 22%,#000);color:var(--aw-done)}
#aw-tray .r .ns{opacity:.6;font-size:11px;font-style:italic}
#aw-intent{position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:42;width:min(520px,calc(100vw - 40px));display:none;
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);border:1px solid var(--aw-line);
  border-radius:16px;padding:18px 22px 16px;backdrop-filter:blur(10px);box-shadow:0 12px 40px rgba(0,0,0,.5)}
#aw-intent.on{display:block}
#aw-intent b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:4px}
#aw-intent .sf{font-weight:600;margin-bottom:8px}
#aw-intent .row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
#aw-intent button{font:inherit;border:0;border-radius:8px;padding:7px 13px;cursor:pointer;background:var(--aw-accent);color:#fff}
#aw-intent button.ghost{background:rgba(255,255,255,.1);color:var(--aw-ink)}
#aw-room{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:43;width:min(1180px,calc(100vw - 40px));max-height:calc(100vh - 60px);overflow:auto;display:none;
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);border:1px solid var(--aw-line);
  border-radius:16px;padding:16px 18px 14px;backdrop-filter:blur(12px);box-shadow:0 16px 60px rgba(0,0,0,.6)}
#aw-room.on{display:block}
#aw-room .h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
#aw-room .h b{font-size:16px}
#aw-room .h .hint{opacity:.5;font-size:11px}
#aw-room .cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
#aw-room .col{border:1px solid var(--aw-line);border-radius:12px;padding:10px 12px;min-height:120px}
#aw-room .col h3{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
#aw-room .col h3 span{opacity:.6;text-transform:none;letter-spacing:0;margin-left:6px}
#aw-room .r{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--aw-line)}
#aw-room .r:first-of-type{border-top:0}
#aw-room .r .n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#aw-room .r .n a{color:inherit;text-decoration:none}
#aw-room .r .n a:hover{text-decoration:underline}
#aw-room .r .n small{display:block;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aw-room .r .v{white-space:nowrap;opacity:.8;font-variant-numeric:tabular-nums}
#aw-room .r .v.late{color:var(--aw-block)}
#aw-room .r .v.stale{color:var(--aw-done)}
#aw-room .note{opacity:.65;padding:6px 0;font-style:italic}
#aw-room .cols.wide{grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
#aw-room .sec{margin:6px 0 10px}#aw-room .sec b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin:6px 0 2px}
#aw-room .r .v a{color:var(--aw-wait);text-decoration:none;margin-left:6px;font-size:11px}#aw-room .r .v a:hover{text-decoration:underline}#aw-room .r .v em{opacity:.5;font-style:normal;font-size:11px;margin-left:6px}
#aw-panel .tabs{display:flex;gap:6px;margin:4px 0 8px}#aw-panel .tabs button{background:rgba(255,255,255,.08);color:var(--aw-ink);padding:4px 10px;font-size:12px}#aw-panel .tabs button[aria-pressed="true"]{background:var(--aw-accent);color:#fff}
#aw-panel .shelf{max-height:38vh;overflow:auto}#aw-panel .shelf .r{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--aw-line)}#aw-panel .shelf .r small{display:block;opacity:.6}#aw-panel .shelf a{color:var(--aw-wait);font-size:11px;text-decoration:none;margin-left:6px}
#aw-room .foot{opacity:.45;font-size:11px;margin-top:10px}
#aw-room .spend{margin:-4px 0 10px;font-variant-numeric:tabular-nums;opacity:.85}#aw-room .spend b{font-weight:650;margin-right:6px}
#aw-room .spend+.spend{margin-top:-6px}#aw-room .spend.est{opacity:.6}#aw-room .spend.quiet{opacity:.55;font-style:italic}
#aw-planets .est{opacity:.55;font-size:11px;font-variant-numeric:tabular-nums;margin-left:6px;padding-left:8px;border-left:1px solid var(--aw-line)}
#aw-room .town .r{border-top:0;padding:3px 0}
#aw-planets{position:fixed;top:14px;right:14px;z-index:40;display:none;align-items:center;gap:6px;padding:6px 8px;
  font:12px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);border:1px solid var(--aw-line);
  border-radius:999px;backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(0,0,0,.45)}
#aw-planets.on{display:flex}
#aw-planets .k{opacity:.55;margin:0 4px 0 6px;text-transform:uppercase;letter-spacing:.08em;font-size:10px}
#aw-planets button{font:inherit;border:0;border-radius:999px;padding:4px 11px;cursor:pointer;background:rgba(255,255,255,.07);color:var(--aw-ink)}
#aw-planets button[aria-pressed="true"]{background:var(--aw-accent);color:#fff}
#aw-planets button.empty{opacity:.7}
#aw-planets .pack{opacity:.5;margin-left:4px;padding-right:4px;font-size:11px}
#aw-pa{position:fixed;right:14px;top:58px;width:min(440px,calc(100vw - 28px));max-height:calc(100vh - 80px);overflow:auto;z-index:44;display:none;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);border:1px solid var(--aw-line);
  border-radius:14px;padding:12px 14px;backdrop-filter:blur(10px);box-shadow:0 12px 40px rgba(0,0,0,.5)}
#aw-pa.on{display:block}
#aw-pa .h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}#aw-pa .h b{font-size:14px}
#aw-pa .hint{opacity:.5;font-size:11px}
#aw-pa .subj,#aw-pa .sugg{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 8px}
#aw-pa .subj button,#aw-pa .sugg button{font:inherit;font-size:12px;border:0;border-radius:999px;padding:3px 10px;cursor:pointer;background:rgba(255,255,255,.08);color:var(--aw-ink)}
#aw-pa .subj button[aria-pressed="true"]{background:var(--aw-accent);color:#fff}
#aw-pa .sugg button{background:transparent;border:1px dashed var(--aw-line);opacity:.8}#aw-pa .sugg button:hover{opacity:1}
#aw-pa textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:58px;font:inherit;color:var(--aw-ink);background:rgba(255,255,255,.05);border:1px solid var(--aw-line);border-radius:9px;padding:8px 10px}
#aw-pa .row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px}
#aw-pa .row .bad{color:var(--aw-block);opacity:.9}
#aw-pa #aw-pa-send{font:inherit;border:0;border-radius:8px;padding:6px 14px;cursor:pointer;background:var(--aw-accent);color:#fff}#aw-pa #aw-pa-send:disabled{opacity:.35;cursor:default}
#aw-pa .note{opacity:.55;font-size:11px;margin:6px 0 4px}
#aw-pa .out{margin-top:8px;padding:10px 12px;border-left:3px solid var(--aw-work);background:rgba(255,255,255,.04);border-radius:6px}
#aw-pa .out.refused,#aw-pa .out.budget{border-left-color:var(--aw-done)}#aw-pa .out.off{border-left-color:var(--aw-quiet)}#aw-pa .out.error{border-left-color:var(--aw-block)}#aw-pa .out.asking{border-left-color:var(--aw-wait)}
#aw-pa .out b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin-bottom:4px}
#aw-pa .out .about{opacity:.55;font-size:11px;margin:-2px 0 6px}#aw-pa .out .ans{white-space:pre-wrap;overflow-wrap:anywhere}
#aw-pa .out .det{opacity:.75;font-size:12px;margin-top:6px;overflow-wrap:anywhere}
#aw-pa .based{margin-top:8px;border-top:1px solid var(--aw-line);padding-top:6px}#aw-pa .based .r{font-size:12px;padding:2px 0}#aw-pa .based .r small{opacity:.55;margin-left:6px}
#aw-pa .meta{opacity:.45;font-size:11px;margin-top:6px;font-family:ui-monospace,Menlo,monospace}
#aw-room button.ask{font:inherit;font-size:12px;border:0;border-radius:8px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,.1);color:var(--aw-ink);margin:0 0 10px}
#aw-empty{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:39;text-align:center;display:none;
  font:14px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--aw-ink);background:var(--aw-panel);border:1px solid var(--aw-line);
  border-radius:16px;padding:22px 30px;backdrop-filter:blur(10px);box-shadow:0 12px 40px rgba(0,0,0,.5)}
#aw-empty.on{display:block}
#aw-empty .name{font-size:22px;font-weight:600;margin-bottom:4px}
#aw-empty .sub{opacity:.65}
`

const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)

const el = (id) => {
  const d = document.createElement('div')
  d.id = id
  document.body.appendChild(d)
  return d
}
const panel = el('aw-panel')
const tray = el('aw-tray')
const intent = el('aw-intent')
const room = el('aw-room')
const toastEl = el('aw-toast')
const switcher = el('aw-planets')
const empty = el('aw-empty')
const paEl = el('aw-pa')
// U16: P and Esc reach the PA first (registered before every other overlay key): Esc closes the topmost thing, and P is
// the PA's only for a viewer who may ask — for anyone else it stays Bot Crossing's own key (a screenshot). paKey below.
window.addEventListener('keydown', (e) => paKey(e), true)

let toastTimer = 0
function toast(text) {
  toastEl.textContent = text
  toastEl.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3200)
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - (ms || 0)) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m ago`
  const h = m / 60
  if (h < 36) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}
const shortModel = (m) => String(m || '').replace(/^claude-/, '')
/** The adapter encodes milestone progress as sizeBytes = 10^(3 + 3.5·p); this is the exact inverse. */
const progressOf = (bytes) => Math.max(0, Math.min(1, (Math.log10(Math.max(1, Number(bytes) || 1)) - 3) / 3.5))

/** The thread for the selected figure — the live one from the roster, else the agent's own copy. */
function selection() {
  const bc = window.botCrossing
  const agent = bc?.colony?.astronauts?.selected
  if (!agent) return null
  const thread = (bc.threads || []).find((t) => t.id === agent.id) || agent.thread
  return thread ? { agent, thread } : null
}

/** What the zone is called in the thread's pack: a room of the campus, a town, or a plot with no town yet. */
function zoneLabel(thread, p) {
  const world = getWorld()
  if (!world) return thread.project || ''
  if (thread.project === world.campus.name) return `${noun('centre', p)} · ${thread.project}`
  if ((world.rooms || []).some((r) => r.name === thread.project)) return `${noun('studio', p)} · ${thread.project}`
  const town = world.towns.find((t) => t.name === thread.project)
  return `${town ? noun('town', p) : 'plot'} · ${thread.project || ''}`
}
/** The room a thread stands in or belongs to (M2b): its own room, else the room its skill maps to under the pack. */
const roomOf = (thread, p) => (getWorld()?.rooms || []).find((r) => r.id === thread.room) || roomFor(thread.skill || String(thread.title || '').split(' · ')[0], p)

let fixtureTab = 'entity' // 'entity' | 'archive' — the project fixture's two tabs (U32)
let fixtureTabFor = ''
/** A fixture's panel (M2b, ES-6.2): the entity — a project with its client, stack, milestones and live runs, or a room board. */
function renderFixture(agent, thread) {
  if (fixtureTabFor !== thread.id) { fixtureTab = 'entity'; fixtureTabFor = thread.id }
  if (thread.fixture === 'project' && fixtureTab === 'archive') return renderProjectArchive(thread)
  const p = packOf(thread.pack)
  const isProject = thread.fixture === 'project'
  const url = thread.ref?.url
  const chips = isProject
    ? [
        `<span class="chip room">${esc(noun('fixture', p))} · project</span>`,
        thread.engagementType ? `<span class="chip">${esc(thread.engagementType)}</span>` : '',
        thread.internal ? '<span class="chip">internal</span>' : thread.clientName ? `<span class="chip">${esc(thread.clientName)}</span>` : '',
        ...(thread.techStack || []).map((t) => `<span class="chip room">${esc(t)}</span>`),
        thread.runningCount ? `<span class="chip work">⚒ ${thread.runningCount} running</span>` : '',
        thread.check ? '<span class="chip" style="color:var(--aw-done)">✓ milestone done</span>' : '',
        (thread.milestones || []).length ? `<span class="chip">${Math.round(progressOf(thread.sizeBytes) * 100)} % of milestones</span>` : '',
      ]
    : [`<span class="chip room">${esc(noun('fixture', p))} · ${esc(noun('studio', p))} board</span>`, thread.surface ? `<span class="chip room" title="the surface this room mirrors">${esc(thread.surface)}</span>` : '']
  const runs = isProject && thread.runningRuns?.length
    ? `<div class="fx"><b>Running now · ${thread.runningRuns.length}</b>${thread.runningRuns.map((r) => `<div class="ms"><span>⚒ ${esc(r.skill)}${r.subruns ? ` · ${r.subruns} sub-run${r.subruns === 1 ? '' : 's'}` : ''}</span><span>${esc(ago(r.at))}</span></div>`).join('')}</div>`
    : ''
  const ms = isProject && (thread.milestones || []).length
    ? `<div class="fx"><b>Milestones · ${thread.milestones.filter((m) => m.done).length} of ${thread.milestones.length} done</b>${thread.milestones.map((m) => `<div class="ms${m.done ? ' done' : ''}"><span>${m.done ? '✓ ' : ''}${esc(m.name)}</span><span>${esc(m.status || '')}</span></div>`).join('')}</div>`
    : ''
  panel.innerHTML = `
    <div class="h"><div><span class="skill">${esc(thread.title || '')}</span><span class="zone">${esc(zoneLabel(thread, p))}</span></div>
      <span class="id">${esc(noun('fixture', p))} · still</span></div>
    ${isProject ? '<div class="tabs"><button data-tab="entity" aria-pressed="true">Project</button><button data-tab="archive" aria-pressed="false">Archive</button></div>' : ''}
    <div class="chips">${chips.join('')}</div>
    ${thread.preview && !isProject ? `<div class="note">${esc(thread.preview)}</div>` : ''}
    ${runs}${ms}
    <div class="row"><span class="hint">A fixture is still: it never waits, never fails, never hammers · Enter opens the entity${paAllowed() ? ' · P asks the PA' : ''}</span>
      <span>${paAllowed() ? '<button class="ok" id="aw-ask">Ask the PA</button> ' : ''}<button id="aw-open" ${url ? '' : 'disabled'}>${esc(openLabel(url))}</button></span></div>`
  panel.classList.add('on')
  panel.querySelector('#aw-open')?.addEventListener('click', () => {
    if (url) window.open(url, '_blank', 'noopener')
  })
  panel.querySelector('#aw-ask')?.addEventListener('click', () => openPa(''))
  panel.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { fixtureTab = b.dataset.tab; lastKey = ''; render(selection()) }))
}
/** The Archive tab (U32): the shelf scoped to this project, newest first, plus its milestones. */
function renderProjectArchive(thread) {
  const p = packOf(thread.pack)
  panel.innerHTML = `
    <div class="h"><div><span class="skill">${esc(thread.title || '')}</span><span class="zone">${esc(zoneLabel(thread, p))}</span></div>
      <span class="id">${esc(noun('fixture', p))} · archive</span></div>
    <div class="tabs"><button data-tab="entity" aria-pressed="false">Project</button><button data-tab="archive" aria-pressed="true">Archive</button></div>
    <div class="shelf" id="aw-shelf"><div class="note">reading the shelf…</div></div>
    <div class="row"><span class="hint">read-only · Open where the row carries a link</span></div>`
  panel.classList.add('on')
  panel.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { fixtureTab = b.dataset.tab; lastKey = ''; render(selection()) }))
  projectArchive(thread.projectId).then(({ sections, milestones }) => {
    const el = panel.querySelector('#aw-shelf')
    if (!el || fixtureTab !== 'archive') return
    if (!archiveData) { el.innerHTML = '<div class="note">the sidecar did not answer — is ./dev.sh running?</div>'; return }
    el.innerHTML =
      sections.map((sec) => `<b class="fxb">${esc(sec.title)}</b>${sec.rows.map((r) => `<div class="r"><span>${esc(r.text)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</span><span>${esc(r.value)}${r.open.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`).join('')}</span></div>`).join('')}${sec.note ? `<div class="note">${esc(sec.note)}</div>` : ''}`).join('') +
      `<b class="fxb">Milestones · ${milestones.filter((m) => m.done).length} of ${milestones.length} done</b>` +
      (milestones.map((m) => `<div class="r${m.done ? ' done' : ''}"><span>${m.done ? '✓ ' : ''}${esc(m.text)}<small>${esc(m.small)}</small></span><span>${esc(m.value)}${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">Open in Notion ↗</a>` : ''}</span></div>`).join('') || '<div class="note">no milestones</div>')
  })
}

function render(sel) {
  if (!sel) {
    panel.classList.remove('on')
    return
  }
  const { agent, thread } = sel
  if (thread.kind === 'fixture') return renderFixture(agent, thread)
  // M2b: a request's title is badge · verb · surface and its skill rides on `skill`; the gate's name is in the tray row / preview.
  const parts = String(thread.title || '').split(' · ')
  const skill = thread.skill || parts[0]
  const gate = thread.kind === 'request' ? (thread.gates?.[0]?.gate || '') : parts.slice(1).join(' · ')
  const status = agent.status || 'idle'
  const url = thread.ref?.url
  // The adapter puts "<gate> — <full instruction>" in preview while a gate is pending; the run's notes otherwise.
  const preview = String(thread.preview || '')
  const instruction = gate && preview.startsWith(gate + ' — ') ? preview.slice(gate.length + 3) : ''
  // A town that wears its own pack (world_branding.pack, carried on the thread) speaks it here: its nouns, its rooms.
  const p = packOf(thread.pack)
  const room = roomOf(thread, p)

  const suit = suitFor(thread.trust)
  const chips = [
    `<span class="chip ${CHIP[status] || ''}">${esc(LABEL[status] || status)}</span>`,
    thread.parentId ? `<span class="chip room" title="run ${esc(String(thread.parentId).slice(0, 8))}">sub-run of ${esc(thread.parentTitle || 'its parent')}</span>` : '',
    thread.subruns?.length ? `<span class="chip room">${thread.subruns.length} sub-run${thread.subruns.length === 1 ? '' : 's'}</span>` : '',
    `<span class="chip" style="color:#${suit.hex.toString(16).padStart(6, '0')}" title="${esc(suit.hint)} · ${esc(thread.trust?.source || '')}">suit · ${esc(suit.label)}</span>`,
    room ? `<span class="chip room" title="${esc(room.mirrors || '')}">${esc(noun('studio', p))} · ${esc(room.name)}</span>` : '',
    p.id !== pack().id ? `<span class="chip room" title="this ${esc(noun('town', p))} wears its own World Pack">${esc(p.id)}</span>` : '',
    thread.source ? `<span class="chip">${esc(thread.source)}</span>` : '',
    thread.model ? `<span class="chip">${esc(shortModel(thread.model))}</span>` : '',
    `<span class="chip">${esc(ago(thread.lastActivityAt))}</span>`,
    progressOf(thread.sizeBytes) > 0.051 ? `<span class="chip">${Math.round(progressOf(thread.sizeBytes) * 100)} % of milestones</span>` : '',
  ].join('')

  const cardRow = intrayRows([thread])[0] || null
  const aState = cardRow ? approvals.state(cardRow.id, cardRow.gate, cardRow.url) : ''
  const doBlock = gate
    ? `<div class="do"><b>${thread.inheritedGate ? 'A sub-run is waiting on you — N lands on it' : thread.unread ? (aState === '⏳' ? '⏳ Approved here — waiting for the surface to show it' : aState === 'not seen yet' ? 'What it wants from you · not seen yet on the surface' : 'What it wants from you') : 'Waiting — not yours to tap'}</b>
         <div class="gate">${esc(gate)}</div>
         <div>${esc(instruction || thread.gitBranch || '')}</div></div>`
    : thread.hasError
      ? `<div class="do err"><b>What happened</b><div>${esc(preview || 'This run failed. Nothing in a surface is waiting on you.')}</div></div>`
      : preview && preview !== `${thread.source} run`
        ? `<div class="note">${esc(preview)}</div>`
        : ''

  const arts = artifactRows(thread)
  const artBlock = arts.length
    ? `<div class="arts"><b>Artifacts · ${arts.length}</b>${arts
        .map(
          (r, i) =>
            `<div class="art"><span class="n" title="${esc(r.open || r.name)}">${esc(r.name)}<span class="sys">${esc(r.system)}</span></span>${
              r.open ? `<button data-art="${i}">Open</button>` : '<span class="lbl">reference · nothing to open</span>'
            }</div>`
        )
        .join('')}</div>`
    : ''
  const subs = Array.isArray(thread.subruns) ? thread.subruns : []
  const subBlock = subs.length
    ? `<div class="arts"><b>${subs.length} sub-run${subs.length === 1 ? '' : 's'}</b>${subs
        .map((s) => `<div class="sub" data-sub="${esc(s.id)}" title="select this sub-run"><span>${esc(s.title)}</span><span class="st">${s.hasError ? '! failed' : s.unread ? '? ' + esc(s.gitBranch || 'waiting on you') : s.running ? '⚒ working' : 'done'}</span></div>`)
        .join('')}</div>`
    : ''
  panel.innerHTML = `
    <div class="h"><div><span class="skill">${esc(skill || 'Untitled run')}</span><span class="zone">${esc(zoneLabel(thread, p))}</span></div>
      <span class="id">${esc(noun('agent', p))} · run ${esc(String(thread.id).slice(0, 8))}</span></div>
    <div class="chips">${chips}</div>
    ${doBlock}
    ${subBlock}
    ${artBlock}
    <div class="row"><span class="hint">Enter opens · N flies to the next ? · ${thread.unread ? 'A is blocked on a waiting run' : 'A hides from this view only'}${paAllowed() ? ' · P asks the PA' : ''}</span>
      <span>${thread.ref?.context ? `<a class="ctx" href="${esc(thread.ref.context)}" target="_blank" rel="noopener">Context ↗</a>` : ''}${paAllowed() ? '<button class="ok" id="aw-ask">Ask the PA</button> ' : ''}${cardRow?.url ? '<button class="ok" id="aw-approve">Approve</button> ' : ''}<button id="aw-open" ${url ? '' : 'disabled'}>${esc(openLabel(url, thread.ref?.console))}</button></span></div>`
  panel.classList.add('on')
  panel.querySelector('#aw-open')?.addEventListener('click', () => {
    if (url) window.open(url, '_blank', 'noopener')
  })
  panel.querySelector('#aw-approve')?.addEventListener('click', () => approve(cardRow))
  panel.querySelector('#aw-ask')?.addEventListener('click', () => openPa(''))
  panel.querySelectorAll('.sub[data-sub]').forEach((s) => s.addEventListener('click', () => window.botCrossing?.hud?.actions?.focusThread?.(s.dataset.sub)))
  panel.querySelectorAll('button[data-art]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = arts[Number(b.dataset.art)]
      if (r?.open) window.open(r.open, '_blank', 'noopener')
    })
  )
}

// Poll the handle rather than hook main.js: no src/ edits, and 4×/s is nothing.
let lastKey = ''
let flownTo = ''
let altitude = '' // the camera's altitude (U30), set on the first sync
const lodNow = () => getWorld()?.lod || { orbit: 95, desk: 30 }
setInterval(() => {
  const sel = selection()
  // ES-6.5: the panel belongs below lod.desk. A click at district selects without flying (src); fly in as N and the tray do.
  if (sel && sel.agent.id !== flownTo && altitude === 'district') {
    flownTo = sel.agent.id
    window.botCrossing?.rig?.focus?.({ x: sel.agent.pos.x, y: 0, z: sel.agent.pos.z }, { distance: Math.min(26, lodNow().desk - 4) })
  }
  if (!sel) flownTo = ''
  const cr = sel ? intrayRows([sel.thread])[0] : null
  const key = sel ? [sel.agent.id, sel.agent.status, sel.thread.title, sel.thread.gitBranch, sel.thread.unread, sel.thread.kind === 'fixture' ? sel.thread.runningCount + ':' + sel.thread.check : sel.thread.lastActivityAt, (sel.thread.artifacts || []).length, newestArtifactAt(sel.thread), cr ? approvals.state(cr.id, cr.gate, cr.url) : '', paAllowed()].join('|') : ''
  syncQuietLabels()
  syncPa()
  if (key === lastKey) return
  lastKey = key
  render(sel)
}, 250)

// Guard: A on a figure that is waiting on you. Capture phase runs before main.js's own handler;
// stopping propagation there means Bot Crossing never sees the key. Everything else passes through.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'a' && e.key !== 'A') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    const sel = selection()
    if (!sel?.thread?.unread) return
    e.stopPropagation()
    e.preventDefault()
    toast('This run is waiting on you — clear its gate on its surface instead of hiding it')
  },
  true
)

// ── U31: room panels (the Steering Room of U19 is retired — its three panels live here) ─────────────
//
// Every room plot has a read-only panel from the sidecar's GET /rooms/<id> (the adapter's 5-min caches): the board
// room's Decisions, the strategy room's Pipeline with warmth, the marketing studio's week wall and signatures, the
// research lab's briefs, the finance office's four buckets, the integration yard's drift, the workshop's Build projects
// and benches, the records office's automations / connectors / silent skills / last twenty runs, the corner office's
// Big 3, four numbers and milestone heat. Skills are rows in their room with a state. R opens the board room; a click
// on a room plot opens its panel; Esc closes. Nothing here edits anything; a part the substrate cannot give says SKIPPED.
const roomNameOf = (id) => roomsOf().find((r) => r.id === id)?.name || (pack().rooms || []).find((r) => r.id === id)?.name || id
let roomOpen = ''
let roomData = null
let roomLoadedAt = 0
let roomLoading = false
const STATE_CLS = { lit: 'work', dark: '', dusty: 'stale', red: 'late' }

function renderRoom() {
  if (!roomOpen) {
    if (!townOpen) room.classList.remove('on')
    return
  }
  const d = roomData?.id === roomOpen ? roomData : null
  const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text))
  const sections = d ? roomSections(roomOpen, d, Date.now()) : []
  const skills = d ? skillRowsOf(d) : []
  const col = (title, sub, rows, note) =>
    `<div class="col"><h3>${esc(title)}${sub ? `<span>${esc(sub)}</span>` : ''}</h3>${rows.join('')}${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`
  const meta = roomsOf().find((r) => r.id === roomOpen)
  room.innerHTML =
    `<div class="h"><b>${esc(roomNameOf(roomOpen))}</b><span class="hint">${esc(meta?.mirrors || '')} · read-only · 5-min cache · Esc closes</span></div>` +
    spendLineHtml(spendFold?.rooms.get(roomOpen)) +
    (roomOpen === 'corner-office' ? estLineHtml(spendFold?.campus, noun('centre')) : '') + // U36: the centre carries the campus's estimate
    (!d && roomLoading ? '<div class="note">reading the substrate…</div>' : !d ? '<div class="note">the sidecar did not answer — is ./dev.sh running?</div>' : '') +
    `<div class="cols">` +
    sections.map((sec) => col(sec.title, sec.sub || '', sec.rows.map((r) => `<div class="r"><span class="n">${link(r.url, r.text)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</span><span class="v${r.cls ? ' ' + esc(r.cls) : ''}">${esc(r.value || '')}</span></div>`), sec.note)).join('') +
    (skills.length && roomOpen !== 'workshop'
      ? col(`Skills · ${skills.length}`, 'by ops_skills.type, with the pack\'s overrides', skills.map((k) => `<div class="r"><span class="n"><span class="v ${STATE_CLS[k.state] || ''}">${esc(k.glyph)}</span> ${esc(k.name)}<small>${esc(k.hint)}${k.wants ? ' · wants ' + esc(k.wants) : ''}</small></span><span class="v">${esc(k.type)}</span></div>`), '')
      : '') +
    `</div><div class="foot">${d?.at ? 'as of ' + esc(new Date(d.at).toLocaleTimeString()) : ''} · the room mirrors its surface — change things there, never here</div>`
  room.classList.add('on')
}
let roomLoadingId = ''
async function refreshRoom(force = false) {
  if (!roomOpen) return
  if (roomOpen === 'archive') return openArchive(force) // the archive has its own reader and renderer (U32)
  if (roomLoadingId === roomOpen) return // this room is already on its way
  if (!force && roomData?.id === roomOpen && Date.now() - roomLoadedAt < 5 * 60_000) return
  const id = roomOpen
  roomLoadingId = id
  roomLoading = true
  renderRoom()
  const d = await loadRoom(id)
  if (roomLoadingId === id) { roomLoadingId = ''; roomLoading = false }
  // a room switched away from while it loaded: keep its answer only if it is the one open now
  if (d && roomOpen === id) {
    roomData = d
    roomLoadedAt = Date.now()
  }
  renderRoom()
}
function openRoom(id) {
  roomOpen = roomOpen === id ? '' : id
  townOpen = ''
  if (roomOpen === 'archive') return openArchive()
  renderRoom()
  if (roomOpen) {
    refreshRoom(roomData?.id !== roomOpen)
    refreshSpend().then(() => roomOpen && roomOpen !== 'archive' && renderRoom())
  }
}

// ── U35: spend per town and room (ES-4.13) ───────────────────────────────────────────────────
//
// The sidecar's /spend is the Worker's GET /world/spend object (60-s cache there); overlay/spend.mjs folds its rows
// into the places of the planet on screen through the pack's own roomForSkill. One line per place: tokens · cost ·
// window, with the unmetered and unpriced counts on the same line so a total is never silently short. Owner-only:
// for any other preset — or under a pack whose spend.show is false — spendLineHtml yields nothing, not a blank line.
// ?include_test=1 on the page keeps the test rows in (the fixture check, V-U35); nothing here counts or stores.
let spendData = null
let spendToday = null // U37: today's cost per town (/spend/today), read beside the 30-day object
let spendFold = null
let spendAt = 0
let spendLoading = null
const INCLUDE_TEST = new URLSearchParams(location.search).get('include_test') === '1'
const spendWindow = () => Number(pack().spend?.window_days) || 30
const spendAllowed = () => showSpend(getWorld()?.viewer, pack())
async function refreshSpend(force = false) {
  if (!spendAllowed()) { spendData = null; spendFold = null; return null }
  if (!force && spendData && Date.now() - spendAt < 60_000) return spendFold
  if (spendLoading) return spendLoading
  spendLoading = (async () => {
    const [d, t] = await Promise.all([loadSpend(spendWindow(), INCLUDE_TEST), loadSpendToday(INCLUDE_TEST)])
    spendToday = t
    if (d) {
      spendData = d
      spendAt = Date.now()
      const world = getWorld()
      spendFold = foldSpend(d, { pack: pack(), towns: world?.towns || [], planet: currentKey(), home: world?.home || '' })
      syncPlanetEst() // U36: the planet's estimate line in the switcher
    }
    spendLoading = null
    return spendFold
  })()
  return spendLoading
}
// U36 — the estimate line and the empty town. A by_client row may carry est (the client's chat-usage estimate from
// SPEND_ESTIMATES); it rides on the town's bucket and is shown on its own line under the metered one — est. chat …
// with a tilde — never summed into it. A town with no row or no runs reads `no runs · 30d`, never a blank, never $0.
// The corner office (ring 0, the centre) carries the campus's line and the planet switcher the planet's, both from
// totals.est. Room panels are unchanged. Pack-gated a second time by spend.estimates (tellefsen-campus true).
const SPEND_TITLE = () => `list-price equivalent at MODEL_PRICING · by place, never by person · ${spendFold?.at || ''}`
const EST_TITLE = () => `an estimate from the chat export (SPEND_ESTIMATES ${spendFold?.estimatesVersion || ''}) · attributed to the client by name, never metered, never added to the line above · by place, never by person`
const lineHtml = (line, cls, title) => (line ? `<div class="spend${cls ? ' ' + cls : ''}" title="${esc(title)}"><b>${esc(line.split(' · ')[0])}</b>· ${esc(line.split(' · ').slice(1).join(' · '))}</div>` : '')
/** U36: re-cut the fold for the planet on screen from the last read (no fetch); with nothing read yet, read once. */
function refoldSpend() {
  if (!spendAllowed()) return
  if (!spendData) return void refreshSpend()
  const world = getWorld()
  spendFold = foldSpend(spendData, { pack: pack(), towns: world?.towns || [], planet: currentKey(), home: world?.home || '' })
  syncPlanetEst()
}
/** U36: the estimate line for a place's bucket (a town, the campus, the planet), or '' — estLineFor is the gate. */
function estLineHtml(bucket, place = '') {
  if (!spendAllowed() || !spendFold || spendFold.error) return ''
  const line = estLineFor(bucket, { viewer: getWorld()?.viewer, pack: pack(), fold: spendFold })
  return lineHtml(line, 'est', `${place ? place + ' · ' : ''}${EST_TITLE()}`)
}
/** U36: the town card's lines — the metered one (or the quiet `no runs`), then the estimate when there is one. U37: then today's. */
function townLinesHtml(name) {
  if (!spendAllowed() || !spendFold) return ''
  if (spendFold.error) return spendLineHtml(null) + todayLineHtml(name)
  const lines = townLines(spendFold.towns.get(name), { viewer: getWorld()?.viewer, pack: pack(), fold: spendFold })
  return lines.map((line) => (line.startsWith('est. ') ? lineHtml(line, 'est', EST_TITLE()) : line.startsWith('no ') ? lineHtml(line, 'quiet', SPEND_TITLE()) : lineHtml(line, '', SPEND_TITLE()))).join('') + todayLineHtml(name)
}
/** U37: today's line for a town — the UTC day so far, from Compass's GET /ledger/cost?days=1; quiet when there is nothing. */
const TODAY_TITLE = () => `today so far (since 00:00 UTC) · priced as the line above · by place, never by person · ${spendToday?.at || ''}`
function todayLineHtml(name) {
  const line = todayLineFor(spendToday, name, { viewer: getWorld()?.viewer, pack: pack(), fold: spendFold })
  if (!line) return ''
  const quiet = /no runs|unavailable/.test(line)
  const why = spendToday?.error ? `today's cost — ${spendToday.error}` : !todayIsCurrent(spendToday) ? `today's cost — the last answer is from ${String(spendToday?.since || '').slice(0, 10)}; Compass has not answered today` : ''
  return lineHtml(line, quiet ? 'quiet' : '', why || TODAY_TITLE())
}
/** The line for a place, or '' — spendLineFor is the Owner-only / pack gate; a failed read says so instead of zeros. */
function spendLineHtml(bucket) {
  if (!spendAllowed()) return ''
  if (!spendFold) return ''
  if (spendFold.error) return `<div class="spend"><b>Tokens</b>the Worker's spend read failed — ${esc(spendFold.error)}</div>`
  const line = spendLineFor(bucket, { viewer: getWorld()?.viewer, pack: pack(), fold: spendFold })
  return lineHtml(line, '', SPEND_TITLE())
}
// the town card: a click on a town plot opens it — the town's name, what stands there, and the spend line
let townOpen = ''
function renderTown() {
  if (!townOpen) return
  const name = townOpen
  const here = (window.botCrossing?.threads || []).filter((t) => t.project === name)
  const rows = here.map((t) => `<div class="r"><span class="n">${esc(t.title)}${t.kind === 'request' ? `<small>${esc(t.skill || '')}${t.gitBranch ? ' · ' + esc(t.gitBranch) : ''}</small>` : `<small>${esc(t.preview || '')}</small>`}</span><span class="v${t.hasError ? ' late' : ''}">${esc(t.kind === 'request' ? t.badge : noun('fixture'))}</span></div>`)
  room.innerHTML =
    `<div class="h"><b>${esc(noun('town'))} · ${esc(name)}</b><span class="hint">a client's ${esc(noun('town'))} · read-only · Esc closes</span></div>` +
    townLinesHtml(name) +
    (paAllowed() ? `<button class="ask" id="aw-town-ask">Ask the PA about this ${esc(noun('town'))}</button>` : '') +
    `<div class="cols"><div class="col town"><h3>Standing here · ${here.length}</h3>${rows.join('') || '<div class="note">nothing stands here — no request, no fixture</div>'}</div></div>` +
    `<div class="foot">${spendFold?.at ? 'spend as of ' + esc(new Date(spendFold.at).toLocaleTimeString()) + ' · ' : ''}the ${esc(noun('town'))} mirrors its client — change things on the surfaces, never here</div>`
  room.classList.add('on')
  room.querySelector('#aw-town-ask')?.addEventListener('click', () => openPa(`town:${name}`))
}
function openTown(name) {
  townOpen = townOpen === name ? '' : name
  roomOpen = ''
  if (!townOpen) return room.classList.remove('on')
  renderTown()
  refreshSpend().then(() => townOpen === name && renderTown())
}

// ── U16: the PA panel (ES-4.6) ───────────────────────────────────────────────────────────────
//
// Owner only (the `ask` capability; the sidecar refuses anyone else too): P, or "Ask the PA" on the selection panel or the
// town card, opens it. It asks about the selected run, its town, a project or one of its milestones, or the whole firm —
// the subjects overlay/pa.mjs builds from what is selected; none of them is a person. The question goes to the sidecar's
// POST /ask (zones.mjs askPa) and nowhere else; the bearer stays on the server (docs/adr/0008). The answer is shown with
// what it was asked about and what it was based on; every other status is said in words (pa.mjs viewOf). Nothing here
// stores anything: the state is this page's, and goes with it.
let pa = initialPa()
const paAllowed = () => mayAsk(getWorld()?.viewer)
const paSubjects = () => subjectsFor({ thread: selection()?.thread || null, town: townOpen, towns: (getWorld()?.towns || []).map((t) => t.name), noun: noun('town') })
let paBuilt = false // the shell (and its textarea) is built once per open, so typing never loses the caret
let paSubjectsKey = ''
function paOutHtml(m) {
  if (m.pending) return `<div class="out asking"><b>Asking</b><div class="about">about ${esc(m.askedAbout)}</div><div class="ans">The Worker reads the substrate, then asks the model. It can take up to half a minute.</div></div>`
  const v = m.view
  if (!v) return ''
  return `<div class="out ${esc(v.tone)}"><b>${esc(v.title)}</b>${m.askedAbout ? `<div class="about">about ${esc(m.askedAbout)}</div>` : ''}<div class="ans">${esc(v.text)}</div>` +
    (v.detail ? `<div class="det">${esc(v.detail)}</div>` : '') +
    (v.wait ? `<div class="det">${esc(v.wait)}</div>` : '') +
    v.notes.map((t) => `<div class="det">${esc(t)}</div>`).join('') +
    (v.basedOn.length ? `<div class="based"><b>Based on</b>${v.basedOn.map((r) => `<div class="r" title="${esc(r.ref)}">${esc(r.label)}${r.note ? `<small>${esc(r.note)}</small>` : ''}</div>`).join('')}</div>` : '') +
    (v.meta ? `<div class="meta">${esc(v.meta)}</div>` : '') +
    '</div>'
}
function renderPa() {
  const subjects = paSubjects()
  const m = panelModel({ viewer: getWorld()?.viewer, state: pa, subjects })
  if (!m) {
    // not open, or a viewer without `ask`: no element at all
    paEl.classList.remove('on')
    paEl.innerHTML = ''
    paBuilt = false
    return
  }
  if (!paBuilt) {
    paEl.innerHTML = `<div class="h"><b>Ask the PA</b><span class="hint">Enter asks · Shift+Enter a new line · Esc closes</span></div>
      <div class="subj" id="aw-pa-subj"></div>
      <textarea id="aw-pa-q" rows="3" maxlength="${MAX_QUESTION}" placeholder="${esc(m.placeholder)}"></textarea>
      <div class="sugg" id="aw-pa-sugg"></div>
      <div class="row"><span class="hint" id="aw-pa-count"></span><button id="aw-pa-send">Ask</button></div>
      <div class="note">${esc(m.hint)}</div>
      <div id="aw-pa-out"></div>`
    paBuilt = true
    paSubjectsKey = ''
    const q = paEl.querySelector('#aw-pa-q')
    q.value = pa.question
    q.addEventListener('input', () => {
      pa = paReduce(pa, { type: 'type', text: q.value })
      renderPaFoot()
    })
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        sendPa()
      }
    })
    paEl.querySelector('#aw-pa-send').addEventListener('click', sendPa)
  }
  const key = m.subjects.map((s) => `${s.id}${s.pressed ? '*' : ''}`).join('|')
  if (key !== paSubjectsKey) {
    paSubjectsKey = key
    paEl.querySelector('#aw-pa-subj').innerHTML = m.subjects.map((s) => `<button data-subj="${esc(s.id)}" aria-pressed="${s.pressed}">${esc(s.label)}</button>`).join('')
    paEl.querySelector('#aw-pa-sugg').innerHTML = m.suggestions.map((t) => `<button data-sugg>${esc(t)}</button>`).join('')
  }
  renderPaFoot(m)
  paEl.querySelector('#aw-pa-out').innerHTML = paOutHtml(m)
  paEl.classList.add('on')
}
// one delegated listener on the panel element itself (it outlives every rebuild of its contents): a subject, a suggestion
paEl.addEventListener('click', (e) => {
  const subj = e.target.closest?.('button[data-subj]')
  if (subj) {
    pa = paReduce(pa, { type: 'subject', id: subj.dataset.subj })
    return renderPa()
  }
  const sugg = e.target.closest?.('button[data-sugg]')
  const q = paEl.querySelector('#aw-pa-q')
  if (sugg && q) {
    q.value = sugg.textContent
    pa = paReduce(pa, { type: 'type', text: q.value })
    renderPaFoot()
    q.focus()
  }
})
/** The counter and the button only — called on every keystroke. */
function renderPaFoot(model) {
  if (!paBuilt) return
  const m = model || panelModel({ viewer: getWorld()?.viewer, state: pa, subjects: paSubjects() })
  if (!m) return
  const count = paEl.querySelector('#aw-pa-count')
  count.textContent = m.problem || m.count
  count.classList.toggle('bad', Boolean(m.problem))
  const send = paEl.querySelector('#aw-pa-send')
  send.disabled = !m.canSend
  send.textContent = m.sendLabel
}
async function sendPa() {
  const subject = pickSubject(paSubjects(), pa.subjectId)
  const next = paReduce(pa, { type: 'send', subject })
  if (next === pa) return renderPa() // nothing to send: empty, too long, or one already out
  pa = next
  const body = requestBody(pa.question, subject)
  renderPa()
  const r = await askPa(body)
  pa = paReduce(pa, { type: 'result', status: r.status, body: r.body })
  renderPa()
}
function openPa(subjectId = '') {
  if (!paAllowed()) return false
  pa = paReduce(pa, { type: 'open', subjectId })
  renderPa()
  paEl.querySelector('#aw-pa-q')?.focus()
  return true
}
function closePa() {
  pa = paReduce(pa, { type: 'close' })
  renderPa()
}
/** The selection moved (or the world arrived): redraw the subjects while the panel is open; hide it for a viewer without `ask`. */
function syncPa() {
  if (!pa.open && !paEl.classList.contains('on')) return
  const key = paAllowed() + '|' + paSubjects().map((s) => s.id).join('|')
  if (key !== syncPa.last) {
    syncPa.last = key
    renderPa()
  }
}
function paKey(e) {
  if (e.key === 'Escape' && pa.open) {
    e.stopImmediatePropagation()
    e.preventDefault()
    return closePa()
  }
  if (e.key !== 'p' && e.key !== 'P') return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
  if (!paAllowed()) return // not the Owner: P stays Bot Crossing's screenshot key
  e.stopPropagation()
  e.preventDefault()
  if (pa.open) closePa()
  else openPa('')
}

// ── U32: the archive ────────────────────────────────────────────────────────────────────────
let archiveData = null
let archiveAt = 0
let archiveLoading = false
function renderArchive() {
  if (roomOpen !== 'archive') return
  const d = archiveData
  const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text))
  const shelfHtml = (shelf) => {
    const sections = shelfSections(shelf).filter((sec) => sec.rows.length || sec.note.startsWith('SKIPPED'))
    return `<div class="col"><h3>${esc(shelf.name)}<span>${shelf.deliverables.length} deliverable${shelf.deliverables.length === 1 ? '' : 's'} · ${shelf.decisions.length} settled decision${shelf.decisions.length === 1 ? '' : 's'}</span></h3>${sections
      .map((sec) => `<div class="sec"><b>${esc(sec.title)}</b>${sec.rows.slice(0, 40).map((r) => `<div class="r"><span class="n">${esc(r.text)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</span><span class="v">${esc(r.value)} ${r.open.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`).join(' ')}${r.reference ? '<em>reference</em>' : ''}</span></div>`).join('')}${sec.note ? `<div class="note">${esc(sec.note)}</div>` : ''}</div>`)
      .join('')}</div>`
  }
  room.innerHTML =
    `<div class="h"><b>${esc(roomNameOf('archive'))}</b><span class="hint">a shelf per client and per venture · newest first · Open where the row carries a link · Esc closes</span></div>` +
    (!d && archiveLoading ? '<div class="note">reading the shelves…</div>' : !d ? '<div class="note">the sidecar did not answer — is ./dev.sh running?</div>' : '') +
    `<div class="cols wide">${(d?.shelves || []).map(shelfHtml).join('')}</div>` +
    `<div class="foot">${d?.at ? 'as of ' + esc(new Date(d.at).toLocaleTimeString()) : ''} · Deliverables = every registered artifact in the ledger window; settled Decisions = Status Active${Object.values(d?.missing || {}).length ? ' · skipped: ' + esc(Object.values(d.missing).join(' · ')) : ''}</div>`
  room.classList.add('on')
}
async function openArchive(force = false) {
  renderArchive()
  if (archiveLoading || (!force && archiveData && Date.now() - archiveAt < 5 * 60_000)) return
  archiveLoading = true
  renderArchive()
  const d = await loadArchive()
  archiveLoading = false
  if (d) {
    archiveData = d
    archiveAt = Date.now()
  }
  renderArchive()
}
/** The project fixture's Archive tab: the shelf scoped to the project, plus its milestones. */
async function projectArchive(projectId) {
  if (!archiveData || Date.now() - archiveAt > 5 * 60_000) {
    const d = await loadArchive()
    if (d) { archiveData = d; archiveAt = Date.now() }
  }
  return projectTab(archiveData?.byProject?.[String(projectId || '').replace(/-/g, '')] || null)
}
window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    if (e.key === 'r' || e.key === 'R') openRoom('board-room')
    else if (e.key === 'Escape' && roomOpen) {
      e.stopPropagation()
      openRoom(roomOpen)
    } else if (e.key === 'Escape' && townOpen) {
      e.stopPropagation()
      openTown(townOpen)
    }
  },
  true
)
setInterval(() => roomOpen && refreshRoom(true), 60_000) // the sidecar's caches decide the cost; the panel never holds a stale copy of its own
setInterval(() => (roomOpen || townOpen) && refreshSpend(true).then(() => (townOpen ? renderTown() : roomOpen && roomOpen !== 'archive' && renderRoom())), 60_000)
// a console handle for the verifier and the checks: open a room by id, read what is open. No state, no write.
window.agentWorld = Object.assign(window.agentWorld || {}, { openRoom, roomOpen: () => roomOpen, rooms: () => roomsOf().map((r) => r.id), refresh: () => refreshRoom(true), openTown, townOpen: () => townOpen, spend: () => spendSummary(spendFold), refreshSpend: () => refreshSpend(true).then(() => spendSummary(spendFold)), openPa, paOpen: () => pa.open })
// a click on a room plot (no figure under the pointer) opens its panel — the hex under the pointer against the rooms' cells
let downAt = null
window.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY } }, true)
window.addEventListener(
  'pointerup',
  (e) => {
    const bc = window.botCrossing
    if (!downAt || !bc?.rig || !bc.colony) return
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
    downAt = null
    if (moved > 4 || !(e.target instanceof HTMLCanvasElement)) return
    const ast = bc.colony.astronauts
    if (ast?.hoverRing?.visible) return // a figure is under the pointer: Bot Crossing selects it
    const p = new (bc.rig.target.constructor)()
    if (!bc.rig.groundPoint(e.clientX, e.clientY, p)) return
    const cell = worldToHex(p.x, p.z)
    const cellKey = `${cell.q},${cell.r}`
    const hit = [...bc.colony.plots.values()].find((plot) => plot.cellKeys?.has(cellKey)) || [...quiet.values()].find((q) => q.plot.cellKeys?.has(cellKey))?.plot
    if (!hit) return
    const roomHit = roomsOf().find((r) => r.name === hit.name)
    if (roomHit) return openRoom(roomHit.id)
    // U35: a town plot opens the town card (the quiet towns are the overlay's own plots — same cells, same click)
    if (townsHere().some((t) => t.name === hit.name)) openTown(hit.name)
  },
  true
)

// ── U20 → U29: prospect plots are retired (ES-6.4). Prospects are rows with a warmth column in the strategy
// room panel; the Pipeline rows still ride with GET /world for that panel. Nothing stands on the campus edge.

// ── U17: signals ─────────────────────────────────────────────────────────────────────────────

const BUBBLE_Y = 2.35 // the badge floats at 1.52 (src/agents/astronauts.js); bubbles and hands sit above it
/** Suits: the figure's suit tint is the skill's trust status. Re-applied after every roster (a status change resets nothing here, but a new agent arrives white). */
function syncSuits() {
  const bc = window.botCrossing
  const byId = bc?.colony?.astronauts?.byId
  if (!byId) return
  const threads = new Map((bc.threads || []).map((t) => [t.id, t]))
  for (const [id, agent] of byId) {
    const t = threads.get(id) || agent.thread
    const hex = suitFor(t?.trust).hex
    if (agent.suit !== hex) {
      agent.suit = hex
      agent.colorDirty = true
    }
  }
}

/** Markers: a name plate above a point — ✋ over a resident, ! over the campus, ✓ over a town. */
const markers = new Map() // key → { mesh, text, follow: agent id | null }
let markerGroup = null
function ensureMarkerGroup(colony) {
  const THREE_GROUP = colony.plotGroup?.constructor
  if (!THREE_GROUP) return null
  if (!markerGroup) {
    markerGroup = new THREE_GROUP()
    markerGroup.name = 'aw:signals'
    colony.scene.add(markerGroup)
  }
  return markerGroup
}
const MARKER_LIFT = { check: 0.55 } // a ✓ plate rides above a ⚒ plate on a fixture that wears both
function wantMarker(colony, key, text, accent, at, follow = null) {
  const have = markers.get(key)
  if (have && have.text === text) {
    if (at) have.mesh.position.set(at.x, at.y, at.z)
    return
  }
  if (have) {
    markerGroup.remove(have.mesh)
    have.mesh.userData?.dispose?.()
  }
  try {
    const mesh = createLabel(text, accent)
    mesh.renderOrder = 9
    mesh.visible = true
    mesh.material.opacity = 0.95
    if (at) mesh.position.set(at.x, at.y, at.z)
    markerGroup.add(mesh)
    markers.set(key, { mesh, text, follow, lift: MARKER_LIFT[key.split(':')[0]] || 0 })
  } catch (err) {
    console.warn('[world] marker not drawn:', key, err?.message || err)
  }
}
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
const plotAnchor = (colony, name) => {
  const plot = colony.plots.get(name) || quiet.get(name)?.plot
  return plot?.labelAnchor || plot?.middle || null
}

/**
 * M2b (ES-6.2): the marks a fixture wears are static — "⚒ n running" while a run on that project is live, "✓ milestone
 * done" for 24 h after a milestone flips Done — drawn as plates over the fixture's figure. Nothing flashes; the mark is
 * there or it is not. (U17's ✋ residents, the campus flag and the town ✓ are gone: a hand is a tray line and a dusty
 * row, a ! is a request standing in a room, a ✓ lives on the fixture.)
 */
function syncSignals() {
  const bc = window.botCrossing
  const colony = bc?.colony
  if (!colony?.scene || !colony.plots) return
  if (!ensureMarkerGroup(colony)) return
  const wanted = new Set()
  for (const t of bc.threads || []) {
    if (t.kind !== 'fixture' || !colony.astronauts?.byId?.has(t.id)) continue
    if (t.runningCount) {
      wanted.add(`work:${t.id}`)
      wantMarker(colony, `work:${t.id}`, `⚒ ${t.runningCount} running`, cssVar('--aw-work', '#7fd39a'), null, t.id)
    }
    if (t.check) {
      wanted.add(`check:${t.id}`)
      wantMarker(colony, `check:${t.id}`, '✓ milestone done', cssVar('--aw-done', '#e6c67f'), null, t.id)
    }
  }
  for (const [key, mk] of markers) {
    if (wanted.has(key)) continue
    markerGroup.remove(mk.mesh)
    mk.mesh.userData?.dispose?.()
    markers.delete(key)
  }
}
/**
 * Fixtures are still (ES-6.2). Bot Crossing's idle pose potters around the plot; a fixture has arrived and stays:
 * its wander target is its own site and the next wander never comes due. Renderer limit reported, not fought:
 * the figure still breathes (the idle clip) — src is untouched.
 */
function pinFixtures() {
  const bc = window.botCrossing
  const byId = bc?.colony?.astronauts?.byId
  if (!byId) return
  const fixtures = new Set((bc.threads || []).filter((t) => t.kind === 'fixture').map((t) => t.id))
  for (const [id, agent] of byId) {
    if (!fixtures.has(id) || !agent.site || !agent.wander) continue
    // from the first frame: the wander target is the site itself, so the arrival settles and no drift leg is ever taken
    agent.wander.copy(agent.site)
    agent.wanderAt = Infinity
    if (agent.state === 'at-site') agent.vel?.set?.(0, 0, 0)
  }
}
/** The strip (ES-6.5): need you · blocked · running · shipped today, over the HUD's own count pills. */
let strip = null
let stripHtml = ''
function syncStrip() {
  const bc = window.botCrossing
  const stats = document.querySelector('.hud .stats')
  if (!stats) return
  if (!strip) {
    strip = document.createElement('div')
    strip.id = 'aw-strip'
    stats.appendChild(strip)
  }
  const threads = bc?.threads || []
  const sig = signals()
  const c = sig.counts || { needYou: threads.filter((t) => t.kind === 'request' && t.unread).length, blocked: threads.filter((t) => t.kind === 'request' && t.hasError).length, running: 0, shippedToday: 0 }
  const pills = [
    ['wait', c.needYou, 'need you', 'N flies to the next request'],
    ['block', c.blocked, 'blocked', 'failed runs inside 24 h and open findings'],
    ['work', c.running, 'running', 'live runs — counted on their project fixtures, never a figure'],
    ['done', c.shippedToday, 'shipped today', 'runs completed since midnight'],
  ]
  // U37 — when Compass is not answering, say so first: the counts beside it are the last ones the world saw.
  const down = compassNotice(sig.compass)
  const html =
    (down ? `<div class="pill down" data-key="down" title="${esc(down.title)}"><i></i><b>${esc(down.label)}</b><span>${esc(down.detail)}</span></div>` : '') +
    pills.map(([cls, n, label, title]) => `<div class="pill ${cls}" data-key="${cls}" data-empty="${!n}" title="${esc(title)}"><i></i><b>${n}</b><span>${label}</span></div>`).join('')
  // Compared with what was last written, not with innerHTML: the browser serialises an escaped quote back unescaped,
  // so innerHTML never equals the escaped string and the strip — tooltip and all — would be rebuilt every second.
  if (stripHtml !== html) {
    stripHtml = html
    strip.innerHTML = html
    strip.querySelector('.pill.wait')?.addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' })))
    strip.querySelector('.pill.block')?.addEventListener('click', () => {
      const row = trayRows().find((r) => r.badge === '!')
      if (row) window.botCrossing?.hud?.actions?.focusThread?.(row.id)
    })
  }
}
setInterval(pinFixtures, 250)
setInterval(syncStrip, 1000)

// ── U30: three altitudes ─────────────────────────────────────────────────────────────────────
//
// The camera's distance (Bot Crossing's rig.distance — readable through the handle, so no O fallback is needed)
// against the pack's lod: at orbit only place plates (name · ? n · ⚒ n) show — no thread labels, no card, no
// bubbles; at district a request's title floats over its figure always and a fixture's on hover or selection;
// at desk (a selection flies to ≤ 26) the panel. H flies to the corner office; a fresh load opens there.
const altEl = el('aw-alt')
const plates = new Map() // plot name → { mesh, text }
let plateGroup = null
const titleLabels = new Map() // thread id → { mesh, text }
let titleGroup = null
/** The hovered figure: main.js keeps hoverId to itself, but the hover ring it moves is on the handle — the nearest agent to it is the one under the pointer. */
const hoveredId = () => {
  const ast = window.botCrossing?.colony?.astronauts
  const ring = ast?.hoverRing
  if (!ring?.visible) return null
  let best = null
  let bestD = 0.5
  for (const a of ast.agents || []) {
    const d = Math.hypot(a.pos.x - ring.position.x, a.pos.z - ring.position.z)
    if (d < bestD) { bestD = d; best = a.id }
  }
  return best
}

function syncAltitude() {
  const bc = window.botCrossing
  const colony = bc?.colony
  if (!colony?.scene || !bc.rig) return
  const THREE_GROUP = colony.plotGroup?.constructor
  if (!THREE_GROUP) return
  const lod = lodNow()
  const next = altitudeOf(bc.rig.distance, lod)
  if (next !== altitude) {
    altitude = next
    document.documentElement.dataset.awAltitude = altitude
  }
  altEl.textContent = `${altitude} · camera ${Math.round(bc.rig.distance)} · orbit above ${lod.orbit} · desk below ${lod.desk} · O orbit · H home`
  const show = Boolean(colony.uiVisible ?? true)
  // Bot Crossing's own zone name plates (src draws them for active plots at any distance) and the overlay's quiet-town
  // plates give way to the place plates at orbit: src only ever sets labelGroup.visible back to true when the UI is shown.
  if (colony.labelGroup) colony.labelGroup.visible = altitude !== 'orbit' && show
  for (const { label } of quiet.values()) if (altitude === 'orbit') label.visible = false
  // place plates: one per plot (rooms, towns, quiet towns), at orbit only
  if (!plateGroup) {
    plateGroup = new THREE_GROUP()
    plateGroup.name = 'aw:plates'
    colony.scene.add(plateGroup)
  }
  const counts = placeCounts(bc.threads || [])
  const wantedPlates = new Set()
  const anchors = new Map()
  for (const plot of colony.plots.values()) anchors.set(plot.name, plot.labelAnchor || plot.middle || plot.center)
  for (const [name, q] of quiet) anchors.set(name, q.plot.labelAnchor || q.plot.middle || q.plot.center)
  for (const [name, a] of anchors) {
    if (!a) continue
    const text = plateText(name, counts.get(name) || {})
    wantedPlates.add(name)
    const have = plates.get(name)
    if (have && have.text === text) {
      have.mesh.visible = altitude === 'orbit' && show
      continue
    }
    if (have) {
      plateGroup.remove(have.mesh)
      have.mesh.userData?.dispose?.()
    }
    try {
      const mesh = createLabel(text, cssVar('--aw-ink', '#e6e9ef'))
      mesh.renderOrder = 10
      mesh.material.opacity = 0.95
      mesh.position.set(a.x, 4.4, a.z)
      mesh.visible = altitude === 'orbit' && show
      plateGroup.add(mesh)
      plates.set(name, { mesh, text })
    } catch (err) {
      console.warn('[world] plate not drawn:', name, err?.message || err)
    }
  }
  for (const [name, p] of plates) {
    if (wantedPlates.has(name)) continue
    plateGroup.remove(p.mesh)
    p.mesh.userData?.dispose?.()
    plates.delete(name)
  }
  // thread title labels: requests always at district; fixtures on hover or selection; nothing at orbit
  if (!titleGroup) {
    titleGroup = new THREE_GROUP()
    titleGroup.name = 'aw:titles'
    colony.scene.add(titleGroup)
  }
  const sel = colony.astronauts?.selected?.id || null
  const hov = hoveredId()
  const wantedTitles = new Set()
  for (const t of bc.threads || []) {
    const agent = colony.astronauts?.byId?.get(t.id)
    if (!agent) continue
    const rule = labelRule(bc.rig.distance, lod, t, { hovered: hov === t.id, selected: sel === t.id })
    if (!rule.label) continue
    wantedTitles.add(t.id)
    const have = titleLabels.get(t.id)
    if (have && have.text === t.title) continue
    if (have) {
      titleGroup.remove(have.mesh)
      have.mesh.userData?.dispose?.()
    }
    try {
      const mesh = createLabel(t.title, cssVar(t.kind === 'request' ? (t.hasError ? '--aw-block' : '--aw-wait') : '--aw-quiet', '#e6e9ef'))
      mesh.renderOrder = 9
      mesh.material.opacity = 0.92
      mesh.visible = true
      if (agent.pos) mesh.position.set(agent.pos.x, agent.pos.y + BUBBLE_Y + 0.55, agent.pos.z)
      titleGroup.add(mesh)
      titleLabels.set(t.id, { mesh, text: t.title })
    } catch (err) {
      console.warn('[world] title not drawn:', t.id, err?.message || err)
    }
  }
  for (const [id, l] of titleLabels) {
    if (wantedTitles.has(id)) continue
    titleGroup.remove(l.mesh)
    l.mesh.userData?.dispose?.()
    titleLabels.delete(id)
  }
  // bubbles and marks follow the rule too: none at orbit
  if (bubbleGroup) bubbleGroup.visible = altitude !== 'orbit'
  if (markerGroup) markerGroup.visible = altitude !== 'orbit'
  if (altitude === 'orbit' && colony.astronauts?.selected) {
    // a selection's card and panel are district things: nothing is selected at orbit
    bc.hud?.actions?.select?.(null)
  }
}
function followTitles() {
  const colony = window.botCrossing?.colony
  if (colony?.astronauts && titleLabels.size) {
    const show = Boolean(colony.uiVisible ?? true)
    for (const [id, l] of titleLabels) {
      const agent = colony.astronauts.byId?.get(id)
      if (!agent) continue
      l.mesh.position.set(agent.pos.x, agent.pos.y + BUBBLE_Y + 0.55, agent.pos.z)
      l.mesh.visible = show
    }
  }
  requestAnimationFrame(followTitles)
}
requestAnimationFrame(followTitles)
setInterval(syncAltitude, 200)

/** H: fly to the corner office (Bot Crossing's own H — hide the UI — is shadowed; ⌘\ still does that). */
function flyHome() {
  const bc = window.botCrossing
  if (!bc?.rig || !bc.colony) return false
  const home = homeTarget(getWorld()?.rooms || [], bc.colony.plots)
  bc.rig.setOrbit?.(false)
  bc.rig.focus({ x: home.point.x, y: 0, z: home.point.z }, { distance: homeDistance(lodNow()) })
  return true
}
/** O: to the orbit altitude and back (V-U30 "zoom out to orbit (or press O)"). Bot Crossing's O — the slow sweep — is shadowed; its rail button still sweeps. */
let beforeOrbit = 0
function toggleOrbitAltitude() {
  const bc = window.botCrossing
  if (!bc?.rig) return
  const lod = lodNow()
  if (altitudeOf(bc.rig.desiredDistance, lod) === 'orbit') {
    bc.rig.desiredDistance = beforeOrbit || 62
  } else {
    beforeOrbit = bc.rig.desiredDistance
    bc.rig.desiredDistance = Math.min(150, lod.orbit + 15)
  }
  bc.rig.idleFor = 99
}
window.addEventListener(
  'keydown',
  (e) => {
    const k = e.key
    if (k !== 'h' && k !== 'H' && k !== 'o' && k !== 'O') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    e.stopPropagation()
    e.preventDefault()
    if (k === 'o' || k === 'O') return toggleOrbitAltitude()
    if (flyHome()) toast(`Home — the ${homeTarget(getWorld()?.rooms || [], window.botCrossing?.colony?.plots).name || 'corner office'}`)
  },
  true
)
// a fresh load opens on the corner office: as soon as the world and the plots exist, once
let homed = false
const homeOnLoad = setInterval(() => {
  if (homed) return clearInterval(homeOnLoad)
  const bc = window.botCrossing
  if (!bc?.colony?.plots?.size || !getWorld()) return
  homed = flyHome()
}, 500)
function followMarkers() {
  const colony = window.botCrossing?.colony
  if (colony?.astronauts && markers.size) {
    const show = Boolean(colony.uiVisible ?? true)
    for (const mk of markers.values()) {
      if (mk.follow) {
        const agent = colony.astronauts.byId?.get(mk.follow)
        if (agent) mk.mesh.position.set(agent.pos.x, agent.pos.y + BUBBLE_Y + (mk.lift || 0), agent.pos.z)
      }
      mk.mesh.visible = show
    }
  }
  requestAnimationFrame(followMarkers)
}
requestAnimationFrame(followMarkers)
setInterval(() => {
  syncSuits()
  syncSignals()
}, 1000)

// Sound: a cue on a NEW ? or ! since the last roster; M mutes, remembered as a render setting in the colony file.
const cues = {
  question: new Audio(new URL('./sounds/question.wav', import.meta.url).href),
  alert: new Audio(new URL('./sounds/alert.wav', import.meta.url).href),
}
for (const a of Object.values(cues)) a.volume = 0.5
const diff = new SignalDiff()
const muted = () => Boolean(window.botCrossing?.settings?.get(AW_MUTED))
let lastSoundRoster = null
setInterval(() => {
  const bc = window.botCrossing
  if (!bc?.threads || bc.threads === lastSoundRoster || !bc.threads.length) return // the empty roster before the first poll primes nothing: the world opening is not an event
  lastSoundRoster = bc.threads
  const d = diff.update(bc.threads)
  if (muted()) return
  const cue = d.alert.length ? cues.alert : d.question.length ? cues.question : null
  if (cue) cue.play().catch(() => {}) // autoplay policy: silent until the page has been clicked once
}, 250)
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'm' && e.key !== 'M') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    const settings = window.botCrossing?.settings
    if (!settings) return
    const next = !settings.get(AW_MUTED)
    settings.set(AW_MUTED, next)
    toast(next ? 'Sound off — saved with your render settings' : 'Sound on')
  },
  true
)

// ── U14: the in-tray ─────────────────────────────────────────────────────────────────────────

let trayOpen = false
let lastTray = ''
const selectedId = () => window.botCrossing?.colony?.astronauts?.selected?.id || null
/** The rows N can land on: those with a figure on this planet's map (the roster caps at maxAgents). */
const trayRows = () => {
  const bc = window.botCrossing
  const byId = bc?.colony?.astronauts?.byId
  return intrayRows(bc?.threads || []).filter((r) => !byId || byId.has(r.id))
}

function renderTray(force = false) {
  if (!trayOpen) {
    tray.classList.remove('on')
    lastTray = ''
    return
  }
  const requests = trayRows()
  // U33 (ES-6.8): a wanted silent skill is a line after every request — dusty in its room, never a figure, never N's
  const rows = withHands(requests, signals().dusty || [])
  const sel = selectedId()
  const key = rows.map((r) => `${r.id}:${r.at}:${r.what}:${approvals.state(r.id, r.gate, r.url)}`).join('|') + '~' + sel
  if (!force && key === lastTray) return
  lastTray = key
  tray.innerHTML =
    `<div class="h"><b>In-tray · ${requests.length} request${requests.length === 1 ? '' : 's'}${requests.some((r) => r.badge === '!') ? ` · ${requests.filter((r) => r.badge === '?').length} need you · ${requests.filter((r) => r.badge === '!').length} blocked` : ' waiting on you'}${rows.length > requests.length ? ` · ${rows.length - requests.length} hand${rows.length - requests.length === 1 ? '' : 's'}` : ''}</b><span class="hint">N walks the requests · I closes</span></div>` +
    (rows.length
      ? rows
          .map(
            (r) => `<div class="r${r.id === sel ? ' sel' : ''}${r.hand ? ' hand' : ''}" data-id="${esc(r.id)}"><span class="q${r.hand ? ' dusty' : r.badge === '!' ? ' err' : approvals.state(r.id, r.gate, r.url) === '⏳' ? ' wait' : ''}" title="${r.hand ? 'silent 30 d and wanted — a dusty row in its room, never a figure' : r.badge === '!' ? 'failed — nothing to tap; retry where it ran' : approvals.state(r.id, r.gate, r.url) === '⏳' ? 'waiting for the surface to show the tap' : 'waiting on you'}">${r.hand ? '✋' : r.badge === '!' ? '!' : approvals.glyph(r.id, r.gate, r.url)}</span>
            <span class="m"><div class="s">${esc(r.skill)} <span class="z">· ${esc(r.zone)}</span></div>
            <div class="g">${esc(r.gate)}${r.left > 1 ? ` (${r.left} left)` : ''} — ${esc(r.what)}${approvals.state(r.id, r.gate, r.url) === 'not seen yet' ? ' <span class="ns">· not seen yet</span>' : ''}</div></span>
            <span class="age" title="oldest open gate">${esc(ago(r.at))}</span>${r.url ? `<button data-approve="${esc(r.id)}">Approve</button>` : ''}</div>`
          )
          .join('')
      : '<div class="empty">Nothing is waiting on you.</div>')
  tray.classList.add('on')
  tray.querySelectorAll('.r').forEach((row) =>
    row.addEventListener('click', () => {
      if (row.classList.contains('hand')) return openRoom(roomsOf().find((r) => r.name === rows.find((x) => x.id === row.dataset.id)?.zone)?.id || 'records-office')
      window.botCrossing?.hud?.actions?.focusThread?.(row.dataset.id)
      renderTray(true)
    })
  )
  tray.querySelectorAll('button[data-approve]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      approve(rows.find((r) => r.id === b.dataset.approve))
    })
  )
}

// ── U15: Approve ─────────────────────────────────────────────────────────────────────────────
const approvals = new ApproveTracker()

/** Show the instruction and the surface's name; "Open the surface" takes the human there. No write, ever. */
function approve(row) {
  const it = approveIntent(row)
  if (!it) {
    toast('This gate has no surface to open')
    return
  }
  window.botCrossing?.hud?.actions?.focusThread?.(it.id)
  intent.innerHTML = `<b>Approve · ${esc(it.gate)}</b><div class="sf">${esc(it.surface)}</div><div>${esc(it.what)}</div>
    <div class="row"><button class="ghost" id="aw-intent-no">Not now</button><button id="aw-intent-go">Open the surface ↗</button></div>`
  intent.classList.add('on')
  intent.querySelector('#aw-intent-no').addEventListener('click', () => intent.classList.remove('on'))
  intent.querySelector('#aw-intent-go').addEventListener('click', () => {
    intent.classList.remove('on')
    approvals.mark(it.id, it.gate, it.url)
    window.open(it.url, '_blank', 'noopener')
    renderTray(true)
    lastKey = '' // the card re-renders with the ⏳
  })
}
// One tick per poll: the roster's own timestamp changes when a poll lands (threads are a new array each time).
let lastRosterRef = null
setInterval(() => {
  const bc = window.botCrossing
  if (!bc) return
  const ref = bc.threads
  if (ref === lastRosterRef) return
  lastRosterRef = ref
  approvals.update(intrayRows(ref || []), Date.now(), Date.now())
}, 250)
setInterval(() => renderTray(), 500)

// I toggles the tray; N is taken over: the row after the selected one, in the tray's order, wrapping.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    if (e.key === 'i' || e.key === 'I') {
      trayOpen = !trayOpen
      renderTray(true)
      return
    }
    if (e.key !== 'n' && e.key !== 'N') return
    e.stopPropagation()
    e.preventDefault()
    const rows = trayRows()
    const row = nextRow(rows, selectedId())
    if (!row) {
      toast('Nobody is waiting on you right now')
      return
    }
    window.botCrossing?.hud?.actions?.focusThread?.(row.id)
    renderTray(true)
  },
  true
)

// ── U13: artifact bubbles ────────────────────────────────────────────────────────────────────
//
// A speech bubble over the agent whose run just left an artifact: a name plate (the same kind the
// zones wear) drawn above the badge, following the figure, for BUBBLE_MS after the artifact is new.
// Which agents bubble is decided in overlay/artifacts.mjs from the roster alone — no second data path.
const bubbles = new Map() // thread id → { mesh, title }
const tracker = new BubbleTracker()
let bubbleGroup = null
// (BUBBLE_Y is declared with the signals above: the bubble and the ✋ share the height over the badge)

function syncBubbles() {
  const bc = window.botCrossing
  const colony = bc?.colony
  if (!colony?.scene || !colony.astronauts) return
  const THREE_GROUP = colony.plotGroup?.constructor
  if (!THREE_GROUP) return
  if (!bubbleGroup) {
    bubbleGroup = new THREE_GROUP()
    bubbleGroup.name = 'aw:bubbles'
    colony.scene.add(bubbleGroup)
  }
  // U32 (ES-6.7): a bubble only on a request whose run has an open gate; an artifact without a gate is shelf-only
  const active = tracker.update((bc.threads || []).filter(bubbleEligible))
  for (const [id, b] of bubbles) {
    if (active.has(id) && colony.astronauts.byId?.has(id)) continue
    bubbleGroup.remove(b.mesh)
    b.mesh.userData?.dispose?.()
    bubbles.delete(id)
  }
  for (const [id, info] of active) {
    if (bubbles.has(id) || !colony.astronauts.byId?.has(id)) continue
    const text = `💬 ${info.title.length > 34 ? info.title.slice(0, 33) + '…' : info.title}`
    try {
      const mesh = createLabel(text, getComputedStyle(document.documentElement).getPropertyValue('--aw-done').trim() || '#e6c67f')
      mesh.renderOrder = 9
      mesh.visible = true
      mesh.material.opacity = 0.95
      bubbleGroup.add(mesh)
      bubbles.set(id, { mesh, title: info.title })
    } catch (err) {
      console.warn('[world] bubble not drawn:', id, err?.message || err)
    }
  }
}
function followBubbles() {
  const colony = window.botCrossing?.colony
  if (colony?.astronauts && bubbles.size) {
    const show = Boolean(colony.uiVisible ?? true)
    for (const [id, b] of bubbles) {
      const agent = colony.astronauts.byId?.get(id)
      if (!agent) continue
      b.mesh.position.set(agent.pos.x, agent.pos.y + BUBBLE_Y, agent.pos.z)
      b.mesh.visible = show
    }
  }
  requestAnimationFrame(followBubbles)
}
requestAnimationFrame(followBubbles)
setInterval(syncBubbles, 1000)

// ── U12: planets, pack, quiet towns ───────────────────────────────────────────────────────────

/** The switcher: one button per company from Compass; the pressed one is the planet on screen. */
function renderSwitcher() {
  const world = getWorld()
  if (!world || world.planets.length < 1) return
  const here = currentPlanet()
  switcher.innerHTML =
    `<span class="k">${esc(noun('planet'))}</span>` +
    world.planets
      .map((p) => `<button data-key="${esc(p.key)}" aria-pressed="${p.key === currentKey()}" class="${p.hasSubstrate ? '' : 'empty'}" title="${esc(p.hasSubstrate ? `${p.role} · ${p.pack}` : 'no substrate yet')}">${esc(p.name)}</button>`)
      .join('') +
    `<span class="pack" title="World Pack this planet wears (from Compass)">${esc(here?.pack || '')}</span>` +
    `<span class="est" id="aw-planet-est" hidden></span>` +
    `<button id="aw-room-btn" title="the board room · R (every room opens on a click on its plot)">${esc(roomNameOf('board-room'))}</button>`
  switcher.querySelectorAll('button[data-key]').forEach((b) => b.addEventListener('click', () => switchTo(b.dataset.key)))
  switcher.querySelector('#aw-room-btn')?.addEventListener('click', () => openRoom('board-room'))
  switcher.classList.add('on')
  syncPlanetEst()
}
/** U36: the planet's own estimate line (totals.est) beside the pack name — Owner-only, pack-gated, hidden when there is none. */
function syncPlanetEst() {
  const el = switcher.querySelector('#aw-planet-est')
  if (!el) return
  const line = spendAllowed() && spendFold && !spendFold.error ? estLineFor(spendFold.planet, { viewer: getWorld()?.viewer, pack: pack(), fold: spendFold }) : ''
  el.textContent = line
  el.title = line ? `${noun('planet')} · ${EST_TITLE()}` : ''
  el.hidden = !line
}

/** An empty planet: its name and "no substrate yet". No runs, no towns, no reads happened for it. */
function renderEmpty() {
  const here = currentPlanet()
  if (!here || here.hasSubstrate) {
    empty.classList.remove('on')
    return
  }
  empty.innerHTML = `<div class="name">${esc(here.name)}</div><div class="sub">no substrate yet</div>`
  empty.classList.add('on')
}

/**
 * Quiet towns — an Active client with no run in the window still is a town (ES-4.1). Bot Crossing
 * makes a plot only where a thread stands, so the overlay lays the deck and the name plate itself,
 * on cells its own allocator hands out around the plots that exist, and remembers the cells in the
 * colony's layout memory: the layout file carries them, and the day a run arrives for that client
 * the game's plot lands on the same ground and this one steps aside.
 */
const quiet = new Map() // town name → { plot, label, signature }
let quietGroup = null

/**
 * createLabel hands back a plate that is hidden until the colony fades it in, and the colony only
 * fades in plots of its own. A quiet town has nothing going on, so its name is the whole point:
 * the plate stays on, dimmer than a live zone's, and follows H (hide UI) and the labels setting.
 */
function syncQuietLabels() {
  if (!quiet.size) return
  const colony = window.botCrossing?.colony
  const show = Boolean(colony?.uiVisible ?? true) && (colony?.settings?.get?.('showLabels') ?? true)
  for (const { label } of quiet.values()) {
    label.material.opacity = show ? 0.85 : 0
    label.visible = show
  }
}
function syncQuietTowns() {
  const bc = window.botCrossing
  const colony = bc?.colony
  if (!colony?.plots || !colony.plotCells || !colony.scene) return
  const THREE_GROUP = colony.plotGroup?.constructor
  if (!THREE_GROUP) return
  if (!quietGroup) {
    quietGroup = new THREE_GROUP()
    quietGroup.name = 'aw:quiet-towns'
    colony.scene.add(quietGroup)
  }
  const towns = townsHere().map((t) => t.name).filter((name) => !colony.plots.has(name))
  const wanted = new Set(towns)

  // Towns that gained a real plot, or vanished from the substrate, give their ground back.
  for (const [name, entry] of quiet) {
    if (wanted.has(name)) continue
    quietGroup.remove(entry.plot.group, entry.label)
    entry.label.userData?.dispose?.()
    entry.plot.dispose?.()
    quiet.delete(name)
  }
  if (!towns.length) return

  // The same input Bot Crossing gives its allocator — each plot's live thread count, which the
  // allocator turns into cells — so every real plot keeps exactly its cells and the quiet towns
  // take the innermost ground that is genuinely free. (Passing cell counts here made the campus
  // look smaller than it is and put a quiet deck on a cell it already held.)
  // U29: a quiet town stands on the cells the generated layout gave it (the colony's layout memory carries the file's
  // plots); a town the file does not know yet takes the next free spoke slot — the same slot the generator would give
  // it at the next restart — never the innermost free cell (ring 3 stays empty). Bot Crossing's own allocator is not asked.
  const known = {}
  for (const [name, cells] of colony.plotCells) known[name] = cells.map((c) => [c.q, c.r])
  const layout = new Map()
  for (const name of towns) {
    const have = colony.plotCells.get(name)
    if (have?.length) {
      layout.set(name, have.map((c) => ({ q: c.q, r: c.r })))
      continue
    }
    const slot = nextTownSlot(pack(), known)
    if (!slot) continue
    known[name] = [[slot.q, slot.r]]
    layout.set(name, [slot])
  }
  for (const name of towns) {
    const cells = layout.get(name)
    if (!cells?.length) continue
    const signature = cells.map((c) => `${c.q},${c.r}`).join('/')
    const have = quiet.get(name)
    if (have?.signature === signature) continue
    if (have) {
      quietGroup.remove(have.plot.group, have.label)
      have.plot.dispose?.()
    }
    // Remembered in the colony's own layout memory, so the file learns it on the next save.
    colony.plotCells.set(name, cells.map((c) => ({ q: c.q, r: c.r })))
    for (const c of cells) colony.deckedCells?.add(`${c.q},${c.r}`)
    const accent = PLOT_PALETTE[hashString(name) % PLOT_PALETTE.length]
    try {
      const plot = new Plot({ id: `quiet:${name}`, name, index: colony.plots.size + quiet.size, cells, accent })
      const label = createLabel(name, accent)
      label.position.set(plot.labelAnchor.x, 3.2, plot.labelAnchor.z)
      quietGroup.add(plot.group, label)
      quiet.set(name, { plot, label, signature })
    } catch (err) {
      console.warn('[world] quiet town not drawn:', name, err?.message || err)
    }
  }
}

function dressWorld() {
  const here = currentPlanet()
  wear(here?.pack || getWorld()?.viewer?.pack || '')
  document.title = here ? `${here.name} · ${pack().title}` : document.title
  renderSwitcher()
  refoldSpend() // U36: the planet's estimate line on arrival, and the fold re-cut for the planet on screen after a switch
  renderEmpty()
}
onWorldLate(dressWorld)
ready.then(() => {
  dressWorld()
  const here = currentPlanet()
  if (!isHome() && here?.hasSubstrate) console.info(`[world] on ${here.name} — layout ${here.colonyFile}`)
  // Quiet towns follow the roster: after every poll the plots may have changed.
  let lastRoster = ''
  setInterval(() => {
    const bc = window.botCrossing
    if (!bc?.colony) return
    const key = `${(bc.threads || []).length}|${bc.colony.plots?.size || 0}|${townsHere().length}`
    if (key === lastRoster && quiet.size === townsHere().filter((t) => !bc.colony.plots.has(t.name)).length) return
    lastRoster = key
    syncQuietTowns()
  }, 1000)
})
