"""
Export cookies from Microsoft Edge to Netscape cookies.txt format.

IMPORTANT: Close Microsoft Edge completely before running this script.
If Edge is running, the cookie database will be locked and inaccessible.

Usage:
    python export_edge_cookies.py

The script will:
1. Read cookies from Edge's SQLite database
2. Decrypt encrypted cookie values using the master key
3. Export to cookies.txt in Netscape format
"""
import os
import sys
import sqlite3
import json
import base64
import shutil
import tempfile
from datetime import datetime

from Crypto.Cipher import AES


def get_edge_paths():
    """Get Edge user data directories."""
    home = os.path.expanduser("~")
    return {
        "data_dir": os.path.join(home, "AppData", "Local", "Microsoft", "Edge", "User Data"),
        "local_state": os.path.join(home, "AppData", "Local", "Microsoft", "Edge", "User Data", "Local State"),
    }


def get_master_key(local_state_path):
    """Extract and decrypt the AES-256 master key from Local State."""
    if not os.path.exists(local_state_path):
        print("  Local State file not found")
        return None

    with open(local_state_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    key_b64 = data.get("os_crypt", {}).get("encrypted_key", "")
    if not key_b64:
        print("  No encrypted key in Local State")
        return None

    key_bytes = base64.b64decode(key_b64)

    if key_bytes[:5] == b"DPAPI":
        # Decrypt using Windows DPAPI
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.c_char_p),
            ]

        CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
        CryptUnprotectData.argtypes = [
            ctypes.POINTER(DATA_BLOB),
            ctypes.c_wchar_p,
            ctypes.POINTER(DATA_BLOB),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(DATA_BLOB),
        ]
        CryptUnprotectData.restype = wintypes.BOOL

        input_blob = DATA_BLOB(len(key_bytes), key_bytes)
        output_blob = DATA_BLOB()

        if CryptUnprotectData(ctypes.byref(input_blob), None, None, None, None, 0, ctypes.byref(output_blob)):
            return ctypes.string_at(output_blob.pbData, output_blob.cbData)
        else:
            print("  DPAPI decryption failed")
            return None

    return key_bytes


def decrypt_cookie_value(encrypted_value, master_key):
    """Decrypt a Chrome/Edge cookie value."""
    if not encrypted_value:
        return ""

    # Chrome/Edge 80+ format: "v10" + 12-byte IV + ciphertext + 16-byte tag
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

        # Fallback: try DPAPI directly
        try:
            import ctypes
            from ctypes import wintypes

            class DATA_BLOB(ctypes.Structure):
                _fields_ = [
                    ("cbData", wintypes.DWORD),
                    ("pbData", ctypes.c_char_p),
                ]

            CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
            CryptUnprotectData.argtypes = [
                ctypes.POINTER(DATA_BLOB),
                ctypes.c_wchar_p,
                ctypes.POINTER(DATA_BLOB),
                ctypes.c_void_p,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(DATA_BLOB),
            ]
            CryptUnprotectData.restype = wintypes.BOOL

            input_blob = DATA_BLOB(len(encrypted_value), encrypted_value)
            output_blob = DATA_BLOB()

            if CryptUnprotectData(ctypes.byref(input_blob), None, None, None, None, 0, ctypes.byref(output_blob)):
                return ctypes.string_at(output_blob.pbData, output_blob.cbData).decode("utf-8", errors="replace")
        except Exception:
            pass

        return ""

    # Plain text (no encryption)
    try:
        return encrypted_value.decode("utf-8")
    except:
        return ""


def convert_expiry(expiry_value):
    """Convert Chrome/Edge expiry to Unix timestamp."""
    if not expiry_value:
        return 0
    # Windows FILETIME: 100-nanosecond intervals since 1601-01-01
    if expiry_value > 10**12:
        return int((expiry_value - 116444736000000000) / 1000000)
    return int(expiry_value)


def find_cookie_databases(data_dir):
    """Find all available cookie databases."""
    databases = []

    # Check Default profile first
    default_db = os.path.join(data_dir, "Default", "Network", "Cookies")
    if os.path.exists(default_db) and os.path.getsize(default_db) > 0:
        databases.append(("Default", default_db))

    # Check other profiles
    for entry in sorted(os.listdir(data_dir)):
        profile_dir = os.path.join(data_dir, entry)
        if entry.startswith("Profile") or entry == "Guest Profile":
            db_path = os.path.join(profile_dir, "Network", "Cookies")
            if os.path.exists(db_path) and os.path.getsize(db_path) > 0:
                databases.append((entry, db_path))

    return databases


