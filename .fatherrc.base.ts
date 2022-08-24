// READCODE 这是father的基础配置，子包会继承这个配置
import { defineConfig } from 'father';

export default defineConfig({
  cjs: {
    output: 'dist',
  },
});
