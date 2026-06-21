# Deploy the Motherboard backend on Oracle Cloud "Always Free" (Mumbai)

A genuinely-$0, always-on, India-region home for the FastAPI backend. The card
Oracle asks for at signup is for **identity verification only** — the Always
Free resources used here are *never billed*.

**What you get:** an Ubuntu VM in Mumbai running the backend in Docker behind
Caddy (automatic HTTPS), reachable at `https://<your-name>.duckdns.org`.

**Time:** ~30–45 min, most of it clicking through the Oracle console once.

Everything the VM needs is in [`deploy/`](deploy/): `docker-compose.yml`,
`Caddyfile`, `.env.example`, and `setup.sh`.

---

## 1. Create the Oracle Cloud account
1. Go to <https://www.oracle.com/cloud/free/> → **Start for free**.
2. **Pick `India South (Mumbai)` as your Home Region** — this can't be changed
   later and is what gives you ~30 ms latency. (Hyderabad also works.)
3. Add the verification card. Always Free never charges; to be doubly safe,
   later set **Billing → Cost Management → Budgets** with a $1 alert.

## 2. Launch the VM
1. Console → **Compute → Instances → Create instance**.
2. **Image:** Canonical **Ubuntu 22.04**.
3. **Shape:** click *Change shape* →
   - First try **Ampere (Arm) `VM.Standard.A1.Flex`**, set **2 OCPU / 12 GB**
     (well within the Always-Free 4-OCPU/24 GB Arm allowance — best for pandas).
   - If Mumbai says *"Out of host capacity"* for Arm (common), fall back to
     **`VM.Standard.E2.1.Micro`** (AMD, 1 OCPU / 1 GB — always available; the
     setup script adds swap-friendly headroom, and the app runs fine on it).
4. **SSH keys:** *Save private key* (you'll need it to log in). 
5. **Networking:** keep "Create new VCN" + "Assign a public IPv4 address".
6. **Create.** When it's *Running*, copy the **Public IP address**.

> Optional but recommended: **Networking → Reserved public IPs** → reserve the
> instance's IP so it never changes. (Reserved IPs are free while attached.)

## 3. Open ports 80 + 443 at the cloud layer
Console → your instance → **Virtual Cloud Network** → **Security Lists** →
default list → **Add Ingress Rules**, add two:

| Source CIDR | IP Protocol | Destination Port |
|-------------|-------------|------------------|
| `0.0.0.0/0` | TCP         | `80`             |
| `0.0.0.0/0` | TCP         | `443`            |

(SSH on 22 is already allowed.) The `setup.sh` script opens the matching
**host** firewall rules — both layers are required on Oracle.

## 4. Point a free DuckDNS domain at the VM
1. <https://www.duckdns.org> → sign in (GitHub/Google, no card).
2. Create a subdomain, e.g. `motherboard-sehej`.
3. Set its **current ip** to your VM's public IP → **update**.
   You now own `motherboard-sehej.duckdns.org`. Copy your DuckDNS **token** too
   (only needed if you later want auto-updates for a non-reserved IP).

## 5. Deploy on the VM
SSH in (from your Mac, using the key you saved):
```bash
chmod 400 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<YOUR_PUBLIC_IP>
```
Then, on the VM:
```bash
sudo apt-get update -y && sudo apt-get install -y git
git clone https://github.com/sehejsharm/Financial-Terminal.git
cd Financial-Terminal
git checkout claude/stock-market-dashboard-2BBMA

cd deploy
cp .env.example .env
nano .env        # set DOMAIN to your duckdns name + fill in secrets, then Ctrl-O, Ctrl-X

bash setup.sh
```
`setup.sh` installs Docker, opens the host firewall, builds the image, and
starts both containers. First run takes a few minutes (image build) plus
~30–60 s for Caddy to fetch the TLS cert.

## 6. Verify
From your Mac (or the VM):
```bash
curl https://<your-name>.duckdns.org/healthz     # {"ok":true,...}
curl https://<your-name>.duckdns.org/diag         # provider status; look for fmp.ok:true
```

## 7. Point the frontend at it
Vercel → project → **Settings → Environment Variables**:
```
NEXT_PUBLIC_API_URL = https://<your-name>.duckdns.org
```
Then **Deployments → ⋯ → Redeploy** so the frontend picks it up. Done — the
backend is now always-on in Mumbai with no cold starts.

---

## Operating it
| Task | Command (in `~/Financial-Terminal/deploy`) |
|------|--------------------------------------------|
| Tail logs | `sudo docker compose logs -f` |
| Restart | `sudo docker compose restart` |
| Update to latest code | `git pull && bash setup.sh` |
| Stop | `sudo docker compose down` |
| Back up user data | `sudo tar czf ~/mb-data-$(date +%F).tgz data/` |

**Persistence:** logins, watchlists, the audit log, and the JWT secret live in
`deploy/data/` on the VM disk and survive restarts and redeploys. The admin
account is also re-seeded from `MOTHERBOARD_ADMIN_*` on every boot.

**Cert won't issue?** It means ports 80/443 aren't reachable. Re-check step 3
(cloud Security List) — that's the usual culprit — then `sudo docker compose
logs caddy`.
