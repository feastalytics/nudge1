# Feast internal pilot on AWS

This deployment is for Feast staff operating explicitly allowlisted Feast-owned
Instagram accounts. It is a separate Nudge service, opened from Feast admin. It
does not add Nudge tables or dependencies to the Feast application. The default
release disables sends. These files prepare a deployment; they do not create AWS
resources, configure Meta, publish source, or enable a campaign by themselves.

## Footprint and operating tradeoff

Use one **t3a.medium, Ubuntu 24.04, us-east-1** for the initial pilot. It runs a
TLS reverse proxy, Next web app, persistent worker, daily scheduler, PostgreSQL
16 and Redis 7. The instance has 16 GiB encrypted root storage plus a separate
32 GiB encrypted data volume. Only ports 80/443 are exposed; Postgres and Redis
are on an internal container network. Administration uses AWS Systems Manager,
with no SSH key or port. IMDSv2 is required and its hop limit prevents ordinary
containers from using the instance role.

This is **one host and one availability zone**. Host maintenance or loss stops
the app and sends. The data volume is retained independently of the instance;
daily matched database/queue backups go to private encrypted S3 with 14-day
retention. Those backups briefly stop web, worker and scheduler so the database
and queue are consistent. Budget a recovery point of up to 24 hours and manual
recovery; validate that tradeoff before using the tool for time-critical work.
The daily token and next-reel jobs run at or after 05:00 and 06:00 UTC. Next-reel
campaign activation can therefore take up to a day. On scheduler restart, a
same-day job may run again; these maintenance endpoints must remain idempotent.

The proposed memory limits are starting allocations, not a benchmark. Build
images in CI, not on this host. Observe memory, disk, queue age and CPU credits;
increase the host size if the pilot exceeds these limits. Redis uses AOF with
one-second fsync and `noeviction`; never point BullMQ at a shared cache that can
evict jobs. AOF reduces loss but does not guarantee no lost messages on failure.
Redis's 96 MiB dataset ceiling leaves room within its 320 MiB container limit
for AOF rewrite overhead. Monitor rejected writes, queue backlog and memory;
`noeviction` requires capacity intervention when that ceiling is reached.

### Cost assumptions, checked 2026-10-14

On-demand Linux, us-east-1, 730 hours/month, no credits or commitments:

| Pilot item | Rate | Monthly |
| --- | --- | --- |
| t3a.medium, 2 vCPU / 4 GiB | $0.0376/hour | $27.45 |
| 16 GiB root + 32 GiB data gp3 | $0.08/GiB-month | $3.84 |
| One public IPv4 address | $0.005/hour | $3.65 |
| Fixed subtotal | | **$34.94** |

Allow roughly **$35–45/month** at low volume for the pilot, including a small
amount of S3 backup/image storage and logging. This is a planning allowance, not
a bill cap. It excludes taxes, email services, excess internet traffic, extra
CPU credits, and large backup histories. EBS snapshot storage, if used, is
$0.05/GB-month. The template does not create NAT gateways, an ALB, RDS or
ElastiCache.

A dedicated managed two-AZ comparison is approximately **$246/month before
logs, transfers and extra storage**: two Fargate web tasks at 0.5 vCPU/1 GiB
($36.04), one 0.25 vCPU/0.5 GiB worker ($9.01), RDS PostgreSQL db.t4g.small
Multi-AZ plus 20 GiB gp3 ($52.05), two Redis cache.t4g.small nodes ($46.72),
ALB plus one LCU and two IPv4 addresses ($29.57), and two NAT gateways plus
their IPv4 addresses ($73). Allow $250–280 at low volume. A second worker adds
about $9/month, but requires a singleton/locked polling scheduler. Sharing
existing ALB/NAT resources might lower the incremental cost; no available AWS
inventory access confirmed that capacity.

