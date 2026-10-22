// SPDX-License-Identifier: BUSL-1.1
/** Dashboard routes: policy read/write per room. No auth in the lab — the room link is the scope. */
import type { OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, url, UUID, type Req, type Res } from '../http.ts';
import { parsePolicy } from '../policy.ts';

export function adminRoutes(engine: OneHuman) {
  const store = engine.store;

  const getPolicy = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found' });
    json(res, 200, { policy: await engine.policyFor(room), history: await store.policyHistory(room), isDefault: (await store.currentPolicy(room)) === null });
  };

  const putPolicy = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const room = url(req).searchParams.get('room') ?? '';
    if (!UUID.test(room) || !(await store.roomExists(room))) return json(res, 404, { error: 'room_not_found' });
    const body = await readJson(req, 32000);
    const n = (await store.policyHistory(room)).length + 1;
    const policy = parsePolicy(body, `policy-${room.slice(0, 8)}-v${n}`);
    if (!policy) return json(res, 400, { error: 'bad_policy', message: 'Invalid policy document.' });
    await store.savePolicy(room, policy);
    json(res, 200, { policy });
  };

  return { getPolicy, putPolicy };
}
