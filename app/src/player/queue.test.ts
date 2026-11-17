import { describe, expect, it } from 'vitest';
import {
  addToQueue,
  clearExceptCurrent,
  createQueue,
  currentQueueIndex,
  currentTrack,
  decideNext,
  decidePrev,
  isShuffled,
  playNext,
  remainingDuration,
  removeFromQueue,
  setShuffle,
  type QueueState,
} from './queue';
import { MAX_QUEUE_ITEMS, localTrack, streamTrack, type Track } from './types';

function tracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) =>
    streamTrack(`vid${i}`, `Lagu ${i}`, 200 + i),
  );
}

/** RNG deterministik: selalu 0 (Fisher-Yates jadi rotasi terbalik). */
function zeroRandom(): number {
  return 0;
}

describe('createQueue', () => {
  it('membuat antrean identitas dengan posisi awal', () => {
    const q = createQueue(tracks(5), 2);
    expect(q.items).toHaveLength(5);
    expect(q.order).toEqual([0, 1, 2, 3, 4]);
    expect(q.orderPos).toBe(2);
    expect(currentTrack(q)?.title).toBe('Lagu 2');
  });

  it('memotong antrean ke 200 item', () => {
    const q = createQueue(tracks(250));
    expect(q.items).toHaveLength(MAX_QUEUE_ITEMS);
    expect(q.order).toHaveLength(MAX_QUEUE_ITEMS);
  });

  it('antrean kosong menghasilkan state kosong', () => {
    const q = createQueue([]);
    expect(q.orderPos).toBe(-1);
    expect(currentTrack(q)).toBeNull();
    expect(currentQueueIndex(q)).toBe(-1);
  });

  it('startIndex di luar batas dibatasi ke ujung', () => {
    expect(createQueue(tracks(3), 99).orderPos).toBe(2);
    expect(createQueue(tracks(3), -5).orderPos).toBe(0);
  });

  it('shuffle menaruh lagu awal pertama dan mengacak sisanya', () => {
    const q = createQueue(tracks(5), 2, true, zeroRandom);
    expect(q.order[0]).toBe(2);
    expect(q.orderPos).toBe(0);
    expect([...q.order].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(isShuffled(q)).toBe(true);
  });
});

describe('decideNext', () => {
  const q = createQueue(tracks(3), 1);

  it('maju satu posisi di tengah antrean', () => {
    expect(decideNext(q, 'off', false)).toEqual({
      action: 'advance',
      orderPos: 2,
    });
  });

  it('repeat one memutar ulang lagu yang sama saat habis', () => {
    expect(decideNext(q, 'one', false)).toEqual({ action: 'replay' });
  });

  it('repeat one tidak menahan next manual', () => {
    expect(decideNext(q, 'one', true)).toEqual({
      action: 'advance',
      orderPos: 2,
    });
  });

  it('di ujung antrean: off berhenti, all kembali ke awal', () => {
    const end = createQueue(tracks(3), 2);
    expect(decideNext(end, 'off', false)).toEqual({ action: 'stop' });
    expect(decideNext(end, 'all', false)).toEqual({
      action: 'advance',
      orderPos: 0,
    });
  });
});

describe('decidePrev', () => {
  it('posisi di atas 3 detik kembali ke awal lagu yang sama', () => {
    const q = createQueue(tracks(3), 1);
    expect(decidePrev(q, 3.01, 'off')).toEqual({ action: 'restart' });
    expect(decidePrev(q, 120, 'off')).toEqual({ action: 'restart' });
  });

  it('posisi 3 detik atau kurang pindah ke lagu sebelumnya', () => {
    const q = createQueue(tracks(3), 1);
    expect(decidePrev(q, 3, 'off')).toEqual({
      action: 'advance',
      orderPos: 0,
    });
    expect(decidePrev(q, 0, 'off')).toEqual({
      action: 'advance',
      orderPos: 0,
    });
  });

  it('di lagu pertama: off restart, all melompat ke lagu terakhir', () => {
    const q = createQueue(tracks(3), 0);
    expect(decidePrev(q, 0, 'off')).toEqual({ action: 'restart' });
    expect(decidePrev(q, 0, 'all')).toEqual({
      action: 'advance',
      orderPos: 2,
    });
  });
});

describe('setShuffle', () => {
  it('mematikan shuffle mengembalikan urutan asli', () => {
    const shuffled = createQueue(tracks(5), 1, true, zeroRandom);
    expect(isShuffled(shuffled)).toBe(true);
    const plain = setShuffle(shuffled, false);
    expect(plain.order).toEqual([0, 1, 2, 3, 4]);
    expect(plain.orderPos).toBe(1);
    expect(currentTrack(plain)?.title).toBe('Lagu 1');
  });

  it('menyalakan shuffle menaruh lagu saat ini pertama', () => {
    const q = createQueue(tracks(5), 3);
    const shuffled = setShuffle(q, true, zeroRandom);
    expect(shuffled.order[0]).toBe(3);
    expect(shuffled.orderPos).toBe(0);
    expect(currentTrack(shuffled)?.title).toBe('Lagu 3');
  });
});

describe('addToQueue dan playNext', () => {
  it('addToQueue menaruh di akhir dan membuang kelebihan 200', () => {
    const q = createQueue(tracks(199));
    const { queue, dropped } = addToQueue(q, tracks(5));
    expect(queue.items).toHaveLength(200);
    expect(dropped).toBe(4);
    expect(queue.order).toHaveLength(200);
  });

  it('playNext menyisip sesudah lagu yang sedang diputar', () => {
    const q = createQueue(tracks(3), 0);
    const extra = streamTrack('vidX', 'Lagu X', 180);
    const { queue, dropped } = playNext(q, [extra]);
    expect(dropped).toBe(0);
    expect(queue.items.map((t) => t.title)).toEqual([
      'Lagu 0',
      'Lagu X',
      'Lagu 1',
      'Lagu 2',
    ]);
    // Urutan putar: Lagu 0, Lagu X, Lagu 1, Lagu 2.
    expect(queue.order).toEqual([0, 1, 2, 3]);
    expect(queue.orderPos).toBe(0);
  });

  it('playNext saat shuffle aktif menyisip di urutan putar', () => {
    const q = createQueue(tracks(4), 0, true, zeroRandom);
    const before = q.order;
    const extra = streamTrack('vidX', 'Lagu X', 180);
    const { queue } = playNext(q, [extra]);
    expect(queue.order[0]).toBe(before[0]);
    expect(queue.order[1]).toBe(1); // indeks baru lagu X di items
    expect(currentTrack(queue)?.title).toBe('Lagu 0');
    expect(queue.items).toHaveLength(5);
  });

  it('playNext di antrean kosong membuat antrean baru', () => {
    const { queue } = playNext(
      { items: [], order: [], orderPos: -1 } satisfies QueueState,
      tracks(2),
    );
    expect(queue.items).toHaveLength(2);
    expect(queue.orderPos).toBe(0);
  });
});

describe('removeFromQueue', () => {
  it('menghapus lagu sesudah lagu saat ini tanpa menggeser posisi', () => {
    const q = createQueue(tracks(4), 1);
    const next = removeFromQueue(q, 3);
    expect(next.items.map((t) => t.title)).toEqual([
      'Lagu 0',
      'Lagu 1',
      'Lagu 2',
    ]);
    expect(next.orderPos).toBe(1);
    expect(currentTrack(next)?.title).toBe('Lagu 1');
  });

  it('menghapus lagu sebelum lagu saat ini menggeser posisi', () => {
    const q = createQueue(tracks(4), 2);
    const next = removeFromQueue(q, 0);
    expect(next.orderPos).toBe(1);
    expect(currentTrack(next)?.title).toBe('Lagu 2');
  });

  it('menghapus lagu saat ini pindah ke lagu berikut', () => {
    const q = createQueue(tracks(4), 1);
    const next = removeFromQueue(q, 1);
    expect(currentTrack(next)?.title).toBe('Lagu 2');
    expect(next.orderPos).toBe(1);
  });

  it('menghapus lagu terakhir yang sedang diputar mundur satu', () => {
    const q = createQueue(tracks(3), 2);
    const next = removeFromQueue(q, 2);
    expect(currentTrack(next)?.title).toBe('Lagu 1');
  });

  it('menghapus satu-satunya lagu mengosongkan antrean', () => {
    const q = createQueue(tracks(1), 0);
    const next = removeFromQueue(q, 0);
    expect(next.items).toHaveLength(0);
    expect(next.orderPos).toBe(-1);
  });

  it('indeks di luar batas tidak mengubah apa pun', () => {
    const q = createQueue(tracks(3), 1);
    expect(removeFromQueue(q, 99)).toBe(q);
    expect(removeFromQueue(q, -1)).toBe(q);
  });
});

describe('clearExceptCurrent', () => {
  it('menyisakan lagu yang sedang diputar', () => {
    const q = createQueue(tracks(5), 2);
    const next = clearExceptCurrent(q);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].title).toBe('Lagu 2');
    expect(next.orderPos).toBe(0);
  });
});

describe('remainingDuration', () => {
  it('menghitung sisa lagu saat ini ditambah lagu berikut', () => {
    const q = createQueue(
      [
        streamTrack('a', 'A', 200),
        streamTrack('b', 'B', 100),
        streamTrack('c', 'C', 50),
      ],
      0,
    );
    expect(remainingDuration(q, 50)).toEqual({ seconds: 300, unknown: 0 });
  });

  it('lagu tanpa durasi dihitung 0 dan dilaporkan', () => {
    const q = createQueue(
      [streamTrack('a', 'A', 200), localTrack('/nada.wav', 'Nada')],
      0,
    );
    expect(remainingDuration(q, 0)).toEqual({ seconds: 200, unknown: 1 });
  });
});
