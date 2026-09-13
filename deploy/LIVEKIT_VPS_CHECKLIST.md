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

## Next iteration (not done)

Ghost `is_live` streams when LiveKit connect fails after go-live API — client `endStream` rollback + sweeper.
