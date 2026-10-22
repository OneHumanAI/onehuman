// SPDX-License-Identifier: BUSL-1.1
/**
 * Lab routes: rooms, sessions, signal ingestion, journal, benchmark, step-up
 * and the signed-request simulation.
 */
import { randomBytes } from 'node:crypto';
import type { OneHuman } from '../engine.ts';
import { publicDecision } from '../engine.ts';
import { json, readJson, sameOrigin, url, UUID, type Req, type Res } from '../http.ts';
import { sessionRoutes } from './session.ts';
import { verifyProof } from '../proof.ts';
import { verifyChain } from '../audit.ts';
import { signRequest, type OperatorKey } from '../web-bot-auth.ts';
import type { SessionRow } from '../db.ts';
import type { Connection } from '../connection.ts';
import { bus } from '../bus.ts';

/** Requests the lab sends itself (the signed-operator demo) carry this in X-OH-Lab-Simulated and are kept out of benchmarks. */
export const LAB_SIMULATION_TOKEN = randomBytes(16).toString('hex');
export const isLabSimulation = (req: Req) => req.headers['x-oh-lab-simulated'] === LAB_SIMULATION_TOKEN;

export type LabOperator = { operator: string; privateKey: CryptoKey; publicJwk: OperatorKey } | null;

