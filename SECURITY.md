# Security

Remote PC can control the computer it runs on, so security reports matter a lot.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: the repository's **Security** tab → **Report a vulnerability**. Include steps to reproduce and what an attacker could do. You'll get a reply as soon as possible, and credit in the fix if you want it.

## Scope

In scope: anything that lets someone without the access key read or control the PC, bypass pairing, steal the key, or escape the preview proxy to reach other local services.

Out of scope: attacks that need the access key or physical access to the PC, and setups that expose the server directly to the internet against the README's advice.

## Design notes

- Access key: 192 random bits, compared in constant time, stored in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS). Failed attempts are rate-limited.
- `/pair` (which shows the key as a QR code) only answers requests from the PC itself: loopback connections without proxy headers, so requests forwarded by Tailscale Serve are refused.
- WebSocket upgrades require the cookie and a same-origin `Origin` header.
- The preview proxy only forwards to `localhost` ports and requires the access key.
- Over Tailscale Serve every request arrives from `127.0.0.1`, so the failed-login limit applies to all remote clients together.
