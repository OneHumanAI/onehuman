// SPDX-License-Identifier: BUSL-1.1
/**
 * The OneHuman engine's public surface (dist/engine.js in the onehumanai package).
 *
 * Everything the open integrations (the Express middleware, future adapters) need from the engine is
 * exported here and nowhere else. The open package imports only this module, so the build can publish it
 * as a separate package under its own licence, and no engine code is ever copied into the open one.
 */
export type { Assessment } from './assess.ts';
export { SERVER_LIMITS, Store, type DecisionRow, type SessionRow, type StoreLimits } from './db.ts';
export { OneHuman, publicDecision, type DecideResult } from './engine.ts';
export { attachModel } from './kinematics.ts';
export { loadModel, predict } from './kinematics-model.ts';
export { cookies, json, url } from './http.ts';
export { checkPolicy, parsePolicy, type Policy } from './policy.ts';
export { sessionRoutes } from './routes/session.ts';
export { webauthnRoutes } from './routes/webauthn.ts';
export { accessRoutes } from './routes/access.ts';
export { libsqlClient, sqliteClient, type SqlClient } from './sql.ts';
export { proverFromSecret, sessionDigest, type Prover } from './proof.ts';
export { applySignatures, clientSignatureRules, signatureState } from './signatures.ts';
export { anchorChains, headDigest, timestampStatus, type AnchorResult } from './anchor.ts';

/**
 * The engine's package version, stamped by the build (`0.0.0-dev` when run from source). `onehumanai`
 * compares it with its own at startup: the two packages are released together and a mismatch means a broken
 * install (a lockfile pinning an old engine, or the engine added by hand).
 */
declare const __ONEHUMAN_ENGINE_VERSION__: string | undefined;
export const ENGINE_VERSION: string = typeof __ONEHUMAN_ENGINE_VERSION__ === 'string' ? __ONEHUMAN_ENGINE_VERSION__ : '0.0.0-dev';
