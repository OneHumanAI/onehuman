# Buraxılış — `onehumanai` npm paketi

Bir paket: middleware, brauzer SDK-sı, CLI (Apache-2.0) və engine (`dist/engine.js`, BUSL-1.1).

```bash
npm login                            # onehumanai hesabı (2FA)
npm run release -- current           # package.json-dakı versiya nəşr olunur
npm run release -- patch             # 0.6.0 → 0.6.1
npm run release -- patch --dry-run   # nəşr etmədən hər şeyi yoxla
```
Skript: `npm run check` → versiya → `node scripts/build-package.mjs` → `npm publish` → git commit + tag `onehumanai-vX.Y.Z`. Hər buraxılışdan əvvəl `packages/onehumanai/CHANGELOG.md`-yə bir sətir yaz.

Müştəri tərəfində: `npx onehumanai init` (və ya `npm i onehumanai`), `import { onehuman } from 'onehumanai'`.
