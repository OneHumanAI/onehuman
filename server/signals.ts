// SPDX-License-Identifier: BUSL-1.1
/**
 * Signal contracts shared by the browser SDK, the middleware and the assessor.
 *
 * Everything that arrives from the browser is UNTRUSTED. It is validated for
 * shape and bounds only; a client can forge any of it. Missing telemetry is
 * therefore "unknown", never "human".
 */

/**
 * Known page-visible DOM markers. Two classes:
 *  - control: injected only while the agent actively controls the tab
 *    (Claude ext. `agent-visual-indicator.js` on SHOW_AGENT_INDICATORS; Codex overlay host)
 *  - trace: shows the extension/agent touched the page at some point (favicon badge,
 *    animation <style> that persists after the agent stops)
 */
import { extraGlobal, extraMarker, extraMarkerCount } from './signatures.ts';

export type MarkerName =
  | 'codex-overlay'
  | 'codex-badge'
  | 'claude-stop'
  | 'claude-cursor'
  | 'claude-glow'
  | 'claude-styles';

export const MARKER_NAMES: MarkerName[] = ['codex-overlay', 'codex-badge', 'claude-stop', 'claude-cursor', 'claude-glow', 'claude-styles'];
export const CONTROL_MARKERS: MarkerName[] = ['codex-overlay', 'claude-stop', 'claude-cursor', 'claude-glow'];
/** a marker that means an agent is in control now: built-in, or added by a signature bundle */
export const isControlMarker = (name: string) => CONTROL_MARKERS.includes(name as MarkerName) || extraMarker(name)?.control === true;

/** Known agent browser extensions whose web-accessible resources a page can probe. Installed ≠ active. */
export type ExtensionId = 'claude-chrome' | 'codex-chrome';
export const EXTENSION_IDS: ExtensionId[] = ['claude-chrome', 'codex-chrome'];

/** Observed by the head sensor before the app hydrates. */
export type EarlySignal = {
  startedMs: number;
  observedMs: number;
  webdriver: boolean;
  firstInteractionMs: number | null;
  dataDomMs: number | null;
  markers: { name: MarkerName; atMs: number }[];
  environment: {
    codexModelContext: boolean;
    modelContextApi: boolean;
    clipboardBridge: boolean;
    clipboardBridgeAtMs: number | null;
    /** page-world globals with known agent prefixes (__codex*, __claude*, __browserUse*, __anthropic*, __openai*) */
    agentGlobals: string[];
    /** extensions whose web-accessible resource loaded */
    extensionsInstalled: ExtensionId[];
    /** first time document.hasFocus() was true while visibilityState was 'hidden' for ≥300 ms; impossible for a person */
    focusWhileHiddenMs: number | null;
  };
  focusConflict: {
    count: number;
    firstAtMs: number | null;
    peers: number;
  };
  webmcpInvocations: number;
  /** what happens when an agent *reads* the page, before any click */
  /** reading from outside the page's JS world: a side panel took viewport width, long tasks with no input */
  surface: {
    panelOpenedMs: number | null;
    panelWidthPx: number;
    panelClosedMs: number | null;
    /** the window was already much wider than the viewport at load: a panel was open before the page was */
    panelAtLoad: boolean;
    scans: number;
    firstScanMs: number | null;
    longestScanMs: number;
    scanAfterPanelMs: number | null;
  };
  reading: {
    loadedHidden: boolean;
    readBursts: number;
    firstReadBurstMs: number | null;
    lastReadBurstReads: number;
    readBurstAnonymous: boolean;
    textExtracts: number;
    firstTextExtractMs: number | null;
    visibilityFlickers: number;
    firstFlickerMs: number | null;
    flickerResize: string | null;
    renderWhileHiddenMs: number | null;
    firstClick: { atMs: number; trusted: boolean; pointer: string; holdMs: number | null; moves: number; pressure: number | null; hidden: boolean | null } | null;
    /** SDK v4: when on-screen sensitive data was redacted because an agent indicator appeared, and why */
    seal?: { atMs: number; reason: string; redacted: number } | null;
  };
};

