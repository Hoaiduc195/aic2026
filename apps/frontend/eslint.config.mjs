import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: projectDirectory });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: ['.next/**', 'coverage/**', 'node_modules/**'],
  },
];

export default eslintConfig;
