# Security Policy

Open KTV is designed to run on a machine you control, most often on your home LAN. It still has
a real attack surface — an HTTP server, an ffmpeg subprocess pipeline, and an upload endpoint —
so please read this page before reporting a vulnerability.

## Supported versions

Only the latest released version receives security fixes. Open KTV does not maintain long-term
support branches.

| Version | Supported |
| --- | --- |
| latest `0.1.x` | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/stubenhuang/open-ktv/security/advisories/new)
(or, if that is unavailable, through a private message to the maintainer).

Include:

- the affected version / commit,
- a description of the impact,
- reproduction steps or a proof of concept,
- any suggested mitigation.

You will get an acknowledgement within **7 days**, and we will agree on a disclosure timeline
with you. We are happy to credit reporters in the release notes unless you prefer to stay
anonymous.

## 报告安全漏洞

**请不要以公开 issue 的形式提交安全问题。**

请通过 [GitHub Security Advisories](https://github.com/stubenhuang/open-ktv/security/advisories/new)
私下报告；若不可用，请私信维护者。请在 7 天内会收到确认。

## Threat model and hardening built in

Understanding the design helps you judge what is — and is not — in scope.

**In scope**

- Remote code execution through the ffmpeg / ffprobe argument pipeline.
- Path traversal in any file-serving or file-writing endpoint.
- SSRF through the library providers (`5sing`, Kugou lyrics, user-supplied
  `LIBRARY_SOURCES` manifests).
- Authentication / authorisation bypass of the `ACCESS_TOKEN` gate.
- Anything that lets an unauthenticated LAN peer read, overwrite or delete another user's
  recordings.

**Hardening already in place**

- **Access token** — set `ACCESS_TOKEN` and every non-loopback request needs it (header
  `x-access-token` or `?token=`). Loopback requests never need it. See the README.
- **Private-network guard** — `LIBRARY_BLOCK_PRIVATE_NET=1` rejects manifest entries that point
  at RFC1918 / loopback / link-local addresses. It is off by default because the documented
  "NAS / LAN manifest" use case *is* a private address.
- **Upload validation** — the backing-track library accepts audio only; video containers are
  rejected client-side and again server-side. Single files are capped at 1 GB.
- **Disk pre-flight** — uploads, downloads and mixes check free space before writing.
- **No third-party runtime dependencies beyond the seven declared in `package.json`**, all from
  the npm registry and pinned through `package-lock.json`.

**Out of scope**

- Anything requiring physical access to the host.
- Anything requiring the victim to install software or visit a site you control.
- Missing hardening on features that are explicitly documented as "turn this on if you need it"
  (`LIBRARY_BLOCK_PRIVATE_NET`, `ACCESS_TOKEN`) when the feature is left off.
- Denial of service through resource exhaustion on a single-user, single-host deployment
  (`data/` filling up, ffmpeg saturating CPU).
- Self-signed certificate warnings on the mobile HTTPS entry — the certificate is generated
  on the host, for the LAN, and the warning is the browser working as intended.

## Best practice for running it

```bash
ACCESS_TOKEN=只有你知道的一串 HOST=127.0.0.1 ./openktv.sh start
```

- `HOST=127.0.0.1` if you only ever sing from the host machine — this also disables the mobile
  entry entirely, which is the strongest option.
- `ACCESS_TOKEN=…` if you do use the mobile entry on a shared network.
- Run it as an unprivileged user; it does not need root.
- Do not expose it directly to the public internet. Put it behind a reverse proxy you trust,
  with TLS, if you must.
