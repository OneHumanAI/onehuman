// SPDX-License-Identifier: Apache-2.0
// Acme Bank — the smallest possible OneHuman integration (Express 5).
//   node examples/express-bank/server.mjs   →  http://localhost:3000
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onehuman } from '../../integrations/express/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// --- 1. one line: SDK + its API under /onehuman, policy from your file, storage on your disk ---
const oh = await onehuman({ secret: process.env.ONEHUMAN_SECRET ?? 'dev-secret-change-me-dev-secret-change-me', policy: join(here, 'onehuman.policy.json'), db: 'sqlite:./examples/express-bank/onehuman.db' });
app.use(oh.middleware());

// --- 2. your data and your own mask functions ---
const account = { owner: 'Ada Lindqvist', iban: 'GB29NWBK60161331926819', balance: 2920.74, currency: 'USD' };
const maskBalance = (a) => ({ ...a, balance: null, iban: a.iban.slice(0, 4) + ' •••• ' + a.iban.slice(-4) });
const maskProfile = (a) => ({ owner: a.owner.split(' ')[0] + ' •.', iban: '•••• ' + a.iban.slice(-4) });

// --- 3. protect the endpoints that return the data ---
app.get('/api/balance', oh.protect('balance.read'), (req, res) => oh.send(req, res, account, maskBalance));
app.get('/api/profile', oh.protect('profile.read'), (req, res) => oh.send(req, res, { owner: account.owner, iban: account.iban }, maskProfile));
app.post('/api/transfer', oh.protect('transfer.make'), (req, res) => {
  // req.onehuman.decision is allow here (block / step_up were answered by protect); your own business checks follow
  res.json({ ok: true, to: req.body?.to ?? null, amount: req.body?.amount ?? 0, _onehuman: { decision: req.onehuman.decision, actor: req.onehuman.actor } });
});

app.use(express.static(join(here, 'public')));
app.listen(3000, () => console.log('Acme Bank on http://localhost:3000  (OneHuman at', oh.basePath + ')'));
