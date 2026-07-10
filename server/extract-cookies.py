"""
从浏览器提取抖音 cookies 并保存为 cookies.txt。

使用方法:
  python extract-cookies.py --browser chrome
  python extract-cookies.py --browser edge --profile "Profile 1"
"""

import argparse
import os
import sqlite3
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path


def find_cookie_db(browser: str, profile: str = "Default"):
    """查找浏览器 cookies 数据库文件路径。"""
    profile_name = "Profile 1" if profile != "Default" else "Default"
    base = os.environ.get('LOCALAPPDATA', '')

    if browser == 'chrome':
        base_path = os.path.join(base, 'Google', 'Chrome', 'User Data')
    elif browser == 'edge':
        base_path = os.path.join(base, 'Microsoft', 'Edge', 'User Data')
    else:
        raise ValueError(f"不支持的浏览器: {browser}")

    # 新版浏览器使用 Network/Cookies
    db_path = os.path.join(base_path, profile_name, 'Network', 'Cookies')
    if os.path.exists(db_path):
        return db_path

    # 旧版浏览器使用 Login Data
    db_path = os.path.join(base_path, profile_name, 'Login Data')
    if os.path.exists(db_path):
        return db_path

    raise FileNotFoundError(f"找不到 cookies 数据库 (浏览器: {browser}, profile: {profile})")


def extract_douyin_cookies(browser: str = "chrome", profile: str = "Default"):
    """提取抖音 cookies 并保存为 Netscape 格式。"""
    print(f"正在查找 {browser} 的 cookies 数据库...")
    db_path = find_cookie_db(browser, profile)
    print(f"找到: {db_path}")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_db = os.path.join(tmpdir, 'cookies.db')
        shutil.copy2(db_path, tmp_db)

        conn = sqlite3.connect(f"file:{tmp_db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("""
            SELECT host_key, name, encrypted_value, expires_utc
            FROM cookies
            WHERE host_key LIKE '%douyin.com%'
               OR host_key LIKE '%iesdouyin.com%'
        """)

        rows = cursor.fetchall()
        conn.close()

        if not rows:
            print(f"[警告] 在 {browser} 中没有找到抖音相关 cookies")
            print("请先在浏览器上登录抖音并访问 https://www.douyin.com")
            return None

        cookies = []
        for row in rows:
            host = row['host_key']
            name = row['name']
            encrypted = row['encrypted_value']
            expiry = row['expires_utc']

            value = decrypt_cookie(encrypted)

            if expiry > 0:
                expire_date = datetime.fromtimestamp(expiry, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
            else:
                expire_date = '1969-12-31 00:00:00'

            cookies.append(f"{host}\tTRUE\t/\tFALSE\t{expire_date}\t{name}\t{value}")

    output_dir = Path(__file__).resolve().parent.parent
    output_path = output_dir / 'cookies.txt'

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('# Netscape HTTP Cookie File\n# https://curl.se/docs/cookies.html\n\n')
        for line in cookies:
            f.write(line + '\n')

    print(f"[成功] 已提取 {len(cookies)} 个抖音 cookies 到: {output_path}")
    return str(output_path)


def decrypt_cookie(encrypted: bytes) -> str:
    """解密浏览器 cookies。"""
    if not encrypted:
        return ''

    if encrypted.startswith(b'v10'):
        encrypted = encrypted[3:]

    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

        CRYPTPROTECT_UI_FORBIDDEN = 0x1
        CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
        CryptUnprotectData.argtypes = [
            ctypes.POINTER(DATA_BLOB), ctypes.c_wchar_p, ctypes.POINTER(DATA_BLOB),
            ctypes.POINTER(wintypes.HKEY), ctypes.POINTER(ctypes.c_ulong),
            ctypes.c_ulong, ctypes.POINTER(DATA_BLOB)
        ]
        CryptUnprotectData.restype = ctypes.c_long

        blob_in = DATA_BLOB(len(encrypted), (ctypes.c_ubyte * len(encrypted)).from_buffer_copy(encrypted))
        blob_out = DATA_BLOB()

        result = CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)
        )

        if result:
            return blob_out.pbData[:blob_out.cbData].decode('utf-8', errors='ignore')

    except Exception as e:
        print(f"[警告] 解密失败: {e}")

    return encrypted.decode('utf-8', errors='ignore')


def main():
    parser = argparse.ArgumentParser(description='从浏览器提取抖音 cookies')
    parser.add_argument('--browser', choices=['chrome', 'edge'], default='chrome',
                        help='浏览器类型')
    parser.add_argument('--profile', default='Default',
                        help='浏览器用户配置文件')
    args = parser.parse_args()

    try:
        result = extract_douyin_cookies(args.browser, args.profile)
        if result:
            print(f"\n已将 cookies.txt 保存到: {result}")
        else:
            print("\n没有找到抖音 cookies。")
            print("请先在浏览器上登录抖音并访问 https://www.douyin.com")
            sys.exit(1)
    except FileNotFoundError as e:
        print(f"[错误] {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[错误] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()