def export_cookies(browser="edge", output_dir="."):
    """Export cookies from Edge to Netscape cookies.txt."""
    print("=" * 60)
    print("Edge Cookie Export Tool")
    print("=" * 60)
    print()

    paths = get_edge_paths()
    data_dir = paths["data_dir"]
    local_state_path = paths["local_state"]

    # Get master key
    print("Loading master key...")
    master_key = get_master_key(local_state_path)
    if master_key:
        print(f"  Master key loaded ({len(master_key)} bytes)")
    else:
        print("  Warning: Could not load master key, some cookies may not be decrypted")

    # Find cookie databases
    databases = find_cookie_databases(data_dir)
    if not databases:
        print("\nError: No cookie databases found")
        print("Please make sure:")
        print("  1. Microsoft Edge is installed")
        print("  2. Edge has been run at least once")
        return False

    print(f"\nFound {len(databases)} profile(s):")
    for name, db_path in databases:
        print(f"  - {name}: {os.path.getsize(db_path)} bytes")

    # Try to export from each profile
    output_path = os.path.join(output_dir, "cookies.txt")
    total_count = 0

    for profile_name, db_path in databases:
        print(f"\nExporting from profile: {profile_name}")
        print(f"  Database: {db_path}")

        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
        except sqlite3.OperationalError as e:
            print(f"  Error: Database locked - {e}")
            print("  Please close Microsoft Edge and try again")
            continue

        cursor = conn.cursor()
        try:
            cursor.execute("SELECT host_key, name, path, is_secure, expires_utc, encrypted_value FROM cookies")
        except sqlite3.OperationalError as e:
            print(f"  Error: Could not read cookies table - {e}")
            conn.close()
            continue

        rows = cursor.fetchall()
        conn.close()

        if not rows:
            print("  No cookies found in this profile")
            continue

        print(f"  Found {len(rows)} cookies in database")

        # Write to cookies.txt
        count = 0
        with open(output_path, "a" if total_count > 0 else "w", encoding="utf-8") as f:
            if total_count == 0:
                f.write("# Netscape HTTP Cookie File\n")
                f.write(f"# {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write("# https://curl.haxx.se/docs/http-cookies.html\n")
                f.write("# Generated by export_edge_cookies.py\n\n")

            for row in rows:
                host_key, name, path, is_secure, expires_utc, encrypted_value = row

                # Decrypt
                value = decrypt_cookie_value(encrypted_value, master_key)

                # Skip empty cookies
                if not name or not value:
                    continue

                # Format domain
                domain = "." + host_key if not host_key.startswith(".") else host_key
                path = path if path else "/"
                expiry_unix = convert_expiry(expires_utc)
                is_secure_flag = "TRUE" if is_secure else "FALSE"

                # Escape value
                value = value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")

                f.write(f"{domain}\tTRUE\t{path}\t{is_secure_flag}\t{expiry_unix}\t{name}\t{value}\n")
                count += 1

        print(f"  Exported {count} cookies")
        total_count += count

    if total_count == 0:
        print("\nNo cookies exported. Please make sure:")
        print("  1. Microsoft Edge is completely closed")
        print("  2. You have logged into at least one website in Edge")
        return False

    print(f"\n{'=' * 60}")
    print(f"Done! Exported {total_count} cookies to:")
    print(f"  {output_path}")
    print(f"{'=' * 60}")
    return True


if __name__ == "__main__":
    output_dir = os.path.dirname(os.path.abspath(__file__))

    success = export_cookies("edge", output_dir)

    if not success:
        print("\nTo export cookies, please:")
        print("  1. Close Microsoft Edge completely")
        print("     (Right-click Edge in taskbar -> Close window)")
        print("  2. Make sure Edge is not running in the background")
        print("     (Check Task Manager -> Details -> msedge.exe)")
        print("  3. Run this script again:")
        print(f"     python {os.path.basename(__file__)}")
        print()
        print("If you have cookies in Chrome, you can also use:")
        print(f"  python {os.path.basename(__file__)} --chrome")
        sys.exit(1)
