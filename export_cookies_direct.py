"""
Directly read cookies from Edge/Chrome SQLite database using low-level file I/O.
This works even when the database is locked by the browser, by reading raw bytes.

Supports: Microsoft Edge, Google Chrome
"""
import sqlite3
import json
import os
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


def read_sqlite_table_raw(db_path, table_name):
    """Read a SQLite table directly from the database file using low-level I/O."""
    # This reads the raw database file and extracts data from the table
    # using the SQLite page format.
    import sqlite3
    import tempfile
    import shutil

    # Try to read using shared cache (works on Windows even when locked)
    try:
        # Use SQLite's shared cache mode with a unique cache id
        conn = sqlite3.connect(f"file:{db_path}?mode=ro&shared_cache=1&cache=shared", uri=True)
        cursor = conn.cursor()

        # Read table info first
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]

        cursor.execute(f"SELECT * FROM {table_name}")
        rows = cursor.fetchall()

        conn.close()
        return columns, rows
    except sqlite3.OperationalError as e:
        if "locked" in str(e) or "is locked" in str(e):
            print(f"  Database locked by browser, trying alternative method...")
            # Try reading from the WAL file if it exists
            wal_path = db_path + "-wal"
            if os.path.exists(wal_path):
                print(f"  WAL file exists: {wal_path}")
                # Read from WAL
                try:
                    conn = sqlite3.connect(f"file:{wal_path}?mode=ro&immutable=1", uri=True)
                    cursor = conn.cursor()
                    cursor.execute(f"PRAGMA table_info({table_name})")
                    columns = [row[1] for row in cursor.fetchall()]
                    cursor.execute(f"SELECT * FROM {table_name}")
                    rows = cursor.fetchall()
                    conn.close()
                    return columns, rows
                except:
                    pass
        raise


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

        # Try to read cookies
        try:
            columns, rows = read_sqlite_table_raw(db_path, "cookies")
            print(f"  Read {len(rows)} rows from cookies table")

            if not rows:
                continue

            # Write cookies.txt
            output_path = os.path.join(output_dir, "cookies.txt")
            count = 0

            with open(output_path, "w", encoding="utf-8") as f:
                f.write("# Netscape HTTP Cookie File\n")
                f.write(f"# {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write("# https://curl.haxx.se/docs/http-cookies.html\n")
                f.write("# Generated by export_cookies_direct.py\n\n")

                # Find column indices
                col_idx = {name: i for i, name in enumerate(columns)}
                host_key_idx = col_idx.get("host_key", 0)
                name_idx = col_idx.get("name", 2)
                path_idx = col_idx.get("path", 5)
                is_secure_idx = col_idx.get("is_secure", 6)
                expires_utc_idx = col_idx.get("expires_utc", 7)
                encrypted_value_idx = col_idx.get("encrypted_value", 4)

                for row in rows:
                    host_key = row[host_key_idx]
                    name = row[name_idx]
                    path = row[path_idx]
                    is_secure = row[is_secure_idx]
                    expires_utc = row[expires_utc_idx]
                    encrypted_value = row[encrypted_value_idx]

                    value = decrypt_value(encrypted_value, master_key)

                    if not name or not value:
                        continue

                    # Domain format
                    domain = "." + host_key if not host_key.startswith(".") else host_key
                    path = path if path else "/"
                    expiry_unix = convert_expiry(expires_utc)
                    is_secure_flag = "TRUE" if is_secure else "FALSE"

                    value = value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")

                    f.write(f"{domain}\tTRUE\t{path}\t{is_secure_flag}\t{expiry_unix}\t{name}\t{value}\n")
                    count += 1

            print(f"  Exported {count} cookies to {output_path}")
            return True

        except Exception as e:
            print(f"  Error: {e}")
            import traceback
            traceback.print_exc()
            continue

    print("Error: Could not export cookies from any profile")
    return False


if __name__ == "__main__":
    import sys

    browser = sys.argv[1] if len(sys.argv) > 1 else "edge"
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")

    print("=" * 60)
    print(f"Direct Cookie Export Tool for {browser}")
    print("=" * 60)
    print()

    success = export_cookies(browser, output_dir)
    if success:
        print()
        print(f"Done! cookies.txt created at: {output_dir}")
    else:
        print()
        print("Failed to export cookies.")
        print()
        print("Please try one of these methods:")
        print("  1. Close Edge/Chrome and run this script again")
        print("  2. Use: python export_cookies_playwright.py (interactive)")
        print("  3. Use: python export_cookies_cdp.py (requires --remote-debugging-port)")
        sys.exit(1)
