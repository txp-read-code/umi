import fs from 'fs';
import path from 'path';

const rootPath = path.join(__dirname, '../');

/**
 * 文件注释规范
 * READCODE-type:
 * READCODE-conclusion:
 * READCODE-
 * 目录注释规范
 * READCODE.md
 */

let allFile = 0;
let readFile = 0;

function getDirTree(beforePath: string, options?: { isRead: boolean }): object {
  const general = [
    // git文件
    '^\\.git$',
    '^\\.vscode$',
    // 测试文件
    '\\.test.ts$',
    // readcode自动生成的文件
    '^read-record$',
    // lock
    '^pnpm-lock\\.yaml$',
    // 许可证
    '^LICENSE$',
    // 文本文件
    '\\.md$',
    // 包文件
    '^node_modules$',
    // 打包的文件
    '^dist$',
    // .husky的无效文件
    '^\\_$',
  ];
  const umi = ['^compiled$', '^fixtures$', '^examples$', '^.turbo$'];
  const ignore = [...general, ...umi];
  const all = fs.readdirSync(beforePath);
  const isReadDir = options?.isRead || getIsRead(beforePath);

  const allList = all
    .filter(
      (item) => !ignore.find((ignoreItem) => new RegExp(ignoreItem).test(item)),
    )
    .map((item) => {
      const itemPath = path.join(beforePath, item);
      try {
        fs.lstatSync(itemPath).isDirectory();
        const dir = getDirTree(itemPath, { isRead: isReadDir });
        if (JSON.stringify(dir) !== '{}') {
          return [item, { dir, path: itemPath }];
        }
        return [item, { ignore: true }];
      } catch (error) {
        let isRead = false;
        allFile = allFile + 1;
        if (isReadDir) {
          isRead = true;
          readFile = readFile + 1;
        } else {
          if (getIsRead(itemPath)) {
            isRead = true;
            readFile = readFile + 1;
          }
        }
        return [item, { path: itemPath, isRead }];
      }
    })
    .filter((item) => !item[1]?.ignore);
  return Object.fromEntries(allList);
}
function getIsRead(paths: string) {
  const tagName = 'READCODE';
  try {
    fs.lstatSync(paths).isDirectory();
    const all = fs.readdirSync(paths);
    const isRead = !!all.includes(`${tagName}.md`);
    return isRead;
  } catch (error) {
    const str = fs.readFileSync(paths, { encoding: 'utf-8' });
    const start = [
      `# ${tagName}`,
      `// ${tagName}`,
      `<!-- ${tagName}`,
      `^{[\\s\\S]*"${tagName}"[\\s\\S]*}\n$`,
    ];
    let isRead = false;
    start.forEach((element) => {
      if (new RegExp(element).test(str)) {
        isRead = true;
      }
    });
    return isRead;
  }
}
const tree = getDirTree(rootPath);
function getMd(obj: object, arr: string[]) {
  let str = '';
  Object.entries(obj).map((item) => {
    if (item[1]?.dir) {
      const childStr = getMd(item[1]?.dir, [...arr, '  ']);
      const isRead = !childStr.includes('[ ]') ? '*' : ' ';
      str = str + `${arr.join('')}- [${isRead}] ${item[0]}\n`;
      str = str + childStr;
    } else {
      const isRead = item[1]?.isRead ? '*' : ' ';
      str = str + `${arr.join('')}- [${isRead}] ${item[0]}\n`;
    }
  });
  return str;
}
fs.writeFileSync(path.join(__dirname, 'tree.json'), JSON.stringify(tree));
const percent = ((readFile / allFile) * 100).toFixed(2);
const statisticalPanel = `\# Statistical\n\n\#\# Panel\n\nallFile: ${allFile}  readFile: ${readFile} percent: ${percent}%
`;
fs.writeFileSync(
  path.join(__dirname, 'statistical.md'),
  statisticalPanel + '\n## Detail\n\n' + getMd(tree, ['']),
);
