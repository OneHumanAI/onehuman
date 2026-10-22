#!/usr/bin/env bash
# Watches onehuman.ai until it points at Vercel and the portal answers there. Checks every 5 seconds, forever.
#   bash scripts/check-domain.sh            (Ctrl+C to stop)
#   bash scripts/check-domain.sh other.ai   another domain
DOMAIN="${1:-onehuman.ai}"
TLD="${DOMAIN##*.}"
G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; D=$'\e[2m'; N=$'\e[0m'
TLD_NS=$(dig +short "$TLD" NS | head -1)
START=$(date +%s); WAS_READY=0

row() { # icon, title, detail
  printf "  %s  %-32s %s\n" "$1" "$2" "$3"
}

while true; do
  # 1. the registry: which nameservers the .ai registry hands out (this changes first, and only if the registrar sent it)
  REG=$(dig +norec "@$TLD_NS" "$DOMAIN" NS 2>/dev/null | awk '/AUTHORITY SECTION/{f=1;next} f&&/NS/{print $5}' | tr '\n' ' ')
  # 2. what the world sees (Cloudflare and Google resolvers)
  NS_PUB=$(dig +short @1.1.1.1 "$DOMAIN" NS | tr '\n' ' ')
  A_PUB=$(dig +short @1.1.1.1 "$DOMAIN" A | tr '\n' ' ')
  A_GOO=$(dig +short @8.8.8.8 "$DOMAIN" A | tr '\n' ' ')
  # 3. does the portal answer on the domain, over https
  CODE=$(curl -s -o /tmp/.oh-check -w '%{http_code}' --max-time 8 "https://$DOMAIN/api/v1/policy-keys" 2>/dev/null)
  BODY=$(head -c 200 /tmp/.oh-check 2>/dev/null)

  ok_reg=0; ok_dns=0; ok_web=0
  # either way works: Vercel's nameservers, or the registrar's own DNS with an A record to Vercel
  [[ "$REG" == *vercel-dns* ]] && ok_reg=1
  VERCEL_IP='(76\.76\.21\.|216\.198\.79\.|64\.29\.17\.|66\.33\.60\.)'
  [[ "$A_PUB" =~ $VERCEL_IP && "$A_GOO" =~ $VERCEL_IP ]] && ok_dns=1   # both big resolvers already give Vercel's address
  [[ "$CODE" == "200" && "$BODY" == *'"keys"'* ]] && ok_web=1

  NOW=$(date +%H:%M:%S); MIN=$(( ($(date +%s) - START) / 60 ))
  clear
  printf "${B}%s — checking every 5 s${N}  ${D}%s · watching for %s min · Ctrl+C to stop${N}\n\n" "$DOMAIN" "$NOW" "$MIN"
  if [[ $ok_reg == 1 ]]; then row "${G}●${N}" "Nameservers" "${G}${REG}(Vercel)${N}"
  elif [[ $ok_dns == 1 ]]; then row "${G}●${N}" "Nameservers" "${G}${REG}(registrar DNS, A record to Vercel)${N}"
  else row "${Y}●${N}" "Nameservers" "${REG:-no answer}  ${D}← either set ns1/ns2.vercel-dns.com, or add A @ 216.198.79.1 at the registrar${N}"; fi
  [[ $ok_dns == 1 ]] && row "${G}●${N}" "Public DNS (1.1.1.1, 8.8.8.8)" "${G}A ${A_PUB}${N}" || row "${Y}●${N}" "Public DNS (1.1.1.1, 8.8.8.8)" "NS ${NS_PUB:-–}· A ${A_PUB:-–}"
  [[ $ok_web == 1 ]] && row "${G}●${N}" "Portal on https://${DOMAIN}" "${G}answers (HTTP 200)${N}" || row "${R}●${N}" "Portal on https://${DOMAIN}" "HTTP ${CODE:-no answer}"
  echo

  if [[ $ok_dns == 1 && $ok_web == 1 ]]; then
    printf "  ${G}${B}✅  %s is live on Vercel. OneHuman can be published: npm run release -- current${N}\n" "$DOMAIN"
    [[ $WAS_READY == 0 ]] && printf '\a' && { command -v osascript >/dev/null && osascript -e "display notification \"$DOMAIN is live on Vercel\" with title \"OneHuman\" sound name \"Glass\"" 2>/dev/null; }
    WAS_READY=1
  else
    WAS_READY=0
    if [[ $ok_dns == 0 ]]; then
      printf "  ${D}The domain does not point at Vercel yet (A %s). At the registrar open the domain's OWN page — not\n  Default Preferences — and either add A @ 216.198.79.1 (+ CNAME www) or set the Vercel nameservers.\n  Records: minutes to an hour. Nameservers: minutes, at most 24–48 h.${N}\n" "${A_PUB:-none}"
    else
      printf "  ${D}DNS is right; Vercel is issuing the certificate (a few minutes).${N}\n"
    fi
  fi
  sleep 5
done
