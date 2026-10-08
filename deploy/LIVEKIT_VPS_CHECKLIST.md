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
| Rollback | None needed: the old Let's Encrypt `turn.offoolive.com` lineage was deleted on 2026-10-08 after 0 rejections (backup tarball `/root/le-turn.offoolive.com-lineage-20261008.tgz`). Going back to it would bring the rejections back. |
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

## Firewall (UFW), tightened 2026-10-08

Open: `22/tcp`, `80/tcp` (certbot), `443/tcp`, `7881/tcp`, `3478/udp`, `5349/tcp`,
`50000:60000/udp` (media), `30000:40000/udp` (TURN relay).

Closed on purpose: `7880/tcp` (LiveKit API, plain HTTP; Live-server and ol-node-rest reach it via
`wss://stream.offoolive.com` on 443, egress via 127.0.0.1), `7882/udp`, `5349/udp`,
`40000:60000/tcp` and the overlapping `40000:60000/udp` (nothing listens there). Redis `6379` was
never allowed. Backups: `/etc/ufw/user{,6}.rules.bak-20261008-pre-live03`. Per-rule hit counters:
`iptables -L ufw-user-input -v -n -x`. The Hostinger panel firewall is separate and must be checked
in the panel.

## Containers: pinned versions

The containers run with `--network host` and `--restart unless-stopped`. A `docker restart` or a
reboot reuses the existing image and never upgrades; only a re-`docker run` does, so always recreate
through the pinned script (it drops all rooms for `livekit-server`):

```bash
/usr/local/sbin/livekit-containers.sh recreate livekit-server   # livekit/livekit-server:v1.13.5
/usr/local/sbin/livekit-containers.sh recreate livekit-egress   # livekit/egress:v1.14.1
/usr/local/sbin/livekit-containers.sh recreate redis            # redis:8.10.0-alpine, 127.0.0.1 only
```

The egress config (it holds the API secret) is in `/etc/livekit-egress.yaml` (0600), not inline in
the script. To upgrade, bump the tag in the script, `docker pull` it, then recreate when idle.

## HLS output (egress)

Egress writes LL-HLS to `/var/www/hls/streams/<room>` on this VPS and nginx serves `/hls/`.
`/etc/cron.d/livekit-hls-cleanup` deletes segments older than 2 minutes and room folders idle for an
hour. Live-server's own cleaner only runs where that folder is local, so it does nothing on GCP.

## Next iteration (not done)

Ghost `is_live` streams when LiveKit connect fails after go-live API — client `endStream` rollback
(app side, LIVE-08). Server side: the ghost sweep ends them after 20 s, and each one now shows up in
admin, Live moderation, "Go-live / join failures" (LIVE-06).
