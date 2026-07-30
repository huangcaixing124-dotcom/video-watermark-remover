"""
Export browser cookies to Netscape cookies.txt format.
Supports: Microsoft Edge, Google Chrome

This version tries to read the cookies database directly without copying,
which works even when the browser is running on newer Windows versions.

Netscape format: domain\tFLAG\tpath\tFLAG\texpiry\tname\tvalue
"""
import sqlite3
import json
import os
import sys
import struct
from datetime import datetime

from Crypto.Cipher import AES


def get_master_key(local_state_path):
    """Extract the AES-256 master key from Local State file."""
    with open(local_state_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    key_b64 = data.get("os_crypt", {}).get("encrypted_key", "")
    if not key_b64:
        return None

    import base64
    key_bytes = base64.b64decode(key_b64)

    if key_bytes[:5] == b"DPAPI":
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
            ]

        CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
        CryptUnprotectData.argtypes = [
            ctypes.POINTER(DATA_BLOB),
            ctypes.POINTER(ctypes.c_wchar_p),
            ctypes.POINTER(DATA_BLOB),
            None,
            None,
            wintypes.DWORD,
            ctypes.POINTER(DATA_BLOB),
        ]
        CryptUnprotectData.restype = wintypes.BOOL

        pbData = (ctypes.c_ubyte * len(key_bytes))()
        ctypes.memmove(pbData, key_bytes, len(key_bytes))
        data_blob = DATA_BLOB(len(key_bytes), pbData)

        result_blob = DATA_BLOB()
        if CryptUnprotectData(ctypes.byref(data_blob), None, None, None, None, 0, ctypes.byref(result_blob)):
            return ctypes.string_at(result_blob.pbData, result_blob.cbData)
    return None


