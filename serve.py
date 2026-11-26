#!/usr/bin/env python3
"""本地起一个静态服务器，手机和电脑都能访问。

    python3 serve.py            # 端口 8788
    python3 serve.py 9000       # 自定义端口

手机的 Chrome 打开 http://<本机局域网IP>:8788/ ，菜单里「添加到主屏幕」。
"""
import http.server, socketserver, socket, sys, os
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
ROOT = Path(__file__).resolve().parent / "public"

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80)); return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)
    def end_headers(self):
        # 开发期不缓存数据与脚本
        if self.path.endswith((".json", ".js", ".css", ".html")) or self.path == "/":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, fmt, *args):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), H) as httpd:
    print(f"  AMADEUS 服务已启动")
    print(f"  本机   http://127.0.0.1:{PORT}/")
    print(f"  手机   http://{lan_ip()}:{PORT}/")
    print(f"  根目录 {ROOT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
