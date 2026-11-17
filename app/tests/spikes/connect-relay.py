#!/usr/bin/env python3
"""Relay CONNECT lokal untuk Playwright.

Chromium langsung ke proxy egress gagal (ERR_TUNNEL_CONNECTION_FAILED)
sementara CONNECT mentah dari Python/curl berhasil. Relay ini menerima
CONNECT dari Chromium, membuka CONNECT ke proxy egress dengan header
minimal, lalu menyambung kedua soket byte-per-byte. TLS tetap end-to-end
antara Chromium dan host tujuan; relay tidak membaca atau mengubah isi.
"""
import socket
import threading
import sys

LISTEN = ('127.0.0.1', 18081)
UPSTREAM = ('198.19.0.1', 3128)


def pump(src, dst, label):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    try:
        client.settimeout(30)
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = client.recv(4096)
            if not chunk:
                return
            buf += chunk
        line = buf.split(b'\r\n', 1)[0].decode('latin1')
        parts = line.split(' ')
        if len(parts) < 2 or parts[0] != 'CONNECT':
            client.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
            return
        target = parts[1]
        up = socket.create_connection(UPSTREAM, timeout=30)
        up.sendall(
            f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n'
            'Proxy-Connection: keep-alive\r\n\r\n'.encode('latin1')
        )
        resp = b''
        up.settimeout(30)
        while b'\r\n\r\n' not in resp:
            chunk = up.recv(4096)
            if not chunk:
                client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                return
            resp += chunk
        status = resp.split(b'\r\n', 1)[0].decode('latin1', 'replace')
        print(f'CONNECT {target} -> upstream {status}', flush=True)
        if ' 200 ' not in status:
            client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
            return
        client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        client.settimeout(None)
        up.settimeout(None)
        t1 = threading.Thread(target=pump, args=(client, up, 'c->u'), daemon=True)
        t2 = threading.Thread(target=pump, args=(up, client, 'u->c'), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except Exception as e:
        print('relay error:', e, flush=True)
    finally:
        try:
            client.close()
        except OSError:
            pass


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(LISTEN)
srv.listen(50)
print('relay CONNECT mendengarkan di 127.0.0.1:18081', flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
