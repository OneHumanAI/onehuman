// SPDX-License-Identifier: BUSL-1.1
/**
 * Connection classifier — the single question this module answers:
 *
 *   "Right now, is an agent attached to this session, is the session merely
 *    running inside an agent's environment, or is there no indication at all?"
 *
 * It needs no user action. Inputs are the server-observed arrival request and
 * the latest passive snapshot from the head sensor. It is re-evaluated on every
 * snapshot, because an agent can attach to an already-open tab: the moment it
 * does, its control indicator appears and the state flips to `agent_attached`.
 *
 * States, strongest first:
 *   signed_agent       operator signature verified on the request (cryptographic)
 *   agent_attached     deterministic browser fact or a known tool's active-control indicator
 *   agent_environment  the page runs inside an agent application or an agent tool is installed;
 *                      a person may be operating it, an agent may attach at any moment
 *   no_indication      nothing observed — NOT proof of a person
 */
import { extraAppToken, extraMarker } from './signatures.ts';
import { isControlMarker, toolInjectedGlobals, type EarlySignal, type ServerSignal } from './signals.ts';

export type ConnectionState = 'signed_agent' | 'agent_attached' | 'agent_environment' | 'no_indication';

export type ConnectionEvidence = {
  code: string;
  /** ms since page start (client clock) or 0 for request-time facts */
  atMs: number;
  detail: string;
};

export type Connection = {
  state: ConnectionState;
  /** earliest evidence time for the current state, ms since page start */
  atMs: number | null;
  evidence: ConnectionEvidence[];
  /** which agent products the evidence points at, e.g. ["claude-chrome"] */
  tools: string[];
  version: string;
};

export const CONNECTION_VERSION = 'connection-v3';

const TOOL_OF_MARKER: Record<string, string> = {
  'claude-stop': 'claude-chrome', 'claude-cursor': 'claude-chrome', 'claude-glow': 'claude-chrome', 'claude-styles': 'claude-chrome',
  'codex-overlay': 'codex-chrome', 'codex-badge': 'codex-chrome',
};

