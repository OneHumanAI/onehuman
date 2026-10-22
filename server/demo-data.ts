// SPDX-License-Identifier: BUSL-1.1
/**
 * Synthetic demo account. Lives only on the server and is generated per
 * session, so nothing sensitive is in the static bundle. All values are fake.
 */
import { createHash } from 'node:crypto';

export type Profile = { name: string; email: string; phone: string; iban: string; accountType: string; customerSince: string };
export type Balance = { available: number; currency: string; blocked: number; asOf: string };
export type Transaction = { id: string; date: string; title: string; category: string; amount: number | null };

export function seeded(seed: string) {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    return h / 0xffffffff;
  };
}

export const FIRST_NAMES = ['Ada', 'Marcus', 'Priya', 'Daniel', 'Sofia', 'Liam', 'Amara', 'Noah', 'Elena', 'Omar'];
export const LAST_NAMES = ['Lindqvist', 'Okafor', 'Ramírez', 'Chen', 'Novak', 'Haddad', 'Kowalski', 'Bennett'];
const TITLES: [string, string, number][] = [
  ['Whole Foods Market', 'Groceries', -84.2], ['Spotify', 'Subscriptions', -10.99], ['Salary: Northwind Ltd', 'Income', 4250], ['Uber Eats', 'Dining', -27.4],
  ['Verizon Wireless', 'Utilities', -65], ['ConEd Electricity', 'Utilities', -112.3], ['Lyft', 'Transport', -14.6], ['Netflix', 'Subscriptions', -15.49],
  ['Rent: Maple St. Apartments', 'Housing', -1850], ['Transfer from savings', 'Income', 500],
];

export function demoAccount(sessionId: string): { profile: Profile; balance: Balance; transactions: Transaction[] } {
  const r = seeded(sessionId);
  const first = FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]!;
  const iban = `GB${String(Math.floor(r() * 90 + 10))}NRST${String(Math.floor(r() * 1e14)).padStart(14, '0')}`;
  const profile: Profile = {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@example.test`,
    phone: `+1 (${200 + Math.floor(r() * 700)}) ${String(Math.floor(r() * 900 + 100))}-${String(Math.floor(r() * 9000 + 1000))}`,
    iban,
    accountType: r() > 0.5 ? 'Personal checking' : 'Salary account',
    customerSince: `${2016 + Math.floor(r() * 9)}`,
  };
  const transactions: Transaction[] = [];
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    const t = TITLES[Math.floor(r() * TITLES.length)]!;
    transactions.push({ id: `tx-${i + 1}`, date: new Date(now - i * 86400000 * (1 + Math.floor(r() * 2))).toISOString().slice(0, 10), title: t[0], category: t[1], amount: Math.round(t[2] * (0.9 + r() * 0.2) * 100) / 100 });
  }
  const balance: Balance = { available: Math.round((1500 + r() * 4000) * 100) / 100, currency: 'USD', blocked: Math.round(r() * 120 * 100) / 100, asOf: new Date(now).toISOString() };
  return { profile, balance, transactions };
}

/** Masking keeps structure but removes the sensitive value. */
export function maskProfile(p: Profile): Profile {
  return {
    name: p.name.split(' ').map((s) => s[0] + '•••').join(' '),
    email: p.email.replace(/^(.).*(@.*)$/, '$1•••$2'),
    phone: p.phone.replace(/\d(?=.*\d{2}$)/g, '•'),
    iban: p.iban.slice(0, 4) + ' •••• •••• ' + p.iban.slice(-4),
    accountType: p.accountType,
    customerSince: p.customerSince,
  };
}

/** Masked search keeps date and category only; merchant and amount are removed on the server. */
export function maskTransactions(list: Transaction[]): Transaction[] {
  return list.map((t) => ({ ...t, title: t.category, amount: null }));
}

export function toCsv(profile: Profile, balance: Balance, tx: Transaction[]): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['﻿Date,Description,Category,Amount,Currency'];
  for (const t of tx) lines.push([t.date, t.title, t.category, t.amount ?? '', balance.currency].map(esc).join(','));
  lines.push('', `Account holder,${esc(profile.name)}`, `IBAN,${esc(profile.iban)}`, `Balance,${esc(balance.available)}`);
  return lines.join('\n');
}
