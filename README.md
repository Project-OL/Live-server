# offoo-streaming-me

## LiveKit (self-hosted SFU)

Template + WiFi/TURN deploy checklist:

- [`livekit.yaml`](./livekit.yaml) — SFU config (`turn.offoolive.com` TLS on 5349)
- [`deploy/LIVEKIT_VPS_CHECKLIST.md`](./deploy/LIVEKIT_VPS_CHECKLIST.md)
- [`deploy/nginx-sni-mux.example.conf`](./deploy/nginx-sni-mux.example.conf) — public :443 SNI mux

Client signaling: `wss://stream.offoolive.com`. TURNS advertised as `turns:turn.offoolive.com:443`.
Restarting LiveKit drops all live rooms.
