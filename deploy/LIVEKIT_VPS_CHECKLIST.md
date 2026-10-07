# LiveKit VPS checklist (go-live / WiFi)

## Production (Hostinger) — current

| Piece | Value |
|---|---|
| Signaling WSS | `wss://stream.offoolive.com` (SNI → nginx `127.0.0.1:8443` → LiveKit `:7880`) |
| TURNS | `turns:turn.offoolive.com:443` (SNI → LiveKit TLS `:5349`) |
| TURN UDP | `3478` |
| RTC TCP | `7881` |
| Media UDP | `50000–60000` |
| TURN relay UDP | `30000–40000` |

DNS:

- `stream.offoolive.com` A → VPS IP
- `turn.offoolive.com` A → VPS IP

Config refs:

- [`../livekit.yaml`](../livekit.yaml)
- [`nginx-sni-mux.example.conf`](./nginx-sni-mux.example.conf)

## Verify

```bash
getent hosts turn.offoolive.com stream.offoolive.com
ss -lntp | grep -E '443|8443|5349|7880|7881'
docker logs livekit-server 2>&1 | grep -E 'TURN|external IP|starting LiveKit' | tail -20
openssl s_client -connect turn.offoolive.com:443 -servername turn.offoolive.com </dev/null | openssl x509 -noout -subject
curl -sS -o /dev/null -w '%{http_code}\n' https://stream.offoolive.com/
```

On restrictive WiFi: go live; ICE should use **relay** via TURNS on 443.

Restarting `livekit-server` drops all active rooms.

## TURN certificate: must not be Let's Encrypt

The app's WebRTC (Flutter SDK, libwebrtc) checks the TURN/TLS certificate against its **own
built-in root list** (`rtc_base/ssl_roots.h`), not the phone's. That list has DigiCert, GlobalSign,
Sectigo/USERTrust, GTS R1-R4, Entrust and GoDaddy, and **no ISRG / Let's Encrypt root**.

From 2026-09-11 to 2026-10-07 the turn cert was from Let's Encrypt. Every TURNS-on-443 attempt was
rejected (`TLS handshake failed: remote error: tls: unknown certificate authority`, 250-5,500 a
day), so users on WiFi that blocks UDP could never connect.

| | |
|---|---|
| Cert | certbot cert-name **`turn-gts`**, issued by **Google Trust Services** ACME: RSA 2048, chain `WR1 -> GTS Root R1 -> GlobalSign Root CA` |
| ACME account | GTS (`https://dv.acme-v02.api.pki.goog/directory`). The account was registered with an EAB key from GCP project `offoo-prod` (`gcloud publicca external-account-keys create --configuration=offoo-new --project=offoo-prod`). Renewals reuse the account; no new key is needed. |
| Renewal | Automatic via `certbot.timer`. The deploy hook `/etc/letsencrypt/renewal-hooks/deploy/livekit-turn-pending.sh` only sets `/var/lib/livekit-restart-pending`; cron `/etc/cron.d/livekit-turn-cert-restart` runs `/usr/local/sbin/livekit-restart-if-pending.sh` at 22:30 UTC (04:00 IST), which does `docker restart livekit-server` (restart, not recreate, so the `:latest` image is not re-pulled). |
| Restart when nobody is live | `/usr/local/sbin/livekit-restart-when-idle.py` restarts LiveKit at the first moment with 0 participants. |
| Rollback | `/etc/livekit.yaml.bak-20261007-pre-gts` (old LE paths), then `docker restart livekit-server`. The old LE `turn.offoolive.com` lineage was left in place. |
| `stream.offoolive.com` | Stays on Let's Encrypt. Signaling TLS is checked by the OS/Dart, which trusts ISRG. |

Verify that a TURN cert will be accepted by the app, before restarting LiveKit:

```bash
cd /root/turn-cert-fix   # webrtc-roots.pem = ssl_roots.h converted with webrtc_roots_to_pem.py
openssl verify -no-CApath -no-CAstore -CAfile webrtc-roots.pem \
  -untrusted /etc/letsencrypt/live/turn-gts/chain.pem /etc/letsencrypt/live/turn-gts/cert.pem   # must say OK
```

`-no-CApath -no-CAstore` matters: without it, openssl also trusts the server's own store and a
Let's Encrypt cert falsely passes.

Health signal: `docker logs --since 24h livekit-server 2>&1 | grep -c "unknown certificate authority"`
should be about 0, and `participant active` lines should show some `"connectionType": "turn"`.

## Next iteration (not done)

Ghost `is_live` streams when LiveKit connect fails after go-live API — client `endStream` rollback + sweeper.
