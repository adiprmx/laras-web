/**
 * ErrorBoundary React: menangkap galat render di seluruh pohon app
 * dan menampilkan layar pemulihan, bukan layar hitam kosong.
 * Dibutuhkan karena satu lemparan di render (mis. tautan dengan
 * segmen URL rusak, Red 1 R2) meruntuhkan app tanpa batas ini.
 */
import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-dvh bg-black px-4 py-16 text-center text-zinc-100">
        <h1 className="text-xl font-bold tracking-tight">
          Terjadi kesalahan.
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
          Halaman ini tidak bisa ditampilkan. Coba muat ulang, atau
          kembali ke beranda.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black"
          >
            Muat ulang
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = '/';
            }}
            className="h-11 rounded-xl border border-white/10 px-4 text-sm font-medium"
          >
            Ke beranda
          </button>
        </div>
      </div>
    );
  }
}
