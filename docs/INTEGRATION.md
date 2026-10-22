# İnteqrasiya — Express / Node (3 sətir)

```bash
npm i onehumanai      # Node ≥ 22.13
```

Yeganə quraşdırma budur. `onehumanai` paketi middleware, SDK və CLI-ni (Apache-2.0) və engine-i (BUSL-1.1, produksiyada istifadə icazəlidir) birlikdə gətirir; engine-i ayrıca əlavə etmək və ya import etmək lazım deyil. İstifadə etdiyiniz hər şey `onehumanai` və `npx onehumanai` altındadır.

Bank, CRM və ya sığorta şirkəti OneHuman-i öz backend-inə **middleware** kimi qoşur. Qaydalar şirkətin öz JSON faylındadır, maskalama şirkətin öz funksiyasıdır, autentifikasiyaya toxunulmur, məlumat bazası şirkətin öz diskindədir (on-prem).

```js
import { onehuman } from 'onehumanai';

const oh = await onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: './onehuman.policy.json', db: 'sqlite:./onehuman.db' });
app.use(oh.middleware());                                    // 1. SDK + onun API-si /onehuman altında
app.get('/api/balance', oh.protect('balance.read'),          // 2. qərar nöqtəsi: məlumatı qaytaran endpoint
  (req, res) => oh.send(req, res, account, maskBalance));    // 3. allow → tam, mask → sizin mask funksiyanız
```

Səhifəyə bir teq: `<script src="/onehuman/sdk.js"></script>` və ekranda göstərilən həssas elementə `data-oh-sensitive="full"`. Sorğuları `OneHuman.fetch(url)` ilə göndərin (adi `fetch`-in üstündə, klik telemetriyasını başlığa əlavə edir).

İşləyən nümunə: `node examples/express-bank/server.mjs` → http://localhost:3000

## Nə baş verir

1. `middleware()` hər brauzerə (və ya `identify()` ilə hər login sessiyasına) bir OneHuman sessiyası verir; SDK səhifədən passiv siqnalları (`/onehuman/signals`) göndərir.
2. `protect('balance.read')` sorğu gələndə qərar verir: server müşahidələri (imza, başlıqlar) + SDK telemetriyası (markerlər, oxuma partlayışı, kursor kinematikası) → `assess` → sizin qaydanız → audit sətri (hash-zəncir).
3. Nəticə `req.onehuman`-də: `decision` (`allow | mask | block | step_up`), `masked`, `actor`, `score`, `reasonCodes`, `stepUp`, `token()`.
   - `block` → 403 və `step_up` → 428 avtomatik cavablanır (`respond: false` ilə özünüz idarə edə bilərsiniz).
   - `mask` → handler-iniz çağırılır, `req.onehuman.masked === true`; `oh.send(req, res, full, mask)` maskanı tətbiq edir.
4. Agent qoşulan an SDK ekrandakı `data-oh-sensitive="full"` sahələri yerindəcə gizlədir (`onehuman:sealed` hadisəsi), səhifə istəsə yenidən sorğu göndərir.

## Seçimlər

| Seçim | Mənası | Default |
|---|---|---|
| `secret` | ≥32 bayt; tokenlər və tenant otağı bundan çıxır, dəyişməz olmalıdır | — (məcburi) |
| `policy` | JSON faylının yolu və ya obyekt. `apiKey` varsa ilk startda portala 1-ci versiya kimi gedir, sonra server qaydanı portaldan oxuyur (aşağıya bax) | `apiKey` yoxdursa məcburi |
| `policyFromPortal` | `false` — qayda yalnız fayldan (internetsiz server) | `apiKey` varsa `true` |
| `db` | `sqlite:./onehuman.db` · `memory` · `libsql://host?authToken=…` | `sqlite:./onehuman.db` |
| `basePath` | SDK və API-nin yolu | `/onehuman` |
| `identify(req)` | sizin login sessiya/istifadəçi id-niz → bir loginin bütün tabları bir OneHuman sessiyası | cookie ilə brauzer başına |
| `cookie` | cookie adı | `oh_sid` |
| `respond` | block/step_up-ı middleware cavablasın | `true` |
| `webauthnReclaim` | agent bloklanandan sonra "Mən insanam" passkey yolu | `true` |
| `tenant` | çoxtenant quraşdırmada otaq adı | `default` |

## Qayda portalda saxlanılır

