import { defineConfig } from '@epicenter/workspace';
import notes from './workspaces/notes/daemon.ts';

export default defineConfig({ daemon: { routes: { notes } } });