Rates come from AWS's [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/),
[VPC pricing](https://aws.amazon.com/vpc/pricing/),
[Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/),
[ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) and
[ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/).
Regional instance/storage rates were read from the public pricing feeds backing
those pages, including [EC2 us-east-1](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json),
[RDS](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/rds/USD/current/rds-postgresql-ondemand.json),
[ElastiCache](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/elasticache/USD/current/elasticache.json)
and [EBS](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json).

Existing SQS/Lambda infrastructure cannot run this worker unchanged. It is a
long-running BullMQ/Redis consumer with timers and Redis rate limits. Replacing
that with SQS handlers and scheduled invocations is a code migration, not a
deployment setting. [Lambda has a 15-minute execution limit](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).

## Source, image and Feast PR boundaries

Keep Nudge changes in a separate fork under its AGPL license. Preserve license
and attribution, and expose the exact matching source archive through
`FEAST_SOURCE_URL`. A source link to the unmodified upstream branch is not enough
for a modified build. Do not include Feast's proprietary application in that
archive. A commercial agreement is another route if source disclosure is not
acceptable; this deployment does not make a legal conclusion about combination.

The Feast PR should contain the staff-only launch/session bridge and deployment
configuration, with the service pinned by image digest. The Nudge fork PR owns
SSO, send reliability and these container/deployment files. A temporary external
upstream SHA plus separately versioned patch bundle can produce equivalent
images, but the complete resulting source still needs to be offered and its
patches tested. Prefer the separate fork because it makes the tested source and
license boundary inspectable. Do not fetch `main` or clone source at runtime.

## Provisioning scope

`deploy/host.yml` creates an instance and profile, security group, optional EIP,
encrypted retained data volume, immutable-tag ECR repository, private versioned
S3 bucket and an **empty retained Secrets Manager secret**. Supply an existing
VPC and a public subnet within it that already has an Internet Gateway route.
Ubuntu package installation is the only bootstrapping in user data; secrets,
source checkout and application deployment are separate.

The deployment identity needs scoped CloudFormation/EC2/EBS/EIP/security-group,
IAM role/profile/policy and PassRole permissions, plus ECR, S3 and Secrets
Manager resource creation. The operator also needs ECR image push, S3 release
upload, secret population, and SSM session/Run Command access. DNS changes are
separate, scoped to the chosen hostname. No ECS/RDS/ElastiCache permissions are
needed for this pilot. The host role can only read its one secret, pull its own
ECR repository, read releases/backups and write backup objects in its own bucket,
plus the standard SSM agent permissions. It cannot deploy other infrastructure.

Review a CloudFormation change set with `CAPABILITY_IAM` before applying it.
The existing identity's denied ECS/RDS/ElastiCache inventory does not authorize
broader permissions or prove those services are absent. No provisioning or
inventory calls are part of this template preparation.

Record the stack outputs: instance ID, data volume ID, secret ARN, bucket,
repository URI and public IP. Point the chosen Nudge DNS name to that IP before
starting Caddy. Leaving `AllocateElasticIp=false` makes the IP change on stop/start;
the default stable address is preferable for Meta's callbacks.

## Configure the runtime secret

Populate the stack's secret using the Secrets Manager console or a secure local
SDK flow. **Never put values in CloudFormation parameters, user data, a command
line, a release manifest, a PR, or tool output.** The secret is a JSON object
containing these keys:

| Key | Requirement |
| --- | --- |
| `POSTGRES_PASSWORD` | Fresh random string, at least 32 bytes. Keep stable after DB initialization. |
| `NEXTAUTH_SECRET` | Fresh random string, at least 32 bytes. |
| `CRON_SECRET` | Separate random string, at least 32 bytes. |
| `FEAST_SSO_SECRET` | Same at-least-32-byte value as Feast backend `NUDGE1_SSO_SECRET`. |
| `ENCRYPTION_KEY` | Exactly 64 hex characters; back up securely and retain across all upgrades/restores. |
| `INSTAGRAM_APP_ID` | Instagram Login app ID, numeric. |
| `INSTAGRAM_APP_SECRET` | Instagram Login app secret. |
| `FACEBOOK_APP_SECRET` | Corresponding Meta app secret. |
| `WEBHOOK_VERIFY_TOKEN` | Random token, at least 16 bytes, matching Meta's webhook setup. |
| `META_GRAPH_API_VERSION` | Optional; defaults to `v25.0`. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional operational email configuration; staff login uses Feast SSO. |

Use URL-safe random secrets. Newlines, NULs, backslashes and single quotes are rejected to
keep Compose env files unambiguous. Runtime files are root-only under `/run`,
never in the release or persistent data directory. Docker administrators can
inspect container environment variables; host/SSM access is privileged.

Changing `POSTGRES_PASSWORD` in the secret does not rotate an existing database's
password. Plan that rotation with the database and both app processes. Losing
`ENCRYPTION_KEY` makes saved Instagram tokens unusable even if DB backups exist.

## Build and stage a release

1. Run the repository checks and build from the reviewed Nudge fork commit.
   Build the `web`, `worker` and `migrate` Docker targets for `linux/amd64`, each
   with `NUDGE_REVISION` set to that exact commit. Push distinct immutable tags to
   the stack's ECR repository. Record their returned digests. CI needs no Meta,
   production database or SSO credentials. Pin `NODE_IMAGE` by digest for fully
   reproducible rebuilds.
2. Resolve the reviewed `postgres:16-bookworm`, `redis:7.4-alpine` and
   `caddy:2-alpine` tags to their `linux/amd64` digests. Pin those too. A major
   Postgres upgrade requires a separate database migration plan.
3. Copy `deploy/release.example.json` to `release.json` outside version control.
   Fill the real hostname, exact Feast admin origin, matching public source
   archive URL, Feast-owned **professional account IDs** and six image digests.
   Keep `sendEnabled: false`. The placeholder file deliberately cannot deploy.
4. Package only the reviewed `deploy/` directory and this `release.json` in a
   `.tar.gz`; include no secrets. Compute its SHA-256 and upload it beneath the
   bucket's `releases/` prefix. Retain this artifact and the images for rollback.

Example image build shape (substitute reviewed identifiers, not secrets):

```sh
docker buildx build --platform linux/amd64 --target web \
  --build-arg NUDGE_REVISION=EXACT_COMMIT \
  --tag ECR_REPOSITORY:EXACT_COMMIT-web --push .
# Repeat with --target worker / migrate and their corresponding tag suffixes.
```

## Deploy over SSM

Wait for the instance to be managed by SSM and for `/var/log/cloud-init-output.log`
to confirm package installation completed. Connect using SSM. On the host, as
root, download the release from the stack's S3 bucket, verify its expected hash,
inspect the archive listing for only `deploy/` and `release.json`, then extract
it into a new `/opt/nudge/releases/RELEASE_ID` directory. Use a reviewed unique
release ID; do not overwrite previous releases. The host can read only its own
release bucket and ECR repository.

```sh
sudo bash /opt/nudge/releases/RELEASE_ID/deploy/host-deploy.sh \
  /opt/nudge/releases/RELEASE_ID \
  DATA_VOLUME_ID SECRET_ARN BACKUP_BUCKET us-east-1
```

These arguments are infrastructure identifiers, not secret values. The script
finds the exact data volume by EBS serial, formats it only if it has no filesystem
or partitions, mounts it, retrieves the runtime secret, pulls digest-pinned
images, waits for Postgres/Redis and applies Prisma migrations once. Existing
installations are backed up before migration. It then switches the current
release and installs boot and backup services. A failed migration leaves the
application stopped for explicit recovery instead of launching old code against
an uncertain schema. A persistent maintenance marker also blocks application
startup after reboot until deployment or restore completes. Do not remove it
merely to start old code; resolve the migration or restore its matched backup.

`nudge.service` brings the already-built containers back after reboot. The Docker
restart policy restarts crashed processes; it does not fix an unhealthy but
running worker. A Docker service dependency requires the data mount before any
container can restart on this dedicated host. Startup, backup and restore also
compare the mounted device's EBS serial with the configured data-volume ID;
a different mounted volume is rejected. Inspect `docker compose ps`, staff Diagnostics and the worker
heartbeat. `/api/feast/live` is a public minimal web liveness check; detailed
`/api/health` requires a staff session. Do not mistake liveness for successful DM
delivery. Container logs rotate locally; this pilot does not create an external
alerting integration. Add the team's existing uptime/alert destination before
depending on it unattended.

### Acceptance before enabling sends

- Feast admin launches an authenticated staff session; public email signup is
  disabled and a missing Feast secret fails closed. Check iframe and top-level
  fallback in the actual browser, since cross-site cookie restrictions vary.
- Anonymous visitors cannot reach detailed diagnostics or campaign APIs.
- Connect only the allowlisted owned Instagram account. Check actual Meta app
  roles/access and callback/subscription configuration in the separate Meta plan.
- Run migrations on a clean test DB and verify a backup/restore in isolation.
- Exercise signed webhook receipt, replay handling, worker restart, failed send,
  queue outage and recovery with sends disabled, then an approved test comment.
- Inspect the source link and confirm its commit matches the deployed images.
- Confirm daily backup completion in S3 and available disk/memory headroom.
- Review dependency advisories and the final image scan before deployment. The
  2026-10-14 audit after the Next/Auth upgrade has zero critical findings but 26
  total findings (16 high, 8 moderate, 2 low). `--omit=dev` reports 14 (8 high,
  6 moderate), including Prisma tooling transitives and ExcelJS. The worker
  intentionally includes development dependencies for tsx/Prisma. A compatible
  audit fix currently fails in npm Arborist (`edgesOut`); no forced major
  downgrade was applied. These images are not claimed to be vulnerability-free.

The reliability migration `20261014150000_feast_delivery_recovery` must be applied
before these images run. Signed receipts are stored in Postgres and the worker
replays them every 15 seconds; the receipt store can recover a lost Redis queue.
An interrupted send older than 120 seconds becomes `FAILED/UNKNOWN` and is not
automatically sent again. Reconcile it against the actual Instagram conversation
and provider message ID before an operator retry. Definite Meta rejections are
terminal `REJECTED` results. The worker has a 90-second shutdown deadline and the
container is given 120 seconds. Manual inbox sending is disabled in this pilot;
the inbox remains readable.

To enable sends, make a new release manifest with `sendEnabled: true`, keeping
the same reviewed image digests if code is unchanged, and deploy it explicitly.
The Feast-owned account allowlist stays mandatory. Disabling sends is the same
configuration release with `false`; stop the worker immediately if urgent.

## Updates, rollback and restore

Build a new source commit into new image digests and a new artifact. Redeploy with
`host-deploy.sh`; it takes a matched backup and preserves `/opt/nudge/previous`.
Do not delete older images, artifacts or encryption keys during rollout.

For code-only rollback with a proven backward-compatible schema, redeploy the
previous manifest. If a migration changed compatibility, restore its matched
backup instead. Restoring an old queue can replay actions already accepted by
Meta after the backup; inspect the pending work before enabling sends.

```sh
# Manual backup; briefly pauses web/worker/scheduler.
sudo bash /opt/nudge/current/deploy/backup.sh

# Destructive restore of DB and queue to one completed backup.
# Supply the locally retained release whose six image digests match the backup.
sudo bash /opt/nudge/current/deploy/restore.sh \
  YYYYMMDDTHHMMSSZ /opt/nudge/releases/MATCHING_RELEASE --confirm-restore
```

Restore verifies checksums and matching images/source, stops processing, restores
Postgres, rebuilds Redis AOF from the saved RDB, and creates a new restoration
manifest with **sends disabled**. Keep the original encryption key and database
password in Secrets Manager. Verify health, campaign state and pending messages
before a new release enables sends. A failed restore intentionally leaves the
application stopped; inspect any temporary `nudge-redis-restore` container before
retrying. Both startup and maintenance require the data volume to be mounted,
so a missing EBS attachment cannot silently create a fresh database on root
storage. Rehearse recovery on a separate host before relying on these scripts.

For host loss, recreate compute in the data volume's availability zone and attach
the retained volume, or restore a completed S3 backup to a new volume. Supply the
retained original runtime secret, bucket and exact release. Do not casually move
the stack to a new subnet/AZ; EBS volumes are zonal. Stack deletion retains the
data volume, secret, ECR repository and S3 bucket. Explicitly clean them up only
after the data retention decision; retained resources continue to incur charges.

## Offline validation

```sh
python3 deploy/test_deployment.py
bash -n deploy/common.sh deploy/start.sh deploy/stop.sh deploy/host-deploy.sh deploy/backup.sh deploy/restore.sh
node --check deploy/cron.mjs
```

These checks validate configuration safety and syntax. They do not prove an AWS
deployment, image build, Meta access, backup consistency under faults, or restore
success. Those require the stated staging acceptance checks.
