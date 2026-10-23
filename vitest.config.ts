import { configDefaults, defineConfig } from 'vitest/config';
// .claude/worktrees holds parallel agent checkouts; their tests must not run as part of this tree.
export default defineConfig({resolve:{alias:{'@':new URL('./src',import.meta.url).pathname}},test:{environment:'jsdom',setupFiles:['./src/test/setup.ts'],exclude:[...configDefaults.exclude,'.claude/**']}});