export function classifyConnection(server: ServerSignal | null, early: EarlySignal | null): Connection {
  const attached: ConnectionEvidence[] = [];
  const environment: ConnectionEvidence[] = [];
  const tools = new Set<string>();

  const sig = server?.signature;
  if (sig && (sig.status === 'verified' || sig.status === 'replay')) {
    return { state: 'signed_agent', atMs: 0, tools: [sig.operator ?? 'operator'], version: CONNECTION_VERSION, evidence: [{ code: sig.status === 'verified' ? 'VERIFIED_OPERATOR_SIGNATURE' : 'SIGNATURE_REPLAY', atMs: 0, detail: sig.reason }] };
  }

  if (early?.webdriver) attached.push({ code: 'WEBDRIVER_FLAG', atMs: early.startedMs, detail: 'navigator.webdriver=true' });
  for (const m of early?.markers ?? []) {
    const tool = TOOL_OF_MARKER[m.name] ?? extraMarker(m.name)?.tool;
    if (tool) tools.add(tool);
    if (isControlMarker(m.name)) attached.push({ code: 'AGENT_CONTROL_MARKER', atMs: m.atMs, detail: `${m.name} appeared on the page` });
    else environment.push({ code: 'DOM_MARKER', atMs: m.atMs, detail: `${m.name} (past or passive trace)` });
  }
  if (early?.environment.focusWhileHiddenMs != null) attached.push({ code: 'FOCUS_WHILE_HIDDEN', atMs: early.environment.focusWhileHiddenMs, detail: 'hidden document has focus (focus emulation)' });
  if ((early?.webmcpInvocations ?? 0) > 0) attached.push({ code: 'WEBMCP_TOOL_INVOKED', atMs: early?.observedMs ?? 0, detail: 'WebMCP tool invoked' });

  // Reading-time evidence: the agent looks at the page before it clicks.
  const rd = early?.reading;
  if (rd && rd.readBursts > 0 && rd.readBurstAnonymous && rd.firstReadBurstMs != null) {
    attached.push({ code: 'MAIN_WORLD_READ_BURST', atMs: rd.firstReadBurstMs, detail: `${rd.lastReadBurstReads}+ DOM reads in 250 ms, source: <anonymous> script (Runtime.evaluate). Page code and extensions are not counted here.` });
  }
  if (rd && rd.textExtracts > 0 && rd.firstTextExtractMs != null) {
    attached.push({ code: 'MAIN_WORLD_TEXT_EXTRACT', atMs: rd.firstTextExtractMs, detail: 'full document text (body/main) read by an <anonymous> script (get_page_text style extraction)' });
  }
  const injected = toolInjectedGlobals(early?.environment.agentGlobals ?? []);
  if (injected.length) {
    for (const g of injected) tools.add(g.tool);
    attached.push({ code: 'AGENT_TOOL_GLOBALS', atMs: early?.observedMs ?? 0, detail: `globals injected into the page by an agent tool: ${injected.map((g) => g.name).slice(0, 3).join(', ')} (accessibility tree read)` });
  }
  // First click: a synthetic pointer (pressure 0 with the button down, no pointer travel, ≤12 ms hold)
  // on a hidden document, or inside an agent application, is decisive on its own. Human clicks in the
  // same Claude pane measured pressure 0.5 with 40–100 pointermoves (2026-09-18).
  const fc = rd?.firstClick;
  const appToken = server?.environment?.agentAppToken ?? null;
  // "agent application" = a browser embedded in an agent product: UA token (Claude app) or the
  // model-context global (Codex app). A person can use both, so this only qualifies the first click.
  const agentApp = !!appToken || !!early?.environment.codexModelContext;
  if (fc && fc.trusted && fc.pointer === 'mouse' && fc.pressure === 0 && fc.moves <= 1 && fc.holdMs !== null && fc.holdMs <= 12 && (fc.hidden === true || agentApp)) {
    attached.push({ code: 'SYNTHETIC_FIRST_CLICK', atMs: fc.atMs, detail: `first click: pressure 0, ${fc.moves} moves, ${fc.holdMs} ms press${fc.hidden ? ', document hidden' : ''} (CDP Input.dispatchMouseEvent profile)` });
  } else if (fc && fc.hidden === true && fc.trusted) {
    attached.push({ code: 'HIDDEN_DOCUMENT_CLICK', atMs: fc.atMs, detail: 'first click arrived while the document was hidden' });
  }
  // Visibility flicker is environment-only: a person opening a link inside the Claude pane produced
  // the same one-frame flicker at page load (benchmark 2026-09-20, session 211ea2cc, false positive).
  if (rd && rd.visibilityFlickers > 0 && rd.firstFlickerMs != null) {
    environment.push({ code: 'VISIBILITY_FLICKER', atMs: rd.firstFlickerMs, detail: `document flickered visible→hidden for <300 ms${rd.flickerResize ? `, with a resize to ${rd.flickerResize}` : ''}; loading in a hidden panel or a screenshot, humans cause it too` });
  }
  if (rd && rd.renderWhileHiddenMs != null) {
    environment.push({ code: 'RENDER_WHILE_HIDDEN', atMs: rd.renderWhileHiddenMs, detail: 'requestAnimationFrame runs while the document is hidden (renders without being shown); needs a human baseline' });
  }
  // Reading from outside the page's JS world (an extension side panel). Neither fact proves an agent on
  // its own: a panel may be a translator or devtools, a long task may be a heavy widget. Together, with
  // nobody touching the page, they are what an assistant reading this document looks like from inside it.
  const sf = early?.surface;
  if (sf) {
    const panel = sf.panelOpenedMs != null && sf.panelClosedMs == null;   // still open beside the page
    const scanned = sf.scans > 0 && sf.firstScanMs != null;
    if (panel && scanned) {
      attached.push({ code: 'PANEL_PAGE_READ', atMs: Math.max(sf.panelOpenedMs!, sf.firstScanMs!), detail: `side panel took ${sf.panelWidthPx}px, ${sf.scanAfterPanelMs ?? '?'} ms later ${sf.longestScanMs} ms of main-thread work ran with no user input on the page (read from an isolated world)` });
      tools.add('browser-panel');
    } else {
      if (panel) environment.push({ code: 'SIDE_PANEL_OPENED', atMs: sf.panelOpenedMs!, detail: sf.panelAtLoad ? `at page load the window was ${sf.panelWidthPx}px wider than the viewport: a side panel was open (browser zoom can look the same)` : `side panel opened: innerWidth shrank by ${sf.panelWidthPx}px, outerWidth and dpr unchanged` });
      if (scanned) environment.push({ code: 'IDLE_PAGE_SCAN', atMs: sf.firstScanMs!, detail: `${sf.scans} bursts of main-thread work up to ${sf.longestScanMs} ms, with no user input` });
    }
  }
  if (rd?.loadedHidden) {
    environment.push({ code: 'LOADED_HIDDEN', atMs: early?.startedMs ?? 0, detail: 'page loaded while hidden' });
  }

  const app = appToken;
  if (app) {
    environment.push({ code: 'AGENT_APP_BROWSER', atMs: 0, detail: `${app}${server?.environment?.clientHints === false ? ', no Sec-CH-UA headers' : ''}` });
    tools.add(extraAppToken(app)?.tool ?? (app.startsWith('Claude') ? 'claude-app' : app.split('/')[0]!.toLowerCase() + '-app'));
  }
  if (early?.environment.codexModelContext) { environment.push({ code: 'CODEX_MODEL_CONTEXT', atMs: early.startedMs, detail: '__codexWebMcpModelContext in page globals' }); tools.add('codex-app'); }
  for (const id of early?.environment.extensionsInstalled ?? []) { environment.push({ code: 'AGENT_EXTENSION_INSTALLED', atMs: early?.startedMs ?? 0, detail: `${id} installed` }); tools.add(id); }
  const injectedNames = new Set(injected.map((g) => g.name));
  const globals = (early?.environment.agentGlobals ?? []).filter((g) => g !== '__codexWebMcpModelContext' && !injectedNames.has(g));
  if (globals.length) { environment.push({ code: 'AGENT_PAGE_GLOBALS', atMs: early?.startedMs ?? 0, detail: globals.slice(0, 3).join(', ') }); for (const g of globals) tools.add(g.startsWith('__codex') ? 'codex-chrome' : g.startsWith('__claude') ? 'claude-tools' : 'unknown-tool'); }
  if (early?.environment.clipboardBridge) { environment.push({ code: 'CLIPBOARD_BRIDGE', atMs: early.environment.clipboardBridgeAtMs ?? 0, detail: 'browser-use clipboard bridge' }); tools.add('codex-app'); }

  if (attached.length) {
    if (!tools.size && attached.some((e) => e.code === 'MAIN_WORLD_READ_BURST' || e.code === 'MAIN_WORLD_TEXT_EXTRACT')) tools.add(app ? 'claude-app' : 'cdp-reader');
    return { state: 'agent_attached', atMs: Math.min(...attached.map((e) => e.atMs)), evidence: [...attached, ...environment], tools: [...tools], version: CONNECTION_VERSION };
  }
  if (environment.length) {
    return { state: 'agent_environment', atMs: Math.min(...environment.map((e) => e.atMs)), evidence: environment, tools: [...tools], version: CONNECTION_VERSION };
  }
  return { state: 'no_indication', atMs: null, evidence: [], tools: [], version: CONNECTION_VERSION };
}

export const CONNECTION_TITLES: Record<ConnectionState, string> = {
  signed_agent: 'Signed agent: verified on the server',
  agent_attached: 'Agent attached',
  agent_environment: 'Agent environment: could be a human or an agent',
  no_indication: 'No trace at connection time',
};
