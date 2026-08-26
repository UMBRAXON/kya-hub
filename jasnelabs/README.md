# jasnelabs.eu — Next.js hub

App: `/root/kya-hub/jasnelabs-web`  
PM2: `jasnelabs` · port **3011**  
Proxy: `jasnelabs-proxy` → host:3011

## Locales
- `/` — SK (motto: *Dôverujeme dátam. Všetko ostatné je len šum.*)
- `/en` — EN (*In data we trust. Everything else is just noise.*)

## Deploy
```bash
cd /root/kya-hub/jasnelabs-web
npm run build
pm2 restart jasnelabs
```

## UFW
`3011/tcp` from `172.18.0.0/16` (Docker → host).
