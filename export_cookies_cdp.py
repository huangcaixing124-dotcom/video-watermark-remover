"""
Connect to an existing Chrome/Edge browser via DevTools Protocol
and export all cookies to cookies.txt format.

Prerequisites:
  1. Chrome/Edge must be launched with --remote-debugging-port=9222
  2. Or use this script to start a new Edge instance with debugging enabled

Usage:
  python export_cookies_cdp.py
"""
import os
import socket
import sys
from datetime import datetime


def find_free_port():
    """Find a free port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def find_running_browser():
    """Find Chrome/Edge browsers with DevTools port open."""
    import subprocess

    # Check if Edge is already running with devtools port
    # Common devtools ports
    for port in [9222, 9223, 9224, 9225]:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex(("127.0.0.1", port))
            sock.close()
            if result == 0:
                print(f"Found browser with DevTools on port {port}")
                return port
        except:
            pass
    return None


def find_edge_binary():
    """Find Edge executable path."""
    edge_paths = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        os.path.expanduser("~") + "\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]
    for p in edge_paths:
        if os.path.exists(p):
            return p
    return None


def find_chrome_binary():
    """Find Chrome executable path."""
    chrome_paths = [
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        os.path.expanduser("~") + "\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]
    for p in chrome_paths:
        if os.path.exists(p):
            return p
    return None


def start_edge_with_debugging(port=9222):
    """Start Edge with remote debugging enabled."""
    import subprocess
    import time

    edge_path = find_edge_binary()
    if not edge_path:
        print("Error: Edge not found")
        return None

    print(f"Starting Edge with debugging on port {port}...")
    print(f"  Path: {edge_path}")

    # Launch Edge with remote debugging port
    process = subprocess.Popen(
        [
            edge_path,
            f"--remote-debugging-port={port}",
            "--user-data-dir=" + os.path.expanduser("~") + "\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default",
            "--profile-directory=Default",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    print("  Waiting for browser to start...")
    time.sleep(3)

    # Verify it's running
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex(("127.0.0.1", port))
        sock.close()
        if result == 0:
            print(f"  Edge started successfully on port {port}")
            return process
    except:
        pass

    print(f"  Failed to start Edge on port {port}")
    return None


def get_browser_url(port):
    """Get the DevTools endpoint URL for the browser."""
    return f"http://127.0.0.1:{port}/json/version"


def get_all_pages_url(port):
    """Get the DevTools endpoint URL for listing all pages."""
    return f"http://127.0.0.1:{port}/json/list"


def export_cookies_cdp(port=9222, output_dir="."):
    """Export cookies from browser via CDP."""
    import urllib.request
    import json

    output_path = os.path.join(output_dir, "cookies.txt")

    try:
        # Connect to browser
        req = urllib.request.Request(get_browser_url(port))
        with urllib.request.urlopen(req, timeout=5) as resp:
            info = json.loads(resp.read().decode())
            browser_name = info.get("Browser", "Unknown")
            print(f"Connected to: {browser_name}")

        # Get list of pages to find target page
        req = urllib.request.Request(get_all_pages_url(port))
        with urllib.request.urlopen(req, timeout=5) as resp:
            pages = json.loads(resp.read().decode())

        if not pages:
            print("No browser pages found")
            return False

        # Use the first page
        page = pages[0]
        page_url = page.get("webSocketDebuggerUrl", "")
        if not page_url:
            print("No WebSocket debugger URL available")
            return False

        # Use Playwright to connect and get cookies
        try:
            from playwright.sync_api import sync_playwright

            print("Connecting to browser via Playwright...")

            with sync_playwright() as p:
                # Connect to the browser via CDP
                browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")

                # Get all contexts and their cookies
                all_cookies = []
                for context in browser.contexts:
                    cookies = context.cookies()
                    all_cookies.extend(cookies)

                print(f"Found {len(all_cookies)} cookies")

                if all_cookies:
                    with open(output_path, "w", encoding="utf-8") as f:
                        f.write("# Netscape HTTP Cookie File\n")
                        f.write(f"# {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                        f.write("# https://curl.haxx.se/docs/http-cookies.html\n")
                        f.write("# Generated by export_cookies_cdp.py\n\n")

                        count = 0
                        for cookie in all_cookies:
                            domain = cookie.get("domain", "")
                            if domain and not domain.startswith("."):
                                domain = "." + domain

                            path = cookie.get("path", "/") or "/"
                            is_secure = "TRUE" if cookie.get("secure", False) else "FALSE"

                            expires = cookie.get("expires", 0)
                            if expires and expires > 0:
                                if expires > 10**12:
                                    expires = int((expires - 116444736000000000) / 1000000)
                                else:
                                    expires = int(expires)
                            else:
                                expires = 0

                            name = cookie.get("name", "")
                            value = cookie.get("value", "")

                            if not name or not value:
                                continue

                            value = value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")

                            f.write(f"{domain}\tTRUE\t{path}\t{is_secure}\t{expires}\t{name}\t{value}\n")
                            count += 1

                    print(f"Exported {count} cookies to {output_path}")
                    browser.close()
                    return True
                else:
                    print("No cookies found")
                    browser.close()
                    return False

        except Exception as e:
            print(f"Error connecting via Playwright: {e}")
            return False

    except Exception as e:
        print(f"Error: {e}")
        return False


def main():
    print("=" * 60)
    print("CDP Cookie Export Tool")
    print("=" * 60)
    print()

    port = find_running_browser()
    if not port:
        print("No browser found with DevTools enabled.")
        print()
        print("Starting Edge with remote debugging...")
        print("(Make sure your target pages are already open in Edge)")
        print()

        edge_path = find_edge_binary()
        if not edge_path:
            print("Error: Edge not found on this system")
            print("Please use Chrome or Edge")
            return

        # We can't launch Edge with the default profile while it's already running
        # So we'll need to use a different approach
        print()
        print("Since Edge is already running, we need to connect to it.")
        print()
        print("Option 1: Restart Edge with --remote-debugging-port=9222")
        print("  1. Close Edge completely")
        print("  2. Run: msedge --remote-debugging-port=9222")
        print("  3. Reopen your target pages")
        print("  4. Run this script again")
        print()
        print("Option 2: Use the Playwright interactive tool")
        print("  1. Close this script")
        print("  2. Run: python export_cookies_playwright.py")
        print("  3. Log in to your target sites in the new browser window")
        print("  4. Close the window to export cookies")
        print()

        sys.exit(1)

    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
    success = export_cookies_cdp(port, output_dir)
    if success:
        print("\nDone! Place cookies.txt in the project root directory.")
    else:
        print("\nFailed to export cookies.")
        print("\nTry Option 2 above or use the interactive Playwright tool.")


if __name__ == "__main__":
    main()