export const EMPTY_SURFACE: EarlySignal['surface'] = { panelOpenedMs: null, panelWidthPx: 0, panelClosedMs: null, panelAtLoad: false, scans: 0, firstScanMs: null, longestScanMs: 0, scanAfterPanelMs: null };
export const EMPTY_READING: EarlySignal['reading'] = { loadedHidden: false, readBursts: 0, firstReadBurstMs: null, lastReadBurstReads: 0, readBurstAnonymous: false, textExtracts: 0, firstTextExtractMs: null, visibilityFlickers: 0, firstFlickerMs: null, flickerResize: null, renderWhileHiddenMs: null, firstClick: null };

/**
 * Page globals that agent tooling creates only when it acts on the page (reads the
 * accessibility tree, pastes, …). Unlike environment globals such as
 * `__codexWebMcpModelContext`, these are absent for a person using the same browser
 * until an agent tool runs. Observed 2026-09-18 in the Claude desktop pane after read_page.
 */
export const TOOL_INJECTED_GLOBALS: Record<string, string> = {
  __claudeElementMap: 'claude-tools',
  __claudeElementReverseMap: 'claude-tools',
  __claudeRefCounter: 'claude-tools',
  __generateAccessibilityTree: 'claude-tools',
  __browserUseClipboardBridge: 'codex-app',
  // Codex in-app browser, 2026-09-22: its Playwright driver marks the page; the UA token and DOM overlay were gone
  __codexPlaywrightInjected: 'codex-app',
};
export function toolInjectedGlobals(names: string[]): { name: string; tool: string }[] {
  return names.flatMap((n) => {
    const tool = TOOL_INJECTED_GLOBALS[n] ?? extraGlobal(n)?.tool ?? (n.startsWith('__browserUseClipboard') ? 'codex-app' : null);
    return tool ? [{ name: n, tool }] : [];
  });
}

/** Aggregated interaction metadata for one protected action. No text, keys or DOM. */
export type InteractionSample = {
  atMs: number;
  webdriver: boolean;
  click: {
    trusted: boolean;
    pointer: 'mouse' | 'touch' | 'pen' | '';
    detail: number;
    holdMs: number | null;
    moves: number;
    path: number;
    travelMs: number;
    /** PointerEvent.pressure at pointerdown. Spec: 0.5 for pressed buttons on hardware without pressure; 0 means synthetic input. null = unknown */
    pressure: number | null;
    /** document.visibilityState === 'hidden' when the pointer went down. A person cannot click a hidden document. null = unknown */
    hidden: boolean | null;
    /** cursor trajectory before the click: [tMs relative to click (≤0), x, y], oldest first, ≤240 points; SDK v5 keeps the last approach regardless of age */
    traj?: [number, number, number][];
    /** pointerdown time relative to the click, ms (≤ 0) */
    downMs?: number | null;
    /** click offset from the target element centre and the element size, CSS px */
    target?: { w: number; h: number; dx: number; dy: number } | null;
    /** total coalesced pointermove events behind the trajectory points */
    coalesced?: number;
    /** click position, client px */
    at?: [number, number] | null;
  } | null;
  keys: number;
  keyIntervals: number[];
  inputEvents: number;
  paste: boolean;
};

/** What the server itself observed on an HTTP request. Trusted (it is ours). */
export type ServerSignal = {
  signature: {
    status: 'absent' | 'verified' | 'invalid' | 'unsupported' | 'unavailable' | 'replay';
    reason: string;
    operator: string | null;
    present: { signature: boolean; signatureInput: boolean; signatureAgent: boolean };
  };
  secFetch: { site: string | null; mode: string | null; dest: string | null; user: string | null };
  uaMajor: number | null;
  /** Environment hints from the request. Only known product tokens are kept, never the raw UA. */
  environment?: {
    /** e.g. "Claude/2.2553.1" — the Claude desktop app's embedded browser. A person can also click there; environment, not actor. */
    agentAppToken: string | null;
    /** Chrome sends Sec-CH-UA on every request; embedded/Electron shells often do not. */
    clientHints: boolean;
    /**
     * WebKit (every iPhone/iPad browser, Safari on the Mac): its pointer events report pressure 0 for real taps and
     * trackpad clicks, a tap's click as a "mouse", and tap-to-click releases in ~1 ms. Those three readings are no
     * evidence of a program there (a real iPhone user was blocked on them, 2026-09-28).
     */
    webkitPointer?: boolean;
  };
  checkedMs: number;
};