def decrypt_value(encrypted_value, master_key):
    """Decrypt Chrome/Edge encrypted cookie value."""
    if not encrypted_value:
        return ""

    if len(encrypted_value) >= 17 and encrypted_value[:3] == b"v10":
        iv = encrypted_value[3:15]
        ciphertext = encrypted_value[15:-16]
        tag = encrypted_value[-16:]

        if master_key:
            try:
                cipher = AES.new(master_key, AES.MODE_GCM, nonce=iv)
                decrypted = cipher.decrypt_and_verify(ciphertext, tag)
                return decrypted.decode("utf-8", errors="replace")
            except Exception:
                pass

        # Fallback: DPAPI
        try:
            import ctypes
            from ctypes import wintypes

            class DATA_BLOB(ctypes.Structure):
                _fields_ = [
                    ("cbData", wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
                ]

            CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
            CryptUnprotectData.argtypes = [
                ctypes.POINTER(DATA_BLOB),
                ctypes.POINTER(ctypes.c_wchar_p),
                ctypes.POINTER(DATA_BLOB),
                None,
                None,
                wintypes.DWORD,
                ctypes.POINTER(DATA_BLOB),
            ]
            CryptUnprotectData.restype = wintypes.BOOL

            pbData = (ctypes.c_ubyte * len(encrypted_value))()
            ctypes.memmove(pbData, encrypted_value, len(encrypted_value))
            data_blob = DATA_BLOB(len(encrypted_value), pbData)

            result_blob = DATA_BLOB()
            if CryptUnprotectData(ctypes.byref(data_blob), None, None, None, None, 0, ctypes.byref(result_blob)):
                return ctypes.string_at(result_blob.pbData, result_blob.cbData).decode("utf-8", errors="replace")
        except Exception:
            pass

        return ""

    try:
        return encrypted_value.decode("utf-8")
    except:
        return ""


def convert_expiry(expiry_value):
    """Convert Chrome/Edge expiry to Unix timestamp."""
    if not expiry_value:
        return 0
    if expiry_value > 10**12:
        return int((expiry_value - 116444736000000000) / 1000000)
    return int(expiry_value)


def export_cookies(browser="edge", output_dir="."):
    """Export cookies from browser to Netscape cookies.txt."""
    print(f"Exporting {browser} cookies...")

    home = os.path.expanduser("~")
    if browser == "edge":
        data_dir = os.path.join(home, "AppData", "Local", "Microsoft", "Edge", "User Data")
    else:
        data_dir = os.path.join(home, "AppData", "Local", "Google", "Chrome", "User Data")

    # Find available profiles
    profiles = []
    for entry in sorted(os.listdir(data_dir)):
        full_path = os.path.join(data_dir, entry)
        cookies_path = os.path.join(full_path, "Network", "Cookies")
        if os.path.exists(cookies_path):
            profiles.append((entry, cookies_path, os.path.join(full_path, "Network", "Local State")))

    if not profiles:
        print(f"Error: No cookies database found for {browser}")
        return False

    for profile_name, db_path, state_path in profiles:
        print(f"Trying profile: {profile_name}")
        print(f"  DB: {db_path}")

        # Get master key
        master_key = None
        if os.path.exists(state_path):
            try:
                master_key = get_master_key(state_path)
                print(f"  Master key loaded")
            except Exception as e:
                print(f"  Warning: Could not load master key: {e}")

        # Open database in read-only mode without WAL/Journal conflicts
        conn = None
        for attempt in range(3):
            try:
                conn = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
                print(f"  Database opened (attempt {attempt+1})")
                break
            except sqlite3.OperationalError as e:
                if "locked" in str(e) or "is locked" in str(e):
                    print(f"  Database locked, retrying ({attempt+1}/3)...")
                    import time
                    time.sleep(0.5)
                    continue
                else:
                    print(f"  Database error: {e}")
                    conn = None
                    break

        if not conn:
            print(f"  Failed to open database after retries, trying next profile")
            continue

        cursor = conn.cursor()
        try:
            cursor.execute("SELECT host_key, name, path, is_secure, expires_utc, encrypted_value FROM cookies")
        except sqlite3.OperationalError as e:
            print(f"  Error reading cookies table: {e}")
            conn.close()
            continue

        rows = cursor.fetchall()
        conn.close()

        if not rows:
            print(f"  No cookies found in {profile_name}")
            continue

        # Write cookies.txt
        output_path = os.path.join(output_dir, "cookies.txt")
        count = 0

        with open(output_path, "w", encoding="utf-8") as f:
            f.write("# Netscape HTTP Cookie File\n")
            f.write(f"# {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write("# https://curl.haxx.se/docs/http-cookies.html\n")
            f.write("# Generated by export_cookies.py\n\n")

            for row in rows:
                host_key, name, path, is_secure, expiry, encrypted_value = row

                value = decrypt_value(encrypted_value, master_key)

                if not name or not value:
                    continue

                # Domain format: Netscape needs dot prefix for domain cookies
                domain = "." + host_key if not host_key.startswith(".") else host_key
                path = path if path else "/"
                expiry_unix = convert_expiry(expiry)
                is_secure_flag = "TRUE" if is_secure else "FALSE"

                value = value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")

                f.write(f"{domain}\tTRUE\t{path}\t{is_secure_flag}\t{expiry_unix}\t{name}\t{value}\n")
                count += 1

        print(f"  Exported {count} cookies to {output_path}")
        return True

    print("Error: Could not export cookies from any profile")
    return False


if __name__ == "__main__":
    browser = sys.argv[1] if len(sys.argv) > 1 else "edge"
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))

    success = export_cookies(browser, output_dir)
    if success:
        print("\nDone! Place cookies.txt in the project root directory.")
    else:
        print("\nFailed to export cookies.")
        print("\nIf browser is running, please:")
        print("1. Close the browser completely")
        print("2. Run this script again")
        print("3. Or use Playwright method below:")
        print("   pip install playwright")
        print("   python -c \"from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(); c=b.new_context(); print('Now navigate to your target site in a headed browser, then run the playwright export script')\"")
        sys.exit(1)