`apiKey` verilibsə, qaydanın əsas yeri portaldır:
- **İlk start:** `onehuman.policy.json` portala gedir və 1-ci versiya olur — təsdiq istəmir.
- **Sonra:** server hər dəqiqə qaydanı portaldan oxuyur. Portalda edilən dəyişiklik bir dəqiqəyə tətbiq olunur, deploy lazım deyil.
- **Faylı developer və ya agent dəyişəndə:** dəyişiklik portala gedir. Default olaraq dərhal tətbiq olunur. Portalın Policy səhifəsində "Ask me before a change from code takes effect" açılsa, dəyişiklik təsdiq gözləyir.
- **Qorumanı zəiflədən dəyişiklik** (qaydanın silinməsi, `block` → `allow`, `enforce` → `observe`) təsdiq və hesab şifrəsi istəyir. Bu yoxlamanı söndürmək də şifrə istəyir.
- **İmza:** portal hər versiyanı yalnız sizin açar üçün imzalayır. Server portalın açarını ilk dəfə yadda saxlayır və imzasız və ya dəyişdirilmiş qaydanı qəbul etmir. Portal əlçatmaz olanda son imzalı nüsxə ilə işləyir.
- **Qaydanın haradan gəldiyini görmək:** hər dəyişiklikdə log sətri yazılır, `oh.policySource()` və `/onehuman/health` da göstərir. `NODE_ENV=production` deyilsə, cavabda `X-OH-Policy-Source: portal | cache | file` başlığı olur.

## Qayda faylı

```json
{
  "version": "acme-bank-policy-1",
  "enforcement": "observe",
  "rules": [
    { "resource": "balance.read", "title": "Balans",
      "onAgent": "block", "onArtifact": "mask", "onUnknown": "allow", "onHumanLike": "allow",
      "actOn": ["verified", "strong", "control", "behavioral"], "minScore": 65 }
  ]
}
```

- `enforcement: "observe"` — heç nə bloklanmır, amma hər qərar "əgər enforce olsaydı" ilə yazılır. **İlk 1–2 həftə belə başlayın**, sonra `enforce`.
- Budaqlar: `onAgent` (agent sübutu), `onArtifact` (yalnız mühit izi: AI tətbiqinin brauzeri, genişləndirmə), `onUnknown` (siqnal kifayət deyil — insan sayılmır!), `onHumanLike` (kinematik/davranış insan sübutu və ya passkey).
- `actOn` — hansı sübut mərtəbələri `onAgent`-i işə sala bilər; `minScore` yalnız davranış mərtəbəsi üçün.

## Step-up və insan geri alması

- `step_up` cavabında `stepUp.challenge` var; demo axını `POST /onehuman/step-up {id, answer}`. Real sistemdə buranı öz OTP/push axınınızla əvəz edirsiniz: təsdiqdən sonra `oh.engine.store.grantStepUp(sessionId, resource, ttlMs)` çağırın, növbəti sorğu keçir. AI agent sorğusunda (`stepUp.approve: true`) təsdiq yalnız saxlanılan həmin sorğunu buraxır: eyni metod, yol və body (`webauthn/assert/options {stepUpId: stepUp.id, purpose: 'approve'}`). Başqa alıcı və ya məbləğ öz təsdiqini gözləyir. İstifadəçiyə `stepUp.summary` göstərin; öz təsvirinizi `protect(resource, { describe: (req) => '...' })` ilə verin.
- Agent blokundan sonra istifadəçi Touch ID/passkey ilə sessiyanı 5 dəqiqəlik geri alır: `POST /onehuman/webauthn/register|assert` (SDK-nın nümunə UI-si `web/product.js`-dədir).

## Digər platformalar

Eyni HTTP müqaviləsi ilə Spring (Java), ASP.NET, Go, Python üçün paketlər planlaşdırılır. Onlara qədər istənilən stack qərarı `POST /v1/decide` ilə ala bilər (engine-in `decide()` funksiyasının HTTP forması) — Node xidməti şirkətin şəbəkəsində sidecar kimi işləyir.

## SDK nə toplayır (məxfilik)

Yalnız metadata: klik basma müddəti, pressure, kursor yolunun nöqtələri (ekran koordinatları, 1.5 s), klaviatura *fasilələri* (düymə adları yox), məlum agent alətlərinin DOM markerləri və qlobal adları, sənədin görünürlük halı. Mətn, düymə identifikasiyası və form məzmunu heç vaxt göndərilmir.