export type ClientSnapshot = {
  early: EarlySignal | null;
  interaction: InteractionSample | null;
};

// ---------------------------------------------------------------------------
// Validation (hand-written; no runtime dependencies)
// ---------------------------------------------------------------------------

const MAX_MS = 1e12;

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function numOrNull(v: unknown, min: number, max: number): number | null | undefined {
  if (v === null) return null;
  const n = num(v, min, max);
  return n === null ? undefined : n;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseEarly(input: unknown): EarlySignal | null {
  const o = obj(input);
  if (!o) return null;
  const startedMs = num(o.startedMs, 0, MAX_MS);
  const observedMs = num(o.observedMs, 0, MAX_MS);
  const webdriver = bool(o.webdriver);
  const firstInteractionMs = numOrNull(o.firstInteractionMs, 0, MAX_MS);
  const dataDomMs = numOrNull(o.dataDomMs, 0, MAX_MS);
  if (startedMs === null || observedMs === null || webdriver === null || firstInteractionMs === undefined || dataDomMs === undefined) return null;
  if (!Array.isArray(o.markers) || o.markers.length > MARKER_NAMES.length + extraMarkerCount()) return null;
  const markers: EarlySignal['markers'] = [];
  for (const m of o.markers) {
    const mo = obj(m);
    const atMs = mo ? num(mo.atMs, 0, MAX_MS) : null;
    if (!mo || atMs === null || !(MARKER_NAMES.includes(mo.name as MarkerName) || (typeof mo.name === 'string' && extraMarker(mo.name)))) return null;
    if (markers.some((x) => x.name === mo.name)) return null;
    markers.push({ name: mo.name as MarkerName, atMs });
  }
  const env = obj(o.environment);
  const fc = obj(o.focusConflict);
  if (!env || !fc) return null;
  const codexModelContext = bool(env.codexModelContext);
  const modelContextApi = bool(env.modelContextApi);
  const clipboardBridge = bool(env.clipboardBridge);
  const clipboardBridgeAtMs = numOrNull(env.clipboardBridgeAtMs, 0, MAX_MS);
  const count = num(fc.count, 0, 100000);
  const firstAtMs = numOrNull(fc.firstAtMs, 0, MAX_MS);
  const peers = num(fc.peers, 0, 1000);
  const webmcpInvocations = num(o.webmcpInvocations ?? 0, 0, 100000);
  if (codexModelContext === null || modelContextApi === null || clipboardBridge === null || clipboardBridgeAtMs === undefined) return null;
  if (count === null || firstAtMs === undefined || peers === null || webmcpInvocations === null) return null;
  const rawGlobals = env.agentGlobals ?? [];
  if (!Array.isArray(rawGlobals) || rawGlobals.length > 10) return null;
  const agentGlobals: string[] = [];
  for (const g of rawGlobals) {
    if (typeof g !== 'string' || !/^__(codex|claude|browserUse|anthropic|openai|generateAccessibilityTree)[A-Za-z0-9_]{0,60}$/.test(g)) return null;
    agentGlobals.push(g);
  }
  const rawExt = env.extensionsInstalled ?? [];
  if (!Array.isArray(rawExt) || rawExt.length > EXTENSION_IDS.length) return null;
  const extensionsInstalled: ExtensionId[] = [];
  for (const x of rawExt) {
    if (!EXTENSION_IDS.includes(x as ExtensionId) || extensionsInstalled.includes(x as ExtensionId)) return null;
    extensionsInstalled.push(x as ExtensionId);
  }
  const focusWhileHiddenMs = env.focusWhileHiddenMs === undefined ? null : numOrNull(env.focusWhileHiddenMs, 0, MAX_MS);
  if (focusWhileHiddenMs === undefined) return null;
  let surface: EarlySignal['surface'] = { ...EMPTY_SURFACE };
  if (o.surface !== undefined) {
    const u = obj(o.surface);
    if (!u) return null;
    const panelOpenedMs = numOrNull(u.panelOpenedMs, -1000, 86400000);
    const panelClosedMs = numOrNull(u.panelClosedMs, -1000, 86400000);
    const firstScanMs = numOrNull(u.firstScanMs, -1000, 86400000);
    const scanAfterPanelMs = numOrNull(u.scanAfterPanelMs, 0, 86400000);
    const panelWidthPx = num(u.panelWidthPx, 0, 10000);
    const scans = num(u.scans, 0, 100000);
    const longestScanMs = num(u.longestScanMs, 0, 600000);
    if (panelOpenedMs === undefined || panelClosedMs === undefined || firstScanMs === undefined || scanAfterPanelMs === undefined || panelWidthPx === null || scans === null || longestScanMs === null) return null;
    surface = { panelOpenedMs, panelWidthPx, panelClosedMs, panelAtLoad: u.panelAtLoad === true, scans, firstScanMs, longestScanMs, scanAfterPanelMs };
  }
  let reading: EarlySignal['reading'] = { ...EMPTY_READING };
  if (o.reading !== undefined) {
    const r = obj(o.reading);
    if (!r) return null;
    const loadedHidden = bool(r.loadedHidden);
    const readBursts = num(r.readBursts, 0, 100000);
    const firstReadBurstMs = numOrNull(r.firstReadBurstMs, 0, MAX_MS);
    const lastReadBurstReads = num(r.lastReadBurstReads, 0, 1e7);
    const readBurstAnonymous = bool(r.readBurstAnonymous);
    const textExtracts = num(r.textExtracts ?? 0, 0, 100000);
    const firstTextExtractMs = r.firstTextExtractMs === undefined ? null : numOrNull(r.firstTextExtractMs, 0, MAX_MS);
    const visibilityFlickers = num(r.visibilityFlickers, 0, 100000);
    const firstFlickerMs = numOrNull(r.firstFlickerMs, 0, MAX_MS);
    const renderWhileHiddenMs = numOrNull(r.renderWhileHiddenMs, 0, MAX_MS);
    const flickerResize = r.flickerResize === null ? null : typeof r.flickerResize === 'string' && /^\d{1,5}x\d{1,5}$/.test(r.flickerResize) ? r.flickerResize : undefined;
    if (loadedHidden === null || readBursts === null || firstReadBurstMs === undefined || lastReadBurstReads === null || readBurstAnonymous === null || textExtracts === null || firstTextExtractMs === undefined || visibilityFlickers === null || firstFlickerMs === undefined || renderWhileHiddenMs === undefined || flickerResize === undefined) return null;
    let firstClick: EarlySignal['reading']['firstClick'] = null;
    if (r.firstClick !== undefined && r.firstClick !== null) {
      const fc = obj(r.firstClick);
      if (!fc) return null;
      const atMs = num(fc.atMs, 0, MAX_MS);
      const trusted = bool(fc.trusted);
      const holdMs = numOrNull(fc.holdMs, 0, 120000);
      const moves = num(fc.moves, 0, 240);
      const pressure = numOrNull(fc.pressure, 0, 1);
      const hidden = fc.hidden === null ? null : bool(fc.hidden);
      const pointer = fc.pointer;
      if (atMs === null || trusted === null || holdMs === undefined || moves === null || pressure === undefined || hidden === undefined) return null;
      if (pointer !== 'mouse' && pointer !== 'touch' && pointer !== 'pen' && pointer !== '') return null;
      firstClick = { atMs, trusted, pointer, holdMs, moves, pressure, hidden };
    }
    reading = { loadedHidden, readBursts, firstReadBurstMs, lastReadBurstReads, readBurstAnonymous, textExtracts, firstTextExtractMs, visibilityFlickers, firstFlickerMs, flickerResize, renderWhileHiddenMs, firstClick };
    if (r.seal !== undefined && r.seal !== null) {
      const sl = obj(r.seal);
      if (!sl) return null;
      const atMs = num(sl.atMs, 0, MAX_MS), redacted = num(sl.redacted, 0, 1e5);
      if (atMs === null || redacted === null || typeof sl.reason !== 'string' || !/^[a-z_]{1,32}$/.test(sl.reason)) return null;
      reading.seal = { atMs, reason: sl.reason, redacted };
    }
  }
  return {
    reading,
    surface,
    startedMs,
    observedMs,
    webdriver,
    firstInteractionMs,
    dataDomMs,
    markers,
    environment: { codexModelContext, modelContextApi, clipboardBridge, clipboardBridgeAtMs, agentGlobals, extensionsInstalled, focusWhileHiddenMs },
    focusConflict: { count, firstAtMs, peers },
    webmcpInvocations,
  };
}

export function parseInteraction(input: unknown): InteractionSample | null {
  const o = obj(input);
  if (!o) return null;
  const atMs = num(o.atMs, 0, MAX_MS);
  const webdriver = bool(o.webdriver);
  const keys = num(o.keys, 0, 500);
  const inputEvents = num(o.inputEvents, 0, 500);
  const paste = bool(o.paste);
  if (atMs === null || webdriver === null || keys === null || inputEvents === null || paste === null) return null;
  if (!Array.isArray(o.keyIntervals) || o.keyIntervals.length > 80) return null;
  const keyIntervals: number[] = [];
  for (const k of o.keyIntervals) {
    const n = num(k, 0, 86400000);
    if (n === null) return null;
    keyIntervals.push(n);
  }
  let click: InteractionSample['click'] = null;
  if (o.click !== null) {
    const c = obj(o.click);
    if (!c) return null;
    const trusted = bool(c.trusted);
    const detail = num(c.detail, 0, 10);
    const holdMs = numOrNull(c.holdMs, 0, 120000);
    const moves = num(c.moves, 0, 240);
    const path = num(c.path, 0, 1e7);
    const travelMs = num(c.travelMs, 0, 3600000); // the retained approach may span minutes
    const pointer = c.pointer;
    const pressure = c.pressure === undefined ? null : numOrNull(c.pressure, 0, 1);
    const hidden = c.hidden === undefined || c.hidden === null ? null : bool(c.hidden);
    if (trusted === null || detail === null || holdMs === undefined || moves === null || path === null || travelMs === null) return null;
    if (pressure === undefined || (c.hidden !== undefined && c.hidden !== null && hidden === null)) return null;
    if (pointer !== 'mouse' && pointer !== 'touch' && pointer !== 'pen' && pointer !== '') return null;
    click = { trusted, pointer, detail, holdMs, moves, path, travelMs, pressure, hidden };
    if (c.traj !== undefined) {
      if (!Array.isArray(c.traj) || c.traj.length > 240) return null;
      const traj: [number, number, number][] = [];
      for (const pt of c.traj) {
        if (!Array.isArray(pt) || pt.length !== 3) return null;
        const t = num(pt[0], -3600000, 0), x = num(pt[1], -1e5, 1e5), y = num(pt[2], -1e5, 1e5);
        if (t === null || x === null || y === null) return null;
        traj.push([t, x, y]);
      }
      click.traj = traj;
    }
    if (c.downMs !== undefined) { const d = numOrNull(c.downMs, -120000, 0); if (d === undefined) return null; click.downMs = d; }
    if (c.target !== undefined && c.target !== null) {
      const tg = obj(c.target);
      if (!tg) return null;
      const w = num(tg.w, 0, 1e5), h = num(tg.h, 0, 1e5), dx = num(tg.dx, -1e5, 1e5), dy = num(tg.dy, -1e5, 1e5);
      if (w === null || h === null || dx === null || dy === null) return null;
      click.target = { w, h, dx, dy };
    } else if (c.target === null) click.target = null;
    if (c.coalesced !== undefined) { const n = num(c.coalesced, 0, 1e5); if (n === null) return null; click.coalesced = n; }
    if (c.at !== undefined && c.at !== null) {
      if (!Array.isArray(c.at) || c.at.length !== 2) return null;
      const x = num(c.at[0], -1e5, 1e5), y = num(c.at[1], -1e5, 1e5);
      if (x === null || y === null) return null;
      click.at = [x, y];
    } else if (c.at === null) click.at = null;
  }
  return { atMs, webdriver, click, keys, keyIntervals, inputEvents, paste };
}

export function parseSnapshot(input: unknown): ClientSnapshot | null {
  const o = obj(input);
  if (!o) return null;
  const early = o.early == null ? null : parseEarly(o.early);
  const interaction = o.interaction == null ? null : parseInteraction(o.interaction);
  if (o.early != null && early === null) return null;
  if (o.interaction != null && interaction === null) return null;
  return { early, interaction };
}
