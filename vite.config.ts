import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// アプリ本体のビルド/開発サーバ設定。テスト設定は vitest.config.ts に分離。
export default defineConfig({
  plugins: [react()],
});
