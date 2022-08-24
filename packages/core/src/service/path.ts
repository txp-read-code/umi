import { winPath } from '@umijs/utils';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { Env } from '../types';

function winJoin(...args: string[]) {
  return winPath(join(...args));
}

// READCODE 获取路径方法: cwd、src、pages、apiroutes、tmp、node_modules、输出的绝对路径
export function getPaths(opts: { cwd: string; prefix: string; env: Env }) {
  const cwd = opts.cwd;
  const src = winJoin(cwd, 'src');
  const absSrcPath = existsSync(src) && statSync(src).isDirectory() ? src : cwd;
  const absPagesPath = winJoin(absSrcPath, 'pages');
  const absApiRoutesPath = winJoin(absSrcPath, 'api');
  const tmp =
    opts.env === Env.development
      ? `.${opts.prefix}`
      : `.${opts.prefix}-${opts.env}`;
  const absTmpPath = winJoin(absSrcPath, tmp);
  const absNodeModulesPath = winJoin(cwd, 'node_modules');
  const absOutputPath = winJoin(cwd, 'dist');
  return {
    cwd,
    absSrcPath,
    absPagesPath,
    absApiRoutesPath,
    absTmpPath,
    absNodeModulesPath,
    absOutputPath,
  };
}

export type Paths = ReturnType<typeof getPaths>;
