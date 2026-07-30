"""
Auto-update script for douyin-tiktok-scraper.
Checks for new versions and updates if available.

Usage:
    python update_scraper.py          # Check and update
    python update_scraper.py --check  # Only check, don't update
"""
import sys
import subprocess
import json
import os
from datetime import datetime

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scraper_update.log')


def log(msg):
    """Log message to file and console."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def get_current_version():
    """Get currently installed version."""
    try:
        result = subprocess.run(
            ['pip', 'show', 'douyin-tiktok-scraper'],
            capture_output=True, text=True
        )
        for line in result.stdout.split('\n'):
            if line.startswith('Version:'):
                return line.split(':')[1].strip()
    except:
        pass
    return None


def check_latest_version():
    """Check latest version on PyPI."""
    try:
        import urllib.request
        url = 'https://pypi.org/pypi/douyin-tiktok-scraper/json'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data['info']['version']
    except Exception as e:
        log(f"Failed to check PyPI: {e}")
        return None


def update_package():
    """Update douyin-tiktok-scraper to latest version."""
    log("Updating douyin-tiktok-scraper...")

    try:
        result = subprocess.run(
            ['pip', 'install', '--upgrade', 'douyin-tiktok-scraper'],
            capture_output=True, text=True, timeout=120
        )

        if result.returncode == 0:
            log("Update successful!")
            new_version = get_current_version()
            log(f"Current version: {new_version}")
            return True
        else:
            log(f"Update failed: {result.stderr[:200]}")
            return False
    except Exception as e:
        log(f"Update error: {e}")
        return False


def main():
    check_only = '--check' in sys.argv

    current = get_current_version()
    log(f"Current version: {current}")

    latest = check_latest_version()
    log(f"Latest version: {latest}")

    if current == latest:
        log("Already up to date!")
        return

    if latest is None:
        log("Could not check latest version")
        return

    if check_only:
        log(f"New version available: {latest} (current: {current})")
        log("Run without --check to update")
        return

    log(f"Updating from {current} to {latest}...")
    if update_package():
        log("Update completed successfully!")
        log("Restart video_api_server.py to use the new version.")
    else:
        log("Update failed!")


if __name__ == '__main__':
    main()
