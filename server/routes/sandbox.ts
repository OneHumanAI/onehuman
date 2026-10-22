// SPDX-License-Identifier: BUSL-1.1
/**
 * Sandbox: a labelled dataset of pointer trajectories (human vs agent) for tuning the
 * kinematics judge. No session or room is involved; the page posts one sample per click.
 * Labels are supplied by whoever runs the sandbox and are stored as given — they are
 * training/evaluation data, never classifier input for real sessions.
 */
import type { OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, url, type Req, type Res } from '../http.ts';
import { clickFeatures, judgeClick, KINEMATICS_VERSION } from '../kinematics.ts';
import { parseEarly, parseInteraction, type InteractionSample } from '../signals.ts';
import { assess } from '../assess.ts';
import { siteOf } from '../site-db.ts';

const CLIENT = /^[a-z0-9-]{8,40}$/;
const LABELS = new Set(['human', 'agent', 'unknown']);
const SHORT = /^[a-z0-9_.-]{1,40}$/i;

export function sandboxRoutes(engine: OneHuman) {
  const store = siteOf(engine.store);

  const addSample = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const body = (await readJson(req, 24000).catch(() => null)) as Record<string, unknown> | null | undefined;
    if (!body) return json(res, 400, { error: 'bad_body' });
    const client = typeof body.client === 'string' && CLIENT.test(body.client) ? body.client : null;
    const label = typeof body.label === 'string' && LABELS.has(body.label) ? body.label : null;
    const source = typeof body.source === 'string' && SHORT.test(body.source) ? body.source : 'unspecified';
    const task = typeof body.task === 'string' && SHORT.test(body.task) ? body.task : 'click';
    const repeatTarget = body.repeatTarget === true;
    const sample = parseInteraction({ atMs: 0, webdriver: false, click: body.click, keys: 0, keyIntervals: [], inputEvents: 0, paste: false });
    if (!client || !label || !sample?.click) return json(res, 400, { error: 'bad_sample', message: 'client, label and click are required.' });
    const c = sample.click;
    const features = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null });
    const judgement = c.pointer === 'mouse' && c.trusted ? judgeClick(features, { repeatTarget }) : { verdict: 'uncertain' as const, humanPts: 0, agentPts: 0, flags: [c.trusted ? `pointer_${c.pointer || 'none'}` : 'untrusted'] };
    // what the server itself can see about the browser: agent-app token, client hints
    const arrival = await engine.observe(req);
    const ua = `${(req.headers['user-agent'] ?? '').toString().slice(0, 200)}${arrival.environment?.agentAppToken ? ` | app=${arrival.environment.agentAppToken}` : ''}${arrival.environment?.clientHints === false ? ' | no-ch' : ''}`;
    // training context (what the page saw at the click: agent markers, focus, scroll, hover…) rides along, unparsed
    const context = body.context && typeof body.context === 'object' ? body.context : null;
    const id = await store.addSample({ client, label, source, task, ua, click: context ? { ...c, context } : c, features, verdict: judgement.verdict });
    json(res, 201, { id, version: KINEMATICS_VERSION, features, judgement });
  };

  const stats = async (req: Req, res: Res) => {
    const client = url(req).searchParams.get('client');
    const groups = await store.sampleStats();
    const mine = client && CLIENT.test(client) ? await store.clientSamples(client) : [];
    json(res, 200, { version: KINEMATICS_VERSION, groups, client: mine });
  };

  const exportSamples = async (req: Req, res: Res) => {
    const label = url(req).searchParams.get('label');
    const rows = await store.listSamples(label && LABELS.has(label) ? label : null, 5000);
    json(res, 200, { version: KINEMATICS_VERSION, count: rows.length, samples: rows });
  };

  /**
   * Replay a whole training run through the real assessment, step by step, the way the engine sees it:
   * each click is decided with the previous clicks in a sliding window (last 6, as `recentSignals` returns)
   * and the page's passive snapshot. Answers "would this person have been treated as an agent at step N, and why".
   */
  const assessRun = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const body = (await readJson(req, 400000).catch(() => null)) as Record<string, unknown> | null | undefined;
    if (!body || !Array.isArray(body.steps)) return json(res, 400, { error: 'bad_body' });
    const client = typeof body.client === 'string' && CLIENT.test(body.client) ? body.client : null;
    const label = typeof body.label === 'string' && LABELS.has(body.label) ? body.label : null;
    const source = typeof body.source === 'string' && SHORT.test(body.source) ? body.source : 'unspecified';
    if (!client || !label) return json(res, 400, { error: 'bad_run' });
    const early = body.early == null ? null : parseEarly(body.early);
    const earlyProblem = body.early != null && !early ? 'unparseable' : body.early == null ? 'missing' : null;
    const server = await engine.observe(req);
    const history: InteractionSample[] = [];
    const out: { task: string; step: number; actor: string; score: number | null; tiers: string[]; reasonCodes: string[]; click: { verdict: string; humanPts: number; agentPts: number; flags: string[] } | null }[] = [];
    let attachedMs: number | null = null;
    for (const raw of body.steps as unknown[]) {
      const st = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const sample = parseInteraction({ atMs: st.atMs ?? 0, webdriver: false, click: st.click ?? null, keys: st.keys ?? 0, keyIntervals: st.keyIntervals ?? [], inputEvents: st.inputEvents ?? 0, paste: st.paste === true });
      if (!sample) { out.push({ task: String(st.task ?? '?'), step: out.length + 1, actor: 'invalid', score: null, tiers: [], reasonCodes: ['UNPARSEABLE_STEP'], click: null }); continue; }
      // the sticky attach the engine would have recorded: a control marker or tool global in the passive snapshot
      if (attachedMs === null && early) {
        const marker = early.markers.find((m) => ['claude-stop', 'claude-cursor', 'claude-glow', 'codex-overlay'].includes(m.name));
        if (marker) attachedMs = marker.atMs;
        else if (early.environment.agentGlobals.some((g) => /^__(claudeElementMap|claudeElementReverseMap|claudeRefCounter|generateAccessibilityTree)/.test(g))) attachedMs = early.startedMs;
      }
      const a = assess({ server, early, interactions: history.slice(-6), current: sample, attachedEarlierMs: attachedMs });
      let click: (typeof out)[number]['click'] = null;
      if (sample.click?.traj && sample.click.trusted && sample.click.pointer === 'mouse') {
        const c = sample.click;
        const f = clickFeatures(c.traj!, { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null });
        const j = judgeClick(f, { repeatTarget: st.repeatTarget === true });
        click = { verdict: j.verdict, humanPts: j.humanPts, agentPts: j.agentPts, flags: j.flags };
      }
      out.push({ task: String(st.task ?? '?'), step: out.length + 1, actor: a.actor, score: a.score, tiers: a.tiers, reasonCodes: a.reasons.filter((r) => r.kind !== 'neutral' || r.code === 'INSUFFICIENT_ACTIONS').map((r) => r.code), click });
      history.push(sample);
    }
    const agentSteps = out.filter((o) => o.actor === 'agent_likely').length;
    const humanSteps = out.filter((o) => o.actor === 'human_like').length;
    const summary = { earlyProblem, steps: out.length, agentSteps, humanSteps, unknownSteps: out.length - agentSteps - humanSteps, firstHumanStep: out.findIndex((o) => o.actor === 'human_like') + 1 || null, attachedMs, markers: early?.markers.map((m) => m.name) ?? [], globals: early?.environment.agentGlobals ?? [], extensions: early?.environment.extensionsInstalled ?? [], version: KINEMATICS_VERSION };
    const ua = `${(req.headers['user-agent'] ?? '').toString().slice(0, 200)}${server.environment?.agentAppToken ? ` | app=${server.environment.agentAppToken}` : ''}`;
    const id = await store.addTrainingSession({ client, label, source, ua, early: early ?? { raw: body.early ?? null }, steps: out, summary });
    json(res, 201, { id, steps: out, summary });
  };

  return { addSample, stats, exportSamples, assessRun };
}
