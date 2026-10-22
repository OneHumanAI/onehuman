// SPDX-License-Identifier: BUSL-1.1
/**
 * Agent signatures in force in this process: the built-in ones in signals.ts / connection.ts / web-bot-auth.ts,
 * plus whatever the newest verified signature bundle added. The bundle is checked before it gets here
 * (integrations/signatures/common.ts); this module only holds it and answers lookups. Additive only.
 */
type Rules = {
  markers?: { name: string; selector: string; tool: string; control: boolean }[];
  globals?: { name: string; tool: string; control: boolean }[];
  globalPrefixes?: string[];
  appUserAgents?: { token: string; tool: string }[];
};

export type SignatureState = { seq: number; issued: number | null; source: 'builtin' | 'cache' | 'portal'; note: string | null };

let state: SignatureState = { seq: 0, issued: null, source: 'builtin', note: null };
let markers = new Map<string, { tool: string; control: boolean; selector: string }>();
let globals = new Map<string, { tool: string; control: boolean }>();
let prefixes: string[] = [];
let appTokens: { token: string; tool: string }[] = [];
let appRe: RegExp | null = null;
let clientRulesJson = '';

/** Put a verified bundle in force (replaces the previous bundle's additions; the built-ins always stay). */
export function applySignatures(rules: Rules, meta: Omit<SignatureState, 'source'> & { source: 'cache' | 'portal' }) {
  markers = new Map((rules.markers ?? []).map((m) => [m.name, { tool: m.tool, control: m.control, selector: m.selector }]));
  globals = new Map((rules.globals ?? []).map((g) => [g.name, { tool: g.tool, control: g.control }]));
  prefixes = [...(rules.globalPrefixes ?? [])];
  appTokens = [...(rules.appUserAgents ?? [])];
  appRe = appTokens.length ? new RegExp(`\\b(${appTokens.map((t) => t.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\/[\\w.]+`) : null;
  const client = { probes: [...markers].map(([name, m]) => [name, m.selector]), control: [...markers].filter(([, m]) => m.control).map(([n]) => n), globals: [...globals].filter(([, g]) => g.control).map(([n]) => n), prefixes };
  clientRulesJson = markers.size || globals.size || prefixes.length ? JSON.stringify(client) : '';
  state = { ...meta };
}
/** back to the built-ins only (tests) */
export function resetSignatures() { applySignatures({}, { seq: 0, issued: null, source: 'cache', note: null }); state = { seq: 0, issued: null, source: 'builtin', note: null }; }

export const signatureState = (): SignatureState => state;
export const extraMarker = (name: string) => markers.get(name) ?? null;
export const extraMarkerCount = () => markers.size;
export const extraGlobal = (name: string) => globals.get(name) ?? null;
export function extraAppToken(ua: string): { token: string; tool: string } | null {
  const m = appRe?.exec(ua);
  if (!m) return null;
  return { token: m[0], tool: appTokens.find((t) => m[1] === t.token)?.tool ?? 'unknown-tool' };
}
/** what the page script needs to know (new probes, control markers, control globals, prefixes), or '' */
export const clientSignatureRules = () => clientRulesJson;
