#!/usr/bin/env python3
"""Render root-only runtime env files. Never print secret values."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote, urlsplit


def require_string(values, key, minimum=1):
    value = values.get(key)
    if not isinstance(value, str) or len(value.encode()) < minimum:
        raise ValueError(f"{key} is missing or too short")
    # Single-quoted Compose env files must round-trip without interpolation.
    if any(c in value for c in ("'", "\\", "\n", "\r", "\x00")):
        raise ValueError(f"{key} contains an unsupported character")
    return value


def https_origin(value):
    if not isinstance(value, str):
        raise ValueError("Expected HTTPS origin")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Expected exact HTTPS origin without a path")
    return value


def make_environment(release, secrets):
    hostname = release.get("hostname", "")
    if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", hostname):
        raise ValueError("hostname must be a public DNS hostname")
    origin = https_origin(release.get("feastAdminOrigin"))
    source_url = require_string(release, "sourceUrl")
    source = urlsplit(source_url)
    if source.scheme != "https" or not source.hostname or source.username or source.password or source.query or source.fragment or not re.search(r"[0-9a-f]{40}", source.path):
        raise ValueError("sourceUrl must identify the exact source commit over HTTPS")
    ids = release.get("ownedInstagramIds")
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or not re.fullmatch(r"[0-9]{5,32}", i) for i in ids):
        raise ValueError("ownedInstagramIds must explicitly list Feast professional account IDs")
    enabled = release.get("sendEnabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("sendEnabled must be a boolean")
    images = release.get("images", {})
    image_env = {}
    for kind in ("web", "worker", "migrate", "postgres", "redis", "caddy"):
        image = images.get(kind, "")
        if not isinstance(image, str) or not re.fullmatch(r"[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}", image):
            raise ValueError(f"{kind} image must be pinned by sha256 digest")
        image_env[f"{kind.upper()}_IMAGE"] = image
    required = {
        "NEXTAUTH_SECRET": 32, "CRON_SECRET": 32, "FEAST_SSO_SECRET": 32,
        "ENCRYPTION_KEY": 64, "INSTAGRAM_APP_ID": 1,
        "INSTAGRAM_APP_SECRET": 16, "FACEBOOK_APP_SECRET": 16,
        "WEBHOOK_VERIFY_TOKEN": 16,
    }
    app = {key: require_string(secrets, key, length) for key, length in required.items()}
    if not re.fullmatch(r"[0-9a-fA-F]{64}", app["ENCRYPTION_KEY"]):
        raise ValueError("ENCRYPTION_KEY must be exactly 64 hex characters")
    if not re.fullmatch(r"[0-9]+", app["INSTAGRAM_APP_ID"]):
        raise ValueError("INSTAGRAM_APP_ID must be numeric")
    password = require_string(secrets, "POSTGRES_PASSWORD", 32)
    app.update({
        "FEAST_MODE": "true", "FEAST_SEND_ENABLED": str(enabled).lower(),
        "FEAST_ADMIN_ORIGIN": origin, "FEAST_SOURCE_URL": source_url,
        "FEAST_OWNED_INSTAGRAM_IDS": ",".join(ids),
        "NEXTAUTH_URL": f"https://{hostname}",
        "DATABASE_URL": f"postgresql://nudge:{quote(password, safe='')}@postgres:5432/nudge",
        "REDIS_URL": "redis://redis:6379",
        "META_GRAPH_API_VERSION": secrets.get("META_GRAPH_API_VERSION", "v25.0"),
        "COMMENT_POLL_INTERVAL_MS": "1200000",
    })
    for key in ("RESEND_API_KEY", "EMAIL_FROM"):
        if secrets.get(key):
            app[key] = require_string(secrets, key)
    image_env["NUDGE_HOSTNAME"] = hostname
    return app, {"POSTGRES_USER": "nudge", "POSTGRES_DB": "nudge", "POSTGRES_PASSWORD": password}, image_env


def write_env(path, values):
    for key in values:
        require_string(values, key)
    content = "".join(f"{key}='{value}'\n" for key, value in sorted(values.items()))
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
    os.chmod(path, 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True)
    parser.add_argument("--host", default="/etc/nudge/host.json")
    parser.add_argument("--output", default="/run/nudge")
    args = parser.parse_args()
    try:
        host = json.loads(Path(args.host).read_text())
        release = json.loads(Path(args.release).read_text())
        result = subprocess.run([
            "aws", "secretsmanager", "get-secret-value", "--region", host["region"],
            "--secret-id", host["secretArn"], "--query", "SecretString", "--output", "text",
        ], capture_output=True, text=True, check=True)
        environments = make_environment(release, json.loads(result.stdout))
        output = Path(args.output)
        output.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(output, 0o700)
        for name, values in zip(("app.env", "postgres.env", "compose.env"), environments):
            write_env(output / name, values)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        # Never include AWS response bodies or raw configuration in diagnostics.
        if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
            parser.exit(1, f"Runtime configuration rejected: {error}\n")
        parser.exit(1, "Runtime configuration unavailable; check the secret, release and IAM access.\n")


if __name__ == "__main__":
    main()