export function labRoutes(engine: OneHuman, labOperator: LabOperator, opts: { roomAllowed?: (req: Req) => Promise<boolean>; deviceOf?: (req: Req) => string; explain?: boolean } = {}) {
  const store = engine.store;
  // The lab shows why (it is a lab). On a customer's site the page — and so the agent in it — learns only the outcome:
  // the evidence behind it would teach an agent what to hide.
  const explain = opts.explain ?? true;
  // With explain off the page gets only what the SDK needs to seal: that an agent attached (or signed in). No actor,
  // no environment verdict: an agent that could read its own verdict could tune its cursor until it reads human.
  const SEAL = new Set(['agent_attached', 'signed_agent']);
  const view = <T extends { state: string }>(c: T) => (explain ? c : SEAL.has(c.state) ? { state: c.state } : null);

  const createRoom = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (opts.roomAllowed && !(await opts.roomAllowed(req))) return json(res, 429, { error: 'rate_limited', message: 'Too many new demo rooms from this network. Try again in an hour.' });
    const body = (await readJson(req, 500).catch(() => null)) as { app?: unknown } | null | undefined;
    const app = body && typeof body.app === 'string' && /^[a-z]{2,20}$/.test(body.app) ? body.app : 'bank';
    json(res, 201, { room: await store.createRoom(Date.now(), app, opts.deviceOf?.(req) ?? null), app });
  };

  const base = sessionRoutes(engine, { explain });
  const { connection, signals, stepUp } = base;
  const me = async (req: Req, res: Res) => {
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const policy = await engine.policyFor(r.room);
    const app = (await store.roomApp(r.room)) ?? 'bank';
    json(res, 200, { room: r.room, app, session: r.session.id, label: r.session.label, scenario: r.session.scenario, arrival: explain ? r.session.arrival : null, connection: view(await engine.connectionFor(r.session)), policy: explain ? policy : null, labOperator: labOperator?.operator ?? null });
  };

  const journal = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found', message: 'Test room not found, or its 7-day period has expired.' });
    const decisions = (await store.listDecisions(room, 100)).map((d) => ({ ...publicDecision(d), session: d.session, seq: d.seq, dataDelivered: d.dataDelivered, simulated: d.simulated, reasons: d.assessment.reasons }));
    const sessions = [];
    for (const s of await store.listSessions(room)) sessions.push(summarize(s, await engine.connectionFor(s)));
    json(res, 200, { decisions, sessions, policy: await engine.policyFor(room) });
  };

  const benchmark = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found' });
    json(res, 200, await computeBenchmark(engine, room, labOperator?.operator ?? null));
  };

  /**
   * Lab-only: sign a request to this server with the lab operator key and
   * send it, twice (second with the same nonce) to show the replay guard.
   * The lab operator is NOT ChatGPT; it demonstrates the verified path only.
   */
  const simulateSigned = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (!labOperator) return json(res, 404, { error: 'lab_operator_disabled' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const base = url(req);
    const target = `${base.origin}/api/v1/account/balance?room=${r.room}`;
    const nonce = crypto.randomUUID();
    const headers = await signRequest(labOperator.privateKey, labOperator.publicJwk, { method: 'GET', url: target, headers: new Headers() }, labOperator.operator, { nonce });
    const cookie = `${engine.sessionCookie}=${r.session.id}`;
    const runs: { status: number; body: unknown }[] = [];
    for (let i = 0; i < 2; i++) {
      const resp = await fetch(target, { headers: { ...headers, cookie, 'x-oh-lab-simulated': LAB_SIMULATION_TOKEN }, cache: 'no-store' });
      runs.push({ status: resp.status, body: await resp.json() });
    }
    json(res, 200, { operator: labOperator.operator, note: 'Two identical requests signed with the lab operator key: the first is verified, the second is a replay.', runs });
  };

  const audit = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found' });
    const keys = engine.proofKeys().keys;
    const rows = [];
    let signed = 0, valid = 0;
    for (const d of await store.listDecisions(room, 300)) {
      const proof = await store.decisionProof(d.id);
      const check = proof ? verifyProof(proof, keys) : null;
      if (proof) signed++;
      if (check?.valid) valid++;
      rows.push({ ...publicDecision(d), seq: d.seq, session: d.session, dataDelivered: d.dataDelivered, prevHash: d.prevHash, hash: d.hash, reasons: d.assessment.reasons, proof, proofValid: check ? check.valid : null });
    }
    json(res, 200, { chain: await verifyChain(store, room), proofs: { signed, valid, keys }, decisions: rows });
  };

  /** Server-Sent Events: attach and decision events for one room, as they happen. */
  const stream = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ room, at: Date.now() })}\n\n`);
    const unsubscribe = bus.subscribe((e) => {
      if (e.room !== room) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  };

  return { createRoom, me, connection, signals, journal, benchmark, stepUp, simulateSigned, audit, stream };
}

export function summarize(s: SessionRow, connection?: Connection) {
  return {
    id: s.id,
    label: s.label,
    scenario: s.scenario,
    created: s.created,
    lastSeen: s.lastSeen,
    firstDataAt: s.firstDataAt,
    firstAgentAt: s.firstAgentAt,
    agentAttachedAt: s.agentAttachedAt,
    agentAttachedClientMs: s.agentAttachedClientMs,
    connection: connection ? { state: connection.state, atMs: connection.atMs, tools: connection.tools, codes: connection.evidence.map((e) => e.code) } : null,
    arrival: s.arrival ? { signature: s.arrival.signature.status, secFetchUser: s.arrival.secFetch.user, uaMajor: s.arrival.uaMajor, agentApp: s.arrival.environment?.agentAppToken ?? null, clientHints: s.arrival.environment?.clientHints ?? null } : null,
  };
}

export type Benchmark = {
  room: string;
  groups: Record<'human' | 'agent' | 'unlabelled', {
    sessions: number;
    completed: number;
    detected: number;
    detectedBeforeData: number;
    blocked: number;
    stepUp: number;
    masked: number;
    sensitiveDelivered: number;
    unknownFinal: number;
    medianLatencyMs: number | null;
    medianFirstDecisionMs: number | null;
    /** connection classifier, no action needed */
    attached: number;
    environmentOnly: number;
    attachedBeforeFirstAction: number;
    medianAttachMs: number | null;
  }>;
  falseBlockSessions: number;
  /** human-labelled sessions the connection classifier called agent_attached */
  falseAttachSessions: number;
  missedAgentSessions: number;
  /** one row per (label, scenario) */
  scenarios: ScenarioRow[];
  note: string;
};

export type ScenarioRow = {
  label: 'human' | 'agent' | 'unlabelled';
  scenario: string;
  sessions: number;
  attached: number;
  attachedBeforeFirstAction: number;
  medianAttachMs: number | null;
  environmentOnly: number;
  blocked: number;
  sensitiveDelivered: number;
  decisions: number;
  falseBlocks: number;
  /** per session: id, attach ms (page-relative), first action ms, first-data ms, codes */
  runs: { id: string; attachMs: number | null; firstActionMs: number | null; firstDataMs: number | null; codes: string[]; decisions: string[] }[];
};

export async function computeBenchmark(engine: OneHuman, room: string, labOperator: string | null = null): Promise<Benchmark> {
  const store = engine.store;
  const sessions = await store.listSessions(room);
  // Decisions produced by the lab's own signed-request simulation carry `simulated`; rows written
  // before that flag existed are recognised by the lab operator name in their reasons.
  const decisions = (await store.listDecisions(room, 100000)).map((d) => ({
    ...d,
    simulated: d.simulated === true || (d.simulated === undefined && !!labOperator && (d.assessment.reasons.some((r) => r.detail.includes(labOperator)) || d.reasonCodes.includes('SIGNATURE_REPLAY'))),
  }));
  const bySession = new Map<string, typeof decisions>();
  for (const d of decisions) {
    const list = bySession.get(d.session) ?? [];
    list.push(d);
    bySession.set(d.session, list);
  }
  const empty = () => ({ sessions: 0, completed: 0, detected: 0, detectedBeforeData: 0, blocked: 0, stepUp: 0, masked: 0, sensitiveDelivered: 0, unknownFinal: 0, medianLatencyMs: null as number | null, medianFirstDecisionMs: null as number | null, attached: 0, environmentOnly: 0, attachedBeforeFirstAction: 0, medianAttachMs: null as number | null });
  const groups = { human: empty(), agent: empty(), unlabelled: empty() };
  const latencies: Record<string, number[]> = { human: [], agent: [], unlabelled: [] };
  const firstDecision: Record<string, number[]> = { human: [], agent: [], unlabelled: [] };
  const attachMs: Record<string, number[]> = { human: [], agent: [], unlabelled: [] };
  let falseBlockSessions = 0;
  let falseAttachSessions = 0;
  let missedAgentSessions = 0;
  const scenarioMap = new Map<string, ScenarioRow>();
  for (const s of sessions) {
    const g = groups[s.label];
    const ds = (bySession.get(s.id) ?? []).filter((d) => !d.simulated).sort((a, b) => a.seq - b.seq);
    g.sessions++;
    const c = await engine.connectionFor(s);
    const key = `${s.label}|${s.scenario}`;
    const sc = scenarioMap.get(key) ?? { label: s.label, scenario: s.scenario, sessions: 0, attached: 0, attachedBeforeFirstAction: 0, medianAttachMs: null, environmentOnly: 0, blocked: 0, sensitiveDelivered: 0, decisions: 0, falseBlocks: 0, runs: [] };
    scenarioMap.set(key, sc);
    sc.sessions++;
    sc.decisions += ds.length;
    const attachedNow = c.state === 'agent_attached' || c.state === 'signed_agent';
    if (attachedNow) sc.attached++; else if (c.state === 'agent_environment') sc.environmentOnly++;
    if (attachedNow && s.agentAttachedAt !== null && (!ds[0] || s.agentAttachedAt <= ds[0].created)) sc.attachedBeforeFirstAction++;
    if (ds.some((d) => d.enforced && d.decision === 'block')) { sc.blocked++; if (s.label === 'human') sc.falseBlocks++; }
    if (ds.some((d) => d.dataDelivered)) sc.sensitiveDelivered++;
    sc.runs.push({ id: s.id.slice(0, 8), attachMs: s.agentAttachedAt !== null ? s.agentAttachedAt - s.created : null, firstActionMs: ds[0] ? ds[0].created - s.created : null, firstDataMs: (() => { const f = ds.find((d) => d.dataDelivered); return f ? f.created - s.created : null; })(), codes: c.evidence.map((e) => e.code).filter((x, i, a) => a.indexOf(x) === i).slice(0, 5), decisions: ds.map((d) => `${d.resource.split('.')[0]}:${d.decision}`) });
    if (c.state === 'agent_attached' || c.state === 'signed_agent') {
      g.attached++;
      if (s.agentAttachedAt !== null) {
        attachMs[s.label]!.push(s.agentAttachedAt - s.created);
        if (!ds[0] || s.agentAttachedAt <= ds[0].created) g.attachedBeforeFirstAction++;
      }
      if (s.label === 'human') falseAttachSessions++;
    } else if (c.state === 'agent_environment') g.environmentOnly++;
    if (ds.length >= 3) g.completed++;
    // detection time = earliest of the connection attach moment and the first non-simulated agent_likely decision
    const firstAgentDecision = ds.find((d) => d.actor === 'agent_likely')?.created ?? null;
    const detectedAt = [s.agentAttachedAt, firstAgentDecision].filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
    const firstDataAt = ds.find((d) => d.dataDelivered)?.created ?? null;
    const detected = detectedAt !== null;
    if (detected) g.detected++;
    if (detected && (firstDataAt === null || detectedAt <= firstDataAt)) g.detectedBeforeData++;
    const blocked = ds.some((d) => d.enforced && d.decision === 'block');
    if (blocked) g.blocked++;
    if (ds.some((d) => d.enforced && d.decision === 'step_up')) g.stepUp++;
    if (ds.some((d) => d.enforced && d.decision === 'mask')) g.masked++;
    const delivered = firstDataAt !== null;
    if (delivered) g.sensitiveDelivered++;
    const last = ds.at(-1);
    if (last && last.actor === 'unknown') g.unknownFinal++;
    if (s.label === 'human' && blocked) falseBlockSessions++;
    if (s.label === 'agent' && delivered && !detected) missedAgentSessions++;
    for (const d of ds) latencies[s.label]!.push(d.latencyMs);
    if (ds[0]) firstDecision[s.label]!.push(ds[0].created - s.created);
  }
  for (const k of ['human', 'agent', 'unlabelled'] as const) {
    groups[k].medianLatencyMs = median(latencies[k]!);
    groups[k].medianFirstDecisionMs = median(firstDecision[k]!);
    groups[k].medianAttachMs = median(attachMs[k]!);
  }
  const scenarios = [...scenarioMap.values()].map((sc) => ({ ...sc, medianAttachMs: median(sc.runs.map((r) => r.attachMs).filter((x): x is number => x !== null)) })).sort((a, b) => a.label.localeCompare(b.label) || a.scenario.localeCompare(b.scenario));
  return {
    room,
    groups,
    falseBlockSessions,
    falseAttachSessions,
    missedAgentSessions,
    scenarios,
    note: 'Labels are what the experiment participant reported, not detector input. On a small sample the percentages are not statistically meaningful.',
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}
