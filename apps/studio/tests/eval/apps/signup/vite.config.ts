import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import saywright from '@saywright/vite';

export default defineConfig({ plugins: [saywright(), react()] });
