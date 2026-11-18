import { describe, expect, it } from 'vitest';
import { readCappedText, ResponseTooBigError } from './readCapped';

describe('readCappedText', () => {
  it('membaca body kecil sampai habis', async () => {
    const res = new Response('halo dunia', {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(readCappedText(res, 1024)).resolves.toBe('halo dunia');
  });

  it('menolak cepat bila Content-Length di atas cap tanpa membaca body', async () => {
    const res = new Response('x'.repeat(100), {
      headers: { 'Content-Length': '5000' },
    });
    await expect(readCappedText(res, 1024)).rejects.toBeInstanceOf(
      ResponseTooBigError,
    );
  });

  it('menolak body yang melewati cap saat streaming (tanpa Content-Length)', async () => {
    // Stream tanpa Content-Length: cap baru ketahuan saat chunk tiba.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(600)));
        controller.enqueue(new TextEncoder().encode('b'.repeat(600)));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readCappedText(res, 1024)).rejects.toBeInstanceOf(
      ResponseTooBigError,
    );
  });

  it('menerima body tepat di cap', async () => {
    const res = new Response('x'.repeat(1024));
    await expect(readCappedText(res, 1024)).resolves.toHaveLength(1024);
  });

  it('mengembalikan string kosong untuk body null', async () => {
    const res = new Response(null, { status: 204 });
    await expect(readCappedText(res, 1024)).resolves.toBe('');
  });

  it('mendekode UTF-8 multi-byte yang terpotong antar chunk', async () => {
    // 'é' = 2 byte; potong tepat di tengah karakter.
    const bytes = new TextEncoder().encode('aébc');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readCappedText(res, 1024)).resolves.toBe('aébc');
  });
});